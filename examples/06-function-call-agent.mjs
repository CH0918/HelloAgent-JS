/**
 * 真实使用示例 -- FunctionCallAgent 原生函数调用
 *
 * FunctionCallAgent 会把工具定义转换为 OpenAI-compatible tools schema，
 * 让模型通过原生 tool_calls 决定何时调用工具，而不是要求模型输出自定义文本协议。
 *
 * 这个示例继续使用 B2B SaaS 报价场景：模型需要计算报价、判断折扣审批、
 * 生成付款计划，然后整理成可以给销售经理确认的报价方案。
 *
 * 注意：运行这个示例的模型服务需要支持 OpenAI-compatible chat completions 的 tools 参数。
 *
 * 前置步骤：
 *   cp examples/.env.example examples/.env
 *   然后编辑 examples/.env 填入你的真实 LLM 凭据
 *
 * 运行：
 *   pnpm build
 *   node examples/06-function-call-agent.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

import { Config, FunctionCallAgent, HelloAgentsLLM, Tool, ToolRegistry } from "../dist/index.js";

class QuoteCalculatorTool extends Tool {
  constructor() {
    super(
      "quote_calculator",
      "根据商品单价、数量和折扣率计算报价，返回小计、折扣金额和最终应付金额。",
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
        description: "折扣率，例如 18% 折扣写成 0.18",
        required: false,
        default: 0,
      },
    ];
  }
}

class DiscountApprovalTool extends Tool {
  constructor() {
    super(
      "discount_approval_checker",
      "根据折扣率和应付金额判断报价是否需要审批，并返回审批层级和建议动作。",
    );
  }

  run(parameters) {
    const discountRate = Number(parameters.discountRate);
    const payable = Number(parameters.payable);

    if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 1) {
      return "错误：discountRate 必须是 0 到 1 之间的数字";
    }
    if (!Number.isFinite(payable) || payable < 0) {
      return "错误：payable 必须是非负数字";
    }

    if (discountRate <= 0.1) {
      return JSON.stringify({
        approvalRequired: false,
        approvalLevel: "无需审批",
        reason: "折扣率不超过 10%，销售可直接确认。",
        nextAction: "可直接发送报价。",
      });
    }

    if (discountRate <= 0.2) {
      return JSON.stringify({
        approvalRequired: true,
        approvalLevel: "销售经理审批",
        reason: "折扣率超过 10% 且不超过 20%。",
        nextAction: "发送客户前需要销售经理确认。",
      });
    }

    return JSON.stringify({
      approvalRequired: true,
      approvalLevel: payable >= 5000 ? "销售总监审批" : "销售经理审批",
      reason: "折扣率超过 20%，属于高折扣报价。",
      nextAction: "发送客户前必须完成高折扣审批。",
    });
  }

  getParameters() {
    return [
      {
        name: "discountRate",
        type: "number",
        description: "折扣率，例如 18% 折扣写成 0.18",
        required: true,
      },
      {
        name: "payable",
        type: "number",
        description: "折扣后的最终应付金额",
        required: true,
      },
    ];
  }
}

class PaymentScheduleTool extends Tool {
  constructor() {
    super(
      "payment_schedule_builder",
      "根据应付金额、分期期数和首付款比例生成付款计划。",
    );
  }

  run(parameters) {
    const payable = Number(parameters.payable);
    const installments = Number(parameters.installments ?? 3);
    const upfrontRate = Number(parameters.upfrontRate ?? 0.4);

    if (!Number.isFinite(payable) || payable <= 0) {
      return "错误：payable 必须是正数";
    }
    if (!Number.isInteger(installments) || installments < 2 || installments > 6) {
      return "错误：installments 必须是 2 到 6 之间的整数";
    }
    if (!Number.isFinite(upfrontRate) || upfrontRate <= 0 || upfrontRate >= 1) {
      return "错误：upfrontRate 必须是 0 到 1 之间的数字";
    }

    const upfront = Number((payable * upfrontRate).toFixed(2));
    const remaining = payable - upfront;
    const laterAmount = Number((remaining / (installments - 1)).toFixed(2));
    const schedule = [
      {
        stage: "合同签署后",
        ratio: upfrontRate,
        amount: upfront,
      },
    ];

    for (let index = 2; index <= installments; index += 1) {
      const isLast = index === installments;
      const previousLaterTotal = laterAmount * (installments - 2);
      schedule.push({
        stage: `第 ${index} 期`,
        ratio: Number(((1 - upfrontRate) / (installments - 1)).toFixed(4)),
        amount: isLast ? Number((payable - upfront - previousLaterTotal).toFixed(2)) : laterAmount,
      });
    }

    return JSON.stringify({
      payable,
      installments,
      upfrontRate,
      schedule,
    });
  }

  getParameters() {
    return [
      {
        name: "payable",
        type: "number",
        description: "折扣后的最终应付金额",
        required: true,
      },
      {
        name: "installments",
        type: "integer",
        description: "分期期数",
        required: false,
        default: 3,
      },
      {
        name: "upfrontRate",
        type: "number",
        description: "首付款比例，例如 40% 写成 0.4",
        required: false,
        default: 0.4,
      },
    ];
  }
}

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

const registry = new ToolRegistry();
registry.registerTool(new QuoteCalculatorTool());
registry.registerTool(new DiscountApprovalTool());
registry.registerTool(new PaymentScheduleTool());

const agent = new FunctionCallAgent({
  name: "Function Call 报价助手",
  llm,
  config,
  toolRegistry: registry,
  maxToolIterations: 5,
  systemPrompt: [
    "你是一个严谨的中文商务报价助手。",
    "当用户请求报价、审批判断或付款计划时，必须使用可用工具完成计算和检查，不要心算。",
    "最终回复只呈现面向用户的业务内容，不要暴露工具名称、工具参数或内部消息协议。",
  ].join("\n"),
});

console.log(`tools    : ${agent.listTools().join(", ")}\n`);

function formatMoney(value) {
  return `${Number(value).toFixed(2)} 元`;
}

function readJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function printFunctionCallStep(event) {
  if (event.type === "assistant") {
    const preview = event.content.replace(/\s+/g, " ").trim().slice(0, 120);
    if (preview) {
      console.log(`  - 模型中间回复：${preview}`);
    }
    return;
  }

  if (event.type === "tool-call") {
    console.log(`  - 模型请求调用工具：${event.toolName}`);
    console.log(`    参数：${JSON.stringify(event.arguments)}`);
    return;
  }

  if (event.type === "tool-result") {
    const data = readJson(event.content);

    if (event.toolName === "quote_calculator" && data) {
      console.log(
        `    结果：小计 ${formatMoney(data.subtotal)}，折扣 ${formatMoney(data.discount)}，应付 ${formatMoney(data.payable)}。`,
      );
      return;
    }

    if (event.toolName === "discount_approval_checker" && data) {
      console.log(`    结果：${data.approvalLevel}。${data.nextAction}`);
      return;
    }

    if (event.toolName === "payment_schedule_builder" && data) {
      const scheduleText = data.schedule
        .map((item) => `${item.stage} ${formatMoney(item.amount)}`)
        .join("；");
      console.log(`    结果：${scheduleText}。`);
      return;
    }

    console.log(`    结果：${event.content}`);
    return;
  }

  if (event.type === "finish") {
    console.log("  - 最终回复已生成。");
  }
}

const task = [
  "客户要采购 8 套企业版授权，每套 1299 元，销售希望给 18% 折扣。",
  "客户想分 3 期付款，首付款 40%。",
  "请帮我形成一份可以发给销售经理确认的报价方案：",
  "先算小计、折扣和应付金额，再判断是否需要审批，最后给出付款计划。",
].join("\n");

console.log("========== FunctionCallAgent 原生函数调用 ==========\n");
console.log("用户：");
console.log(task);
console.log("\n执行进度：");

const answer = await agent.run(task, {
  maxToolIterations: 5,
  toolChoice: "auto",
  temperature: 0.2,
  onStep: printFunctionCallStep,
});

console.log("\n助手：");
console.log(answer);

console.log("\n可观测状态：");
console.log(`长期历史消息数：${agent.getHistory().length}`);
