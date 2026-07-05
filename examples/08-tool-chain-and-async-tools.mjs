/**
 * 真实使用示例 -- 工具链 + 异步工具执行
 *
 * 这一章演示两个高级工具能力：
 *
 * 1. ToolChain：把多个工具按固定顺序串起来，让后续步骤引用前面步骤的输出。
 * 2. AsyncToolExecutor：用 Promise 并发执行多个工具任务，适合批量查询和互不依赖的外部请求。
 *
 * 默认运行不需要真实 LLM，也不需要外部 API Key。示例里的 CRM、用量和风险评估工具
 * 使用 setTimeout 模拟数据库或 HTTP 服务延迟，因此可以稳定验证异步执行。
 *
 * 如果你希望让 FunctionCallAgent 调用注册后的工具链，可以在 examples/.env 中设置：
 *
 *   RUN_LLM_TOOL_CHAIN_DEMO=1
 *
 * 运行：
 *   pnpm build
 *   node examples/08-tool-chain-and-async-tools.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

import {
  AsyncToolExecutor,
  Config,
  FunctionCallAgent,
  HelloAgentsLLM,
  Tool,
  ToolChain,
  ToolChainManager,
  ToolRegistry,
} from "../dist/index.js";

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

class CustomerProfileTool extends Tool {
  constructor() {
    super(
      "customer_profile",
      "根据客户编号查询客户画像，包括公司名称、套餐、席位数、区域和健康分。",
    );
  }

  async run(parameters) {
    await delay(120);
    const customerId = String(parameters.customerId ?? parameters.input ?? "").trim();
    const data = {
      "C-2048": {
        customerId: "C-2048",
        companyName: "北辰制造",
        plan: "Enterprise",
        seats: 86,
        region: "华东",
        healthScore: 74,
      },
      "C-1031": {
        customerId: "C-1031",
        companyName: "云杉零售",
        plan: "Business",
        seats: 34,
        region: "华南",
        healthScore: 91,
      },
      "C-4096": {
        customerId: "C-4096",
        companyName: "远航物流",
        plan: "Enterprise",
        seats: 128,
        region: "华北",
        healthScore: 62,
      },
    };

    return JSON.stringify(data[customerId] ?? {
      customerId,
      companyName: "未知客户",
      plan: "Unknown",
      seats: 0,
      region: "未知",
      healthScore: 0,
    }, null, 2);
  }

  getParameters() {
    return [
      {
        name: "customerId",
        type: "string",
        description: "客户编号，例如 C-2048",
        required: true,
      },
    ];
  }
}

class UsageSummaryTool extends Tool {
  constructor() {
    super(
      "usage_summary",
      "根据客户编号查询最近30天产品用量，包括活跃席位、API调用量、工单数和扩容风险。",
    );
  }

  async run(parameters) {
    await delay(160);
    const customerId = String(parameters.customerId ?? parameters.input ?? "").trim();
    const data = {
      "C-2048": {
        customerId: "C-2048",
        activeSeats: 71,
        monthlyApiCalls: 183000,
        supportTickets: 7,
        expansionSignal: "中",
      },
      "C-1031": {
        customerId: "C-1031",
        activeSeats: 31,
        monthlyApiCalls: 42000,
        supportTickets: 1,
        expansionSignal: "高",
      },
      "C-4096": {
        customerId: "C-4096",
        activeSeats: 77,
        monthlyApiCalls: 241000,
        supportTickets: 16,
        expansionSignal: "低",
      },
    };

    return JSON.stringify(data[customerId] ?? {
      customerId,
      activeSeats: 0,
      monthlyApiCalls: 0,
      supportTickets: 0,
      expansionSignal: "未知",
    }, null, 2);
  }

  getParameters() {
    return [
      {
        name: "customerId",
        type: "string",
        description: "客户编号，例如 C-2048",
        required: true,
      },
    ];
  }
}

class RenewalRiskAnalyzerTool extends Tool {
  constructor() {
    super(
      "renewal_risk_analyzer",
      "结合客户画像和产品用量，生成续约风险等级、判断理由和下一步客户成功动作。",
    );
  }

  async run(parameters) {
    await delay(80);
    const profile = typeof parameters.profile === "string" ? readJson(parameters.profile) : parameters.profile;
    const usage = typeof parameters.usage === "string" ? readJson(parameters.usage) : parameters.usage;

    if (!profile || !usage) {
      return "错误：profile 和 usage 必须是可解析的对象";
    }

    const healthScore = Number(profile.healthScore ?? 0);
    const supportTickets = Number(usage.supportTickets ?? 0);
    const seatUsageRate = Number(usage.activeSeats ?? 0) / Math.max(Number(profile.seats ?? 1), 1);
    const riskLevel = healthScore < 70 || supportTickets >= 10 ? "高" : seatUsageRate < 0.7 ? "中" : "低";
    const action =
      riskLevel === "高"
        ? "安排客户成功经理在48小时内回访，先处理工单和低活跃问题。"
        : riskLevel === "中"
          ? "准备价值复盘材料，重点解释活跃席位和扩容场景。"
          : "推进续约报价，并讨论是否增加席位或升级服务包。";

    return JSON.stringify(
      {
        customerId: profile.customerId,
        companyName: profile.companyName,
        riskLevel,
        reasons: [
          `健康分 ${healthScore}`,
          `席位活跃率 ${(seatUsageRate * 100).toFixed(1)}%`,
          `近30天工单数 ${supportTickets}`,
          `扩容信号：${usage.expansionSignal}`,
        ],
        nextAction: action,
      },
      null,
      2,
    );
  }

  getParameters() {
    return [
      {
        name: "profile",
        type: "object",
        description: "客户画像 JSON 对象",
        required: true,
      },
      {
        name: "usage",
        type: "object",
        description: "客户用量 JSON 对象",
        required: true,
      },
    ];
  }
}

const registry = new ToolRegistry();
registry.registerTool(new CustomerProfileTool());
registry.registerTool(new UsageSummaryTool());
registry.registerTool(new RenewalRiskAnalyzerTool());

const chain = new ToolChain(
  "renewal_brief_builder",
  "按客户编号依次查询客户画像、产品用量，并生成续约风险简报。",
)
  .addStep("customer_profile", "customerId={input}", "profile")
  .addStep("usage_summary", "customerId={input}", "usage")
  .addStep(
    "renewal_risk_analyzer",
    '{"profile": {profile}, "usage": {usage}}',
    "renewal_brief",
  );

const chainManager = new ToolChainManager(registry);
chainManager.registerChain(chain);
chainManager.registerChainAsTool("renewal_brief_builder", {
  inputParameterName: "customerId",
  inputParameterDescription: "需要生成续约简报的客户编号，例如 C-2048",
});

console.log("========== ToolChain 顺序工具链 ==========\n");
const chainResult = await chainManager.executeChain("renewal_brief_builder", "C-2048");

for (const step of chainResult.steps) {
  console.log(`步骤 ${step.index}: ${step.toolName}`);
  console.log(`输入: ${step.input}`);
  console.log(`输出预览: ${step.result.replace(/\s+/g, " ").slice(0, 160)}\n`);
}

console.log("最终工具链结果：");
console.log(chainResult.result);

console.log("\n已注册工具：");
console.log(registry.listTools().join(", "));

console.log("\n========== AsyncToolExecutor 并行工具执行 ==========\n");
const executor = new AsyncToolExecutor(registry, { concurrency: 2 });
const parallelStartedAt = Date.now();
const parallelResults = await executor.executeToolsParallel([
  {
    toolName: "customer_profile",
    input: "customerId=C-4096",
  },
  {
    toolName: "usage_summary",
    input: "customerId=C-4096",
  },
]);

console.log(`两个互不依赖的工具任务总耗时：${Date.now() - parallelStartedAt}ms`);
for (const result of parallelResults) {
  console.log(
    `任务 ${result.taskId}: ${result.toolName} -> ${result.status} (${result.durationMs}ms)`,
  );
}

console.log("\n批量查询客户画像：");
const batchResults = await executor.executeBatchTool(
  "customer_profile",
  ["customerId=C-2048", "customerId=C-1031", "customerId=C-4096"],
  { concurrency: 3 },
);

for (const result of batchResults) {
  const profile = readJson(result.result);
  console.log(
    `- ${profile.customerId} ${profile.companyName}：${profile.plan}，健康分 ${profile.healthScore}`,
  );
}

if (process.env.RUN_LLM_TOOL_CHAIN_DEMO === "1") {
  console.log("\n========== FunctionCallAgent 调用工具链 ==========\n");

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

  const agent = new FunctionCallAgent({
    name: "续约简报助手",
    llm,
    config,
    toolRegistry: registry,
    maxToolIterations: 3,
    systemPrompt: [
      "你是一个客户成功团队的续约分析助手。",
      "当用户要求生成续约简报时，优先调用 renewal_brief_builder 工具链。",
      "最终回答要面向客户成功经理，包含风险等级、理由和下一步动作。",
    ].join("\n"),
  });

  const answer = await agent.run("请为客户 C-2048 生成续约风险简报。", {
    temperature: 0.2,
    toolChoice: {
      type: "function",
      function: {
        name: "renewal_brief_builder",
      },
    },
    onStep(event) {
      if (event.type === "tool-call") {
        console.log(`模型请求调用工具：${event.toolName}`);
        console.log(`参数：${JSON.stringify(event.arguments)}`);
      }
      if (event.type === "tool-result") {
        console.log(`工具结果预览：${event.content.replace(/\s+/g, " ").slice(0, 200)}`);
      }
    },
  });

  console.log("\n助手：");
  console.log(answer);
} else {
  console.log(
    "\n已跳过真实 LLM 演示。需要验证 FunctionCallAgent 调用工具链时，请在 examples/.env 设置 RUN_LLM_TOOL_CHAIN_DEMO=1。",
  );
}
