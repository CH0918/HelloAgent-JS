/**
 * 真实使用示例 -- 10 RAG 知识库检索
 *
 * 默认使用 memory 后端和 TF-IDF embedding，不需要 Qdrant 或真实 LLM。
 *
 * 运行：
 *   pnpm build
 *   node examples/10-rag-system.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

process.env.EMBED_MODEL_TYPE = process.env.EMBED_MODEL_TYPE || "tfidf";
process.env.EMBED_DIMENSION = process.env.EMBED_DIMENSION || "384";

const { RAGTool, createRAGPipeline } = await import("../dist/index.js");

const namespace = "support_rag_demo";
const supportDocs = [
  {
    id: "order-sync-playbook",
    text: `
# 订单同步失败导致销售报表缺数

当订单同步任务失败时，先查看同步任务日志，确认失败时间段、失败批次和三方接口返回码。
如果失败原因是接口限流，需要降低并发后只重跑失败批次。
如果失败原因是店铺授权过期，需要刷新授权，再重跑订单同步任务。
同步完成后，要触发销售报表补算任务，确认看板数据已经恢复。
`,
  },
  {
    id: "payment-callback-playbook",
    text: `
# 支付到账但订单未付款

先按支付流水号查询支付网关回调记录。
如果回调成功但订单状态未更新，检查订单状态机日志，并补发 payment_succeeded 事件。
如果回调缺失，需要联系支付渠道补推通知。
`,
  },
  {
    id: "inventory-warning-playbook",
    text: `
# 库存预警通知没有发送

先确认商品是否开启库存预警，并检查通知渠道配置。
如果规则配置正确，再查看库存事件消费延迟和消息队列堆积情况。
必要时重放库存变更事件。
`,
  },
];

async function runPipelineDemo() {
  console.log("== RAGPipeline memory 后端 ==");
  const pipeline = createRAGPipeline({
    backend: "memory",
    ragNamespace: namespace,
    chunkSize: 120,
    chunkOverlap: 20,
  });

  for (const doc of supportDocs) {
    const count = await pipeline.addText(doc.text, {
      documentId: doc.id,
      namespace,
      metadata: {
        source_path: `support://${doc.id}`,
      },
    });
    console.log(`已索引 ${doc.id}: ${count} 个分块`);
  }

  const question = "订单同步失败后，销售报表缺数应该如何恢复？";
  const results = await pipeline.search({
    query: question,
    topK: 3,
    namespace,
  });

  console.log("\n用户问题:", question);
  for (const [index, result] of results.entries()) {
    console.log(`\n${index + 1}. score=${result.score.toFixed(3)} source=${result.metadata.source_path}`);
    console.log(result.content);
  }

  const stats = await pipeline.getStats();
  console.log("\n统计:", JSON.stringify(stats, null, 2));
}

async function runToolDemo() {
  console.log("\n== RAGTool 工具形态 ==");
  const ragTool = new RAGTool({
    backend: "memory",
    ragNamespace: "tool_support_demo",
  });

  for (const doc of supportDocs) {
    console.log(
      await ragTool.run({
        action: "add_text",
        document_id: doc.id,
        namespace: "tool_support_demo",
        text: doc.text,
        chunk_size: 120,
        chunk_overlap: 20,
      }),
    );
  }

  const searchResult = await ragTool.run({
    action: "search",
    namespace: "tool_support_demo",
    query: "授权过期导致订单同步失败怎么办",
    limit: 2,
    min_score: 0,
    enable_advanced_search: false,
    max_chars: 900,
  });
  console.log("\n工具搜索结果:\n" + searchResult);
}

await runPipelineDemo();
await runToolDemo();
