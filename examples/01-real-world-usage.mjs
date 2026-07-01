/**
 * 真实使用示例 —— HelloAgent-JS 作为 SDK 被引入后的典型用法
 *
 * 假设场景：构建一个可对话的 CLI 助手
 *
 * 前置步骤：
 *   cp examples/.env.example examples/.env
 *   然后编辑 examples/.env 填入你的 LLM 凭据
 *
 * 运行：
 *   node examples/01-real-world-usage.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

import { HelloAgentsLLM, Message, Config } from "../dist/index.js";

// ────────────────────────────────────────────
// 1. SDK 配置 —— 一行初始化，自动检测 provider
// ────────────────────────────────────────────

const config = new Config({
  defaultProvider: "auto",        // 会根据环境变量自动识别 openai / deepseek / ollama / local …
  temperature: 0.7,
  maxTokens: 40960,
  maxHistoryLength: 50,           // 对话历史保留最近 50 条
});

// 显式指定 provider，避免 shell 环境变量干扰自动检测
const llm = new HelloAgentsLLM({
  provider: "local",
});

console.log(`🔌 provider : ${llm.provider}`);
console.log(`📍 baseUrl  : ${llm.baseUrl}`);
console.log(`🧠 model    : ${llm.model}\n`);

// ────────────────────────────────────────────
// 2. 用 Message 构建对话
// ────────────────────────────────────────────

const systemPrompt = new Message(
  "你是一个代码审查助手，用中文回答，风格简洁。",
  "system",
);

const history = [systemPrompt];

// ────────────────────────────────────────────
// 3. 非流式调用 —— invoke()
// ────────────────────────────────────────────

history.push(new Message("一行代码解释什么是闭包？", "user"));

const answer = await llm.invoke(history.map((m) => m.toDict()));
console.log("📨 invoke 结果：\n", answer, "\n---\n");

history.push(new Message(answer, "assistant"));

// ────────────────────────────────────────────
// 4. 流式调用 —— streamInvoke() / think()
// ────────────────────────────────────────────

history.push(new Message("用 TypeScript 写一个防抖函数。", "user"));

console.log("📨 流式输出：\n");

const stream = llm.streamInvoke(history.map((m) => m.toDict()));

let fullResponse = "";
for await (const chunk of stream) {
  process.stdout.write(chunk);      // 逐 token 输出，像打字机效果
  fullResponse += chunk;
}
console.log("\n\n---\n");

history.push(new Message(fullResponse, "assistant"));

// ────────────────────────────────────────────
// 5. 对话历史管理 —— 限制长度
// ────────────────────────────────────────────

while (history.length > config.maxHistoryLength) {
  // 保留 system prompt，从第 1 条后开始裁剪
  history.splice(1, 1);
}

console.log(`📋 对话历史条数：${history.length}`);
console.log(`📋 最后一条消息预览：${history.at(-1)?.content.slice(0, 80)}...\n`);

// ────────────────────────────────────────────
// 6. 错误处理
// ────────────────────────────────────────────

import { HelloAgentsException } from "../dist/index.js";

try {
  new HelloAgentsLLM({
    provider: "custom",
    // 故意不给 baseUrl 和 apiKey —— 会抛异常
  });
} catch (err) {
  if (err instanceof HelloAgentsException) {
    console.log("✅ 异常被正确捕获：", err.message);
  }
}
