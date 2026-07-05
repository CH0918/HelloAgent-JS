/**
 * 真实使用示例 -- 09-02 Embedding + Qdrant 业务知识检索
 *
 * 场景：把一组客服知识库条目转成 embedding 写入 Qdrant，然后用用户工单问题召回最相关的处理方案。
 *
 * 运行：
 *   pnpm build
 *   node examples/09-02-qdrant-business-demo.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

import { createEmbeddingModel, QdrantVectorStore } from "../dist/index.js";

const namespace = "support_playbook";
const dataSource = "09-02-qdrant-business-demo";

const playbookArticles = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    title: "订单同步失败导致销售报表缺数",
    category: "order_sync",
    priority: "high",
    answer:
      "先查看订单同步任务日志，确认失败时间段和失败批次。如果是三方接口限流，降低并发后只重跑失败批次；如果是授权过期，刷新店铺授权后重跑。重跑完成后触发销售报表补算任务。",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    title: "支付到账但订单仍显示未付款",
    category: "payment",
    priority: "medium",
    answer:
      "先按支付流水号查询支付网关回调记录。如果回调成功但订单状态未更新，检查订单状态机日志并补发 payment_succeeded 事件；如果回调缺失，联系支付渠道补推通知。",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    title: "客户要求修改企业发票抬头",
    category: "billing",
    priority: "low",
    answer:
      "引导客户在账单设置中提交新的发票抬头、税号和营业执照。资料提交后进入财务审核，审核通过前不要手动修改已开票记录。",
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    title: "库存预警通知没有发送",
    category: "inventory",
    priority: "medium",
    answer:
      "先确认商品是否开启库存预警，并检查通知渠道配置。若规则配置正确，查看库存事件消费延迟和消息队列堆积情况，必要时重放库存变更事件。",
  },
];

const incomingTicket = {
  id: "ticket_20260705_001",
  customer: "杭州星河零售",
  text: "今天早上销售看板少了昨晚 11 点之后的订单数据，后台显示有一批订单同步失败。我们已经刷新授权了，现在应该怎么恢复报表？",
};

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readIntegerEnv(name, fallback) {
  const raw = readEnv(name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultEmbeddingDimension(modelType) {
  const normalized = modelType?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "dashscope") {
    return 1024;
  }
  if (
    normalized === "openai" ||
    normalized === "openai_compatible" ||
    normalized === "openai_compat" ||
    normalized === "openrouter" ||
    normalized === "remote"
  ) {
    return 1536;
  }
  return 384;
}

function normalizeVectorList(result) {
  if (Array.isArray(result[0])) {
    return result;
  }
  return [result];
}

function articleToEmbeddingText(article) {
  return [`标题：${article.title}`, `分类：${article.category}`, `优先级：${article.priority}`, `处理方案：${article.answer}`].join("\n");
}

function ticketToEmbeddingText(ticket) {
  return [`客户：${ticket.customer}`, `问题：${ticket.text}`].join("\n");
}

const modelType = readEnv("EMBED_MODEL_TYPE") ?? "tfidf";
const dimension = readIntegerEnv("EMBED_DIMENSION", defaultEmbeddingDimension(modelType));

const embedder = createEmbeddingModel(modelType, {
  modelName: readEnv("EMBED_MODEL_NAME"),
  apiKey: readEnv("EMBED_API_KEY"),
  baseUrl: readEnv("EMBED_BASE_URL"),
  dimension,
});

const vectorStore = new QdrantVectorStore({
  url: readEnv("QDRANT_URL"),
  apiKey: readEnv("QDRANT_API_KEY"),
  collectionName: readEnv("QDRANT_COLLECTION") ?? "hello_agents_support_playbook",
  vectorSize: readIntegerEnv("QDRANT_VECTOR_SIZE", dimension),
  distance: readEnv("QDRANT_DISTANCE"),
});

try {
  const qdrantReady = await vectorStore.healthCheck();
  if (!qdrantReady) {
    throw new Error("无法连接 Qdrant。请检查 QDRANT_URL / QDRANT_API_KEY，或确认本地 Qdrant 已启动。");
  }

  const articleTexts = playbookArticles.map(articleToEmbeddingText);
  const articleVectors = normalizeVectorList(await embedder.encode(articleTexts));

  const wrongDimension = articleVectors.find((vector) => vector.length !== vectorStore.vectorSize);
  if (wrongDimension) {
    throw new Error(
      `Embedding 输出维度是 ${wrongDimension.length}，但 Qdrant collection 配置维度是 ${vectorStore.vectorSize}。请让 EMBED_DIMENSION 和 QDRANT_VECTOR_SIZE 保持一致。`,
    );
  }

  const indexed = await vectorStore.addVectors({
    ids: playbookArticles.map((article) => article.id),
    vectors: articleVectors,
    metadata: playbookArticles.map((article) => ({
      namespace,
      data_source: dataSource,
      article_id: article.id,
      title: article.title,
      category: article.category,
      priority: article.priority,
      content: article.answer,
    })),
  });

  if (!indexed) {
    throw new Error("没有任何知识库向量写入 Qdrant，请检查向量维度配置。");
  }

  const queryVector = normalizeVectorList(await embedder.encode(ticketToEmbeddingText(incomingTicket)))[0] ?? [];
  if (queryVector.length !== vectorStore.vectorSize) {
    throw new Error(
      `查询向量维度是 ${queryVector.length}，但 Qdrant collection 配置维度是 ${vectorStore.vectorSize}。请检查 QDRANT_VECTOR_SIZE。`,
    );
  }

  const hits = await vectorStore.searchSimilar({
    queryVector,
    limit: 3,
    where: {
      namespace,
      data_source: dataSource,
    },
  });

  console.log("== 09-02 Embedding + Qdrant 业务知识检索 ==");
  console.log("Qdrant collection:", vectorStore.collectionName);
  console.log("向量维度:", vectorStore.vectorSize);
  console.log("\n用户工单:");
  console.log(`${incomingTicket.customer}: ${incomingTicket.text}`);

  console.log("\n召回结果:");
  for (const [index, hit] of hits.entries()) {
    console.log(`${index + 1}. [score=${hit.score.toFixed(4)}] ${hit.metadata.title}`);
    console.log(`   分类: ${hit.metadata.category} / 优先级: ${hit.metadata.priority}`);
    console.log(`   处理方案: ${hit.metadata.content}`);
  }

  const bestHit = hits[0];
  if (bestHit) {
    console.log("\n建议回复:");
    console.log(
      `针对 ${incomingTicket.customer} 的问题，优先按《${bestHit.metadata.title}》处理：${bestHit.metadata.content}`,
    );
  } else {
    console.log("\n没有召回到匹配知识，请检查 collection 中是否已有数据，或降低过滤条件后再试。");
  }
} catch (error) {
  console.error("09-02 Qdrant 业务检索示例运行失败。");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
