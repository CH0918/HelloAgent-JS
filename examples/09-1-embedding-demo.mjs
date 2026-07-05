/**
 * 真实使用示例 -- 09-1 最小业务语义匹配
 *
 * 场景：用户输入一个问题，系统用 embedding 从 3 条客服 FAQ 中找出最匹配的答案。
 *
 * 运行：
 *   pnpm build
 *   node examples/09-1-embedding-demo.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

import { createEmbeddingModel } from "../dist/index.js";

const userQuestion = "今天凌晨订单同步失败了，销售报表没有昨天的数据，应该怎么处理？";

const faqs = [
  {
    question: "订单同步失败怎么办？",
    answer: "先检查同步任务错误日志。如果是限流，降低并发后重试；如果是 token 过期，刷新授权后重跑失败批次。",
  },
  {
    question: "如何修改发票抬头？",
    answer: "请在账单设置里提交新的发票抬头和营业执照，财务会在 3 个工作日内审核。",
  },
  {
    question: "忘记管理员密码怎么办？",
    answer: "在登录页点击忘记密码。如果收不到邮件，请联系支持团队手动发送重置链接。",
  },
];

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const size = Math.min(left.length, right.length);

  for (let index = 0; index < size; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  return leftNorm > 0 && rightNorm > 0 ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

const embedder = createEmbeddingModel(readEnv("EMBED_MODEL_TYPE") ?? "openrouter", {
  modelName: readEnv("EMBED_MODEL_NAME"),
  apiKey: readEnv("EMBED_API_KEY"),
  baseUrl: readEnv("EMBED_BASE_URL"),
  dimension: Number(readEnv("EMBED_DIMENSION") ?? 1536),
});

try {
  const faqTexts = faqs.map((faq) => `${faq.question}\n${faq.answer}`);
  const vectors = await embedder.encode([userQuestion, ...faqTexts]);
  const vectorList = Array.isArray(vectors[0]) ? vectors : [vectors];
  const questionVector = vectorList[0] ?? [];

  const bestMatch = faqs
    .map((faq, index) => ({
      ...faq,
      score: cosineSimilarity(questionVector, vectorList[index + 1] ?? []),
    }))
    .sort((left, right) => right.score - left.score)[0];

  console.log("用户问题:");
  console.log(userQuestion);
  console.log("\n匹配到的 FAQ:");
  console.log(bestMatch.question);
  console.log("\n推荐回答:");
  console.log(bestMatch.answer);
  console.log("\n相似度:", bestMatch.score.toFixed(4));
} catch (error) {
  console.error("FAQ 语义匹配失败。请检查 EMBED_* 配置和网络连接。");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
