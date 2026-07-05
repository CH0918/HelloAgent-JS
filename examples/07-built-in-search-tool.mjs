/**
 * 真实使用示例 -- 当前时间工具 + 内置 SearchTool + FunctionCallAgent
 *
 * SearchTool 是 SDK 内置工具，但它仍然通过 ToolRegistry 注册，
 * FunctionCallAgent 会把它转换成 OpenAI-compatible tools schema，
 * 再由模型通过原生 tool_calls 调用。
 *
 * 这个示例先注册一个本地 current_datetime 工具，让模型明确今天的日期和时间；
 * 再注册联网 search 工具，让模型基于当前日期检索最新比赛信息。
 *
 * 这个示例使用 Tavily 作为搜索 provider。SearchTool 也支持 SerpApi、
 * DuckDuckGo、SearXNG、Perplexity 和 hybrid/advanced 组合搜索。
 *
 * 注意：运行这个示例需要：
 *   1. 模型服务支持 OpenAI-compatible chat completions 的 tools 参数
 *   2. examples/.env 中配置 TAVILY_API_KEY
 *
 * 运行：
 *   pnpm build
 *   node examples/07-built-in-search-tool.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

import { Config, FunctionCallAgent, HelloAgentsLLM, SearchTool, Tool, ToolRegistry } from "../dist/index.js";

class CurrentDateTimeTool extends Tool {
  constructor() {
    super(
      "current_datetime",
      "获取当前日期、时间、时区和星期，用于把“今晚”“今天”“明天”等相对时间转换成明确日期。",
    );
  }

  run(parameters) {
    const timezone = typeof parameters.timezone === "string" && parameters.timezone.length > 0
      ? parameters.timezone
      : "Asia/Shanghai";
    const now = new Date();
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

    return JSON.stringify(
      {
        timezone,
        iso: now.toISOString(),
        localDate: `${byType.year}-${byType.month}-${byType.day}`,
        localTime: `${byType.hour}:${byType.minute}:${byType.second}`,
        weekday: byType.weekday,
      },
      null,
      2,
    );
  }

  getParameters() {
    return [
      {
        name: "timezone",
        type: "string",
        description: "IANA 时区名称，例如 Asia/Shanghai。默认使用北京时间。",
        required: false,
        default: "Asia/Shanghai",
      },
    ];
  }
}

if (!process.env.TAVILY_API_KEY) {
  console.error("缺少 TAVILY_API_KEY。请先复制 examples/.env.example 为 examples/.env，并填入 Tavily API Key。");
  process.exitCode = 1;
} else {
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

  const searchTool = new SearchTool({
    backend: "tavily",
  });

  const registry = new ToolRegistry();
  registry.registerTool(new CurrentDateTimeTool());
  registry.registerTool(searchTool);

  const agent = new FunctionCallAgent({
    name: "内置搜索助手",
    llm,
    config,
    toolRegistry: registry,
    maxToolIterations: 3,
    systemPrompt: [
      "你是一个严谨的中文体育赛事实时检索助手。",
      "当用户问题包含“今晚”“今天”“明天”等相对时间时，必须先调用 current_datetime 工具确认当前日期、时间、时区和星期。",
      "确认日期后，必须调用 search 工具检索最新比赛信息；搜索词要包含明确日期、球队、赛事名，以及“比分”“赛果”“直播”或“最新”。",
      "最终回答要明确说明你依据的当前日期时间，并基于搜索结果回答比分或赛况，同时列出来源链接。",
      "如果搜索结果显示比赛尚未开始、没有官方比分或结果不确定，要直接说明，不要编造比分。",
    ].join("\n"),
  });

  console.log(`provider : ${llm.provider}`);
  console.log(`baseUrl  : ${llm.baseUrl}`);
  console.log(`model    : ${llm.model}`);
  console.log(`tools    : ${agent.listTools().join(", ")}\n`);

  function printToolStep(event) {
    if (event.type === "tool-call") {
      console.log(`  - 模型请求调用工具：${event.toolName}`);
      console.log(`    参数：${JSON.stringify(event.arguments)}`);
      return;
    }

    if (event.type === "tool-result") {
      const preview = event.content.replace(/\s+/g, " ").slice(0, 500);
      console.log(`  - ${event.toolName} 工具结果预览：${preview}${event.content.length > 500 ? "..." : ""}`);
      return;
    }

    if (event.type === "finish") {
      console.log("  - 最终回复已生成。");
    }
  }

  const task = [
    "中国男篮世界杯今晚跟日本的比赛，比分情况如何？",
  ].join("\n");

  console.log("========== 内置 SearchTool + Tavily ==========\n");
  console.log("用户：");
  console.log(task);
  console.log("\n执行进度：");

  const answer = await agent.run(task, {
    maxToolIterations: 3,
    // toolChoice: {
    //   type: "function",
    //   function: {
    //     name: "search",
    //   },
    // },
    temperature: 0.2,
    onStep: printToolStep,
  });

  console.log("\n助手：");
  console.log(answer);

  console.log("\n可观测状态：");
  console.log(`长期历史消息数：${agent.getHistory().length}`);
}
