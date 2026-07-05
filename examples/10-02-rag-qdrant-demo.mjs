/**
 * 真实使用示例 -- 10-02 RAG + Qdrant 知识库检索
 *
 * 运行前需要启动 Qdrant，并在 examples/.env 中配置 EMBED_* 和 QDRANT_*。
 *
 * 运行：
 *   pnpm build
 *   node examples/10-02-rag-qdrant-demo.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

const { createRAGPipeline } = await import("../dist/index.js");

const namespace = "support_qdrant_rag_demo";
const collectionName = process.env.RAG_COLLECTION || "hello_agents_rag_vectors";

const docs = [
  {
    id: "customer-success-handbook",
    text: `
# 客户成功团队处理手册

## 数据同步问题

订单同步失败时，先查看同步任务日志，确认失败批次、失败时间段和接口返回码。
授权过期时，刷新店铺授权后重跑失败批次。
接口限流时，降低并发并分批补偿。
补偿完成后触发销售报表补算，确认看板数据恢复。

## 支付回调问题

支付到账但订单未付款时，先按支付流水号查询支付网关回调。
回调成功但状态未更新时，补发 payment_succeeded 事件。
回调缺失时，联系支付渠道补推通知。
`,
  },
  {
    id: "operations-runbook",
    text: `
# 运营故障 Runbook

库存预警通知缺失时，先确认商品是否开启库存预警，再检查短信、邮件、站内信渠道。
如果规则配置正确，查看库存事件消费延迟和消息队列堆积。
必要时重放库存变更事件，并记录受影响商品范围。
`,
  },
];

const incomingQuestion = "店铺授权过期导致昨晚订单同步失败，现在销售报表缺数，应该按什么顺序恢复？";

try {
  const pipeline = createRAGPipeline({
    backend: "qdrant",
    collectionName,
    ragNamespace: namespace,
    chunkSize: 140,
    chunkOverlap: 20,
  });

  await pipeline.clearNamespace(namespace);

  for (const doc of docs) {
    const indexed = await pipeline.addText(doc.text, {
      documentId: doc.id,
      namespace,
      metadata: {
        source_path: `runbook://${doc.id}`,
      },
    });
    console.log(`已写入 Qdrant: ${doc.id}, 分块=${indexed}`);
  }

  const results = await pipeline.searchAdvanced({
    query: incomingQuestion,
    topK: 4,
    namespace,
    enableMqe: true,
    enableHyde: true,
  });

  console.log("\n用户问题:", incomingQuestion);
  for (const [index, result] of results.entries()) {
    console.log(`\n${index + 1}. score=${result.score.toFixed(3)} source=${result.metadata.source_path}`);
    console.log(result.content);
  }

  console.log("\n统计:", JSON.stringify(await pipeline.getStats(), null, 2));
} catch (error) {
  console.error("RAG + Qdrant 示例运行失败。请确认 Qdrant、EMBED_* 和 QDRANT_* 配置可用。");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
