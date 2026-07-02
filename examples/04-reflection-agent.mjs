/**
 * 真实使用示例 -- ReflectionAgent 自我反思与迭代优化
 *
 * ReflectionAgent 会先生成初稿，再让模型审查当前答案，最后根据反馈继续优化。
 * 这个示例包含两个场景：
 *   1. 默认提示词：解释一个通用技术概念。
 *   2. 自定义提示词：模拟代码生成 + 代码评审 + 代码优化。
 *
 * 前置步骤：
 *   cp examples/.env.example examples/.env
 *   然后编辑 examples/.env 填入你的真实 LLM 凭据
 *
 * 运行：
 *   pnpm build
 *   node examples/04-reflection-agent.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

import { Config, HelloAgentsLLM, ReflectionAgent } from "../dist/index.js";

const config = new Config({
  temperature: Number(process.env.TEMPERATURE ?? 0.2),
  maxTokens: Number(process.env.MAX_TOKENS ?? 4096),
  maxHistoryLength: 20,
});

const llm = new HelloAgentsLLM({
  provider: process.env.LLM_PROVIDER ?? "local",
  temperature: config.temperature,
  maxTokens: config.maxTokens,
});

console.log(`provider : ${llm.provider}`);
console.log(`baseUrl  : ${llm.baseUrl}`);
console.log(`model    : ${llm.model}\n`);

function preview(content, maxLength = 180) {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}

function printReflectionStep(event) {
  if (event.type === "initial") {
    console.log("  - 已生成初始回答。");
    console.log(`    ${preview(event.content)}`);
    return;
  }

  if (event.type === "reflection") {
    console.log(`  - 第 ${event.iteration} 轮反思反馈：`);
    console.log(`    ${preview(event.content)}`);
    return;
  }

  if (event.type === "refine") {
    console.log(`  - 第 ${event.iteration} 轮优化完成。`);
    console.log(`    ${preview(event.content)}`);
    return;
  }

  if (event.type === "finish") {
    console.log("  - 最终结果已写入 Agent 历史。");
  }
}

const generalAgent = new ReflectionAgent({
  name: "通用反思助手",
  llm,
  config,
  maxIterations: 1,
});

console.log("========== 默认提示词：通用解释任务 ==========\n");
const generalTask = "解释什么是递归算法，并给出一个适合初学者理解的 TypeScript 例子。";
console.log("任务：");
console.log(generalTask);
console.log("\n反思进度：");

const generalAnswer = await generalAgent.run(generalTask, {
  onStep: printReflectionStep,
});

console.log("\n最终回答：");
console.log(generalAnswer);
console.log(`\n长期历史消息数：${generalAgent.getHistory().length}`);
console.log(`短期记忆记录数：${generalAgent.getMemoryRecords().length}\n`);

const codePrompts = {
  initial: `
你是一位资深 TypeScript 程序员。请根据以下要求编写代码：

要求: {task}

请提供完整的 TypeScript 实现，包含必要的类型定义和简洁说明。
`,
  reflect: `
你是一位严格的代码评审专家。请审查以下代码：

# 原始任务:
{task}

# 待审查的代码:
{content}

请分析代码质量，包括类型安全、边界处理、可读性和运行复杂度。
如果代码质量良好，请回答"无需改进"。否则请提出具体的改进建议。
`,
  refine: `
请根据代码评审意见优化你的代码：

# 原始任务:
{task}

# 上一轮代码:
{last_attempt}

# 评审意见:
{feedback}

请提供优化后的 TypeScript 代码，并简要说明关键改动。
`,
};

const codeAgent = new ReflectionAgent({
  name: "代码反思助手",
  llm,
  config,
  customPrompts: codePrompts,
  maxIterations: 1,
});

console.log("========== 自定义提示词：代码生成与评审 ==========\n");
const codeTask = "实现一个 groupBy 函数，接收数组和 key selector，把数组元素按 key 分组。";
console.log("任务：");
console.log(codeTask);
console.log("\n反思进度：");

const codeAnswer = await codeAgent.run(codeTask, {
  onStep: printReflectionStep,
});

console.log("\n最终回答：");
console.log(codeAnswer);
console.log(`\n长期历史消息数：${codeAgent.getHistory().length}`);
console.log(`短期记忆记录数：${codeAgent.getMemoryRecords().length}`);
