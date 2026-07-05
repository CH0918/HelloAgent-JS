/**
 * 真实使用示例 —— ReActAgent + ToolRegistry
 *
 * ReActAgent 会在内部按 Thought -> Action -> Observation 的节奏逐步解决问题。
 * 这个示例使用多个本地业务工具，让模型先计算报价，再检查折扣审批规则，
 * 最后生成付款计划，并用 Finish 给出完整结论。
 *
 * 控制台只输出用户可见的业务进度，不直接暴露 Thought、工具参数或原始 Observation。
 * 文件底部会连续调用三次 agent.run()，模拟同一个聊天会话中的多轮对话。
 *
 * 前置步骤：
 *   cp examples/.env.example examples/.env
 *   然后编辑 examples/.env 填入你的真实 LLM 凭据
 *
 * 运行：
 *   pnpm build
 *   node examples/03-react-agent.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

import { Config, HelloAgentsLLM, Message, ReActAgent, Tool, ToolRegistry } from "../dist/index.js";

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
        description: "折扣率，例如 15% 折扣写成 0.15",
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
  temperature: 0.2,
  maxTokens: 4096*2,
  maxHistoryLength: 20,
});

const llm = new HelloAgentsLLM({
  provider: "local",
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

const agent = new ReActAgent({
  name: "ReAct报价助手",
  llm,
  config,
  toolRegistry: registry,
  maxSteps: 6,
  systemPrompt:
    [
      "你是一个严谨的中文商务报价助手。",
      "当用户请求报价、审批判断或付款计划时，你需要在内部静默使用可用工具完成计算和检查，不要心算。",
      // "工具调用、工具名称、工具参数、Thought、Action、Observation、执行历史都属于系统内部过程，绝不能出现在最终回复里。",
      "最终回复只能呈现面向用户的业务内容，例如报价明细、审批结论、付款安排、邮件正文或内部说明。",
      "如果用户要求基于上一轮继续改写，请直接基于上一轮最终业务结果改写，不要解释你上一轮调用过什么工具，也不要复述任何内部执行记录。",
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

function readToolNameFromAction(actionText) {
  return actionText.match(/^([a-zA-Z_][\w.-]*)\[/)?.[1];
}

function printPublicStep(event) {
  if (event.type === "thought") {
    return;
  }

  if (event.type === "action") {
    const toolName = readToolNameFromAction(event.content);

    if (toolName === "quote_calculator") {
      console.log("  - 正在计算报价金额...");
      return;
    }
    if (toolName === "discount_approval_checker") {
      console.log("  - 正在检查折扣审批要求...");
      return;
    }
    if (toolName === "payment_schedule_builder") {
      console.log("  - 正在生成付款计划...");
      return;
    }
    if (event.content.startsWith("Finish[")) {
      console.log("  - 正在整理最终回复...");
      return;
    }

    console.log("  - 正在处理当前请求...");
    return;
  }

  if (event.type === "observation") {
    const data = readJson(event.content);

    if (event.toolName === "quote_calculator" && data) {
      console.log(
        `  - 报价金额已计算：小计 ${formatMoney(data.subtotal)}，折扣 ${formatMoney(data.discount)}，应付 ${formatMoney(data.payable)}。`,
      );
      return;
    }

    if (event.toolName === "discount_approval_checker" && data) {
      console.log(`  - 审批要求已确认：${data.approvalLevel}。${data.nextAction}`);
      return;
    }

    if (event.toolName === "payment_schedule_builder" && data) {
      const scheduleText = data.schedule
        .map((item) => `${item.stage} ${formatMoney(item.amount)}`)
        .join("；");
      console.log(`  - 付款计划已生成：${scheduleText}。`);
      return;
    }

    console.log("  - 已完成一个处理步骤。");
    return;
  }

  if (event.type === "error") {
    console.log(`  - 处理遇到问题：${event.content}`);
    return;
  }

  if (event.type === "finish") {
    console.log("  - 本轮回复已生成。");
  }
}

function sanitizeAssistantAnswer(answer) {
  const finishMatch = answer.match(/Action:\s*Finish\[(.*)\]\s*$/s);
  if (finishMatch?.[1]) {
    return finishMatch[1].trim();
  }

  return answer
    .replace(/^Thought:[\s\S]*?\nAction:\s*Finish\[/, "")
    .replace(/\]\s*$/m, "")
    .replace(/\b(?:quote_calculator|discount_approval_checker|payment_schedule_builder)\b/g, "内部处理步骤")
    .trim();
}

function replaceLastAssistantAnswer(agentInstance, sanitizedAnswer) {
  const history = agentInstance.getHistory();
  const lastMessage = history.at(-1);

  if (!lastMessage || lastMessage.role !== "assistant" || lastMessage.content === sanitizedAnswer) {
    return;
  }

  agentInstance.clearHistory();
  for (const message of history.slice(0, -1)) {
    agentInstance.addMessage(message);
  }
  agentInstance.addMessage(new Message(sanitizedAnswer, "assistant"));
}

async function runConversationTurn(turnNumber, userInput) {
  console.log(`\n========== 第 ${turnNumber} 轮对话 ==========\n`);
  console.log("用户：\n", userInput, "\n");
  console.log("页面可见执行进度：");

  const answer = await agent.run(userInput, {
    maxSteps: 6,
    onStep: printPublicStep,
  });
  const publicAnswer = sanitizeAssistantAnswer(answer);
  replaceLastAssistantAnswer(agent, publicAnswer);

  console.log("\n助手：\n", publicAnswer, "\n");
  console.log(`当前长期历史消息数：${agent.getHistory().length}`);
}

await runConversationTurn(
  1,
  "客户要采购 8 套企业版授权，每套 1299 元，销售希望给 18% 折扣。客户想分 3 期付款，首付款 40%。请帮我形成一份可以发给销售经理确认的报价方案：先算小计、折扣和应付金额，再判断是否需要审批，最后给出付款计划。",
);

await runConversationTurn(
  2,
  "基于刚才的报价方案，帮我改写成一段内部审批说明，语气正式一点，重点说明为什么需要销售经理审批。",
);

await runConversationTurn(
  3,
  "再把刚才的内容改成可以发给客户的简短邮件。不要暴露内部审批规则，只说明报价金额、折扣优惠和付款安排。",
);
