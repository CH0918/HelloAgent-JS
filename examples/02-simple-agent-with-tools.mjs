/**
 * 真实使用示例 —— SimpleAgent + ToolRegistry
 *
 * 假设场景：构建一个报价助手。
 * 用户给出商品单价、数量和折扣，Agent 需要调用报价工具计算金额，
 * 然后用自然语言给出最终回复。
 *
 * 前置步骤：
 *   cp examples/.env.example examples/.env
 *   然后编辑 examples/.env 填入你的真实 LLM 凭据
 *
 * 运行：
 *   pnpm build
 *   node examples/02-simple-agent-with-tools.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

import { Config, HelloAgentsLLM, SimpleAgent, Tool, ToolRegistry } from "../dist/index.js";

// ────────────────────────────────────────────
// 1. 定义一个业务工具 —— 报价计算器
// ────────────────────────────────────────────

class QuoteCalculatorTool extends Tool {
  constructor() {
    super(
      "quote_calculator",
      "根据单价、数量和折扣率计算报价。适合生成订单金额、折扣金额和应付金额。",
    );
  }

  run(parameters) {
    const unitPrice = Number(parameters.unitPrice);
    const quantity = Number(parameters.quantity);
    const discountRate = Number(parameters.discountRate ?? 0);

    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return "错误：unitPrice 必须是非负数字";
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return "错误：quantity 必须是正整数";
    }
    if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 1) {
      return "错误：discountRate 必须是 0 到 1 之间的数字";
    }

    const subtotal = unitPrice * quantity;
    const discount = subtotal * discountRate;
    const payable = subtotal - discount;

    return JSON.stringify({
      unitPrice,
      quantity,
      discountRate,
      subtotal: Number(subtotal.toFixed(2)),
      discount: Number(discount.toFixed(2)),
      payable: Number(payable.toFixed(2)),
    });
  }

  getParameters() {
    return [
      {
        name: "unitPrice",
        type: "number",
        description: "商品单价",
        required: true,
      },
      {
        name: "quantity",
        type: "integer",
        description: "购买数量",
        required: true,
      },
      {
        name: "discountRate",
        type: "number",
        description: "折扣率，例如 85 折写成 0.15",
        required: false,
        default: 0,
      },
    ];
  }
}

// ────────────────────────────────────────────
// 2. 初始化 SDK 配置和真实 LLM
// ────────────────────────────────────────────

const config = new Config({
  temperature: 0.2,
  maxTokens: 4096,
  maxHistoryLength: 20,
});

const llm = new HelloAgentsLLM({
  provider: 'local',
  temperature: config.temperature,
  maxTokens: config.maxTokens,
});

console.log(`🔌 provider : ${llm.provider}`);
console.log(`📍 baseUrl  : ${llm.baseUrl}`);
console.log(`🧠 model    : ${llm.model}\n`);

// ────────────────────────────────────────────
// 3. 注册工具并创建 SimpleAgent
// ────────────────────────────────────────────

const registry = new ToolRegistry();
registry.registerTool(new QuoteCalculatorTool());

const agent = new SimpleAgent({
  name: "报价助手",
  llm,
  config,
  toolRegistry: registry,
  systemPrompt:
    "你是一个严谨的中文报价助手。遇到金额、折扣、总价、应付金额计算时，必须先调用 quote_calculator 工具，不要心算。拿到工具结果后，用简洁中文解释小计、折扣和最终应付金额。",
});

console.log(`🧰 tools    : ${agent.listTools().join(", ")}\n`);

// ────────────────────────────────────────────
// 4. 发起一次真实 Agent 调用
// ────────────────────────────────────────────

const userInput =
  "客户要买 3 套团队版授权，每套 199 元，现在给 15% 折扣。请帮我算出小计、折扣金额和最终应付金额。请先调用 quote_calculator 工具。";

console.log("👤 用户输入：\n", userInput, "\n");

const answer = await agent.run(userInput, {
  maxToolIterations: 3,
});

console.log("🤖 Agent 回复：\n", answer, "\n");
console.log(`📋 历史消息数：${agent.getHistory().length}`);

// ────────────────────────────────────────────
// 5. 流式输出 —— 基于已有历史继续回复
// ────────────────────────────────────────────

const streamInput =
  "请基于刚才的报价结果，用 200 字左右写一段可以发给客户的报价说明，语气专业、清楚，说明原价、折扣和最终应付金额。";

console.log("\n👤 流式输入：\n", streamInput, "\n");
console.log("🤖 Agent 流式回复：\n");

let streamedAnswer = "";
for await (const chunk of agent.streamRun(streamInput, {
  temperature: 0.4,
})) {
  process.stdout.write(chunk);
  streamedAnswer += chunk;
}

console.log("\n\n---\n");
console.log(`📋 流式回复字数：${streamedAnswer.length}`);
console.log(`📋 当前历史消息数：${agent.getHistory().length}`);
