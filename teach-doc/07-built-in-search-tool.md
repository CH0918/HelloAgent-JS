# 从0构建SDK第7节：实现内置 SearchTool 搜索工具

前面几章我们已经有了完整的工具调用基础：

1. `Tool` 定义了一个工具必须有哪些信息。
2. `ToolRegistry` 负责注册工具，并把工具整理成提示词说明或 OpenAI-compatible tools schema。
3. `executeRegisteredTool()` 和 `executeRegisteredToolWithParameters()` 负责执行已注册工具。
4. `FunctionCallAgent` 会把工具 schema 交给模型，读取模型返回的 `tool_calls`，执行工具，再把结果作为 `role: "tool"` 消息回填给模型。

这一章要实现一个 SDK 内置搜索工具：`SearchTool`。

它的目标不是替 Agent 写一套新的联网流程，而是把“网页搜索”包装成一个普通工具。这样它可以被现有 Agent 直接使用：

```text
用户问题
  -> FunctionCallAgent 把 search 工具 schema 发给模型
  -> 模型返回 tool_calls: search({ query: "..." })
  -> Agent 通过 ToolRegistry 找到 SearchTool
  -> SearchTool 调用 Tavily / SerpApi / DuckDuckGo / SearXNG / Perplexity
  -> SearchTool 把搜索结果格式化成文本
  -> Agent 把工具结果作为 role: "tool" 消息交回模型
  -> 模型基于搜索结果生成最终回答
```

注意，搜索能力会接多个 provider，但本章的手动验证示例只用 Tavily。原因是 Tavily 的 API 返回结构稳定，配置也简单，适合作为第一条真实可跑通的验证路径。其他 provider 会在同一个 `SearchTool` 里接好，用户以后只需要切换 `backend` 或环境变量。

## 1. 本章最终效果

写完这一章后，业务代码可以这样使用内置搜索工具：

```js
import { FunctionCallAgent, HelloAgentsLLM, SearchTool, ToolRegistry } from "helloagent-js";

const llm = new HelloAgentsLLM();

const registry = new ToolRegistry();
registry.registerTool(
  new SearchTool({
    backend: "tavily",
  }),
);

const agent = new FunctionCallAgent({
  name: "内置搜索助手",
  llm,
  toolRegistry: registry,
  maxToolIterations: 1,
  systemPrompt: "回答前必须先调用 search 工具获取资料，并在最终回答中列出来源链接。",
});

const answer = await agent.run("搜索 Tavily Search API 的 max_results 参数，并用中文总结。", {
  toolChoice: {
    type: "function",
    function: {
      name: "search",
    },
  },
});

console.log(answer);
```

这里有几个关键点。

第一，`SearchTool` 是 SDK 内置工具，但注册方式没有特殊待遇，仍然是 `registry.registerTool(new SearchTool(...))`。

第二，`FunctionCallAgent` 不需要知道 Tavily、SerpApi、DuckDuckGo、SearXNG、Perplexity 的任何细节。它只知道自己有一个名叫 `search` 的工具。

第三，示例里用了 `toolChoice` 强制第一轮调用 `search`。这样示例不会依赖模型自己判断“需不需要搜索”，验证路径更稳定。第一轮工具执行完成后，`FunctionCallAgent` 会在达到 `maxToolIterations: 1` 后请求最终回答，并且最终回答那一轮不会继续携带 `tools`。

## 2. 为什么搜索应该做成 Tool

网页搜索看起来像一个很特殊的能力，因为它要访问外部网络，还要处理不同搜索服务的返回格式。但从 Agent 的角度看，它和报价计算工具没有本质区别：

```text
输入：搜索关键词
动作：调用外部服务
输出：一段可读的工具结果
```

所以我们不应该把搜索逻辑写进 `FunctionCallAgent`。

如果把搜索写进 Agent，会有几个问题。

第一，Agent 会越来越重。今天支持 Tavily，明天支持 SerpApi，后天支持 SearXNG，Agent 很快就会混进大量 provider 细节。

第二，其他 Agent 复用不了。`SimpleAgent`、`ReActAgent`、`FunctionCallAgent` 都能用工具。如果搜索是普通 `Tool`，这些 Agent 都可以注册它。如果搜索写死在 `FunctionCallAgent`，其他 Agent 就用不上。

第三，测试和排查更困难。工具内部可以单独检查某个 provider 的请求和响应；Agent 只需要检查工具调用链路。

所以本章的设计边界是：

- `SearchTool` 负责 provider 调用、结果归一化、文本格式化。
- `ToolRegistry` 负责注册和生成工具 schema。
- `FunctionCallAgent` 负责模型调用、工具执行循环、历史保存。
- 示例负责读取 `.env`、初始化真实模型、展示运行过程。

## 3. 本章新增和修改的文件

这一章涉及这些文件：

```text
src/
  tools/
    builtin/
      search.ts                # 新增：内置 SearchTool 和多个搜索 provider
      index.ts                 # 新增：内置工具统一导出
  index.ts                     # 修改：从 SDK 顶层导出 SearchTool 和相关类型

examples/
  .env.example                 # 修改：增加搜索工具相关环境变量
  README.md                    # 修改：增加第 7 个示例的说明
  07-built-in-search-tool.mjs  # 新增：Tavily 搜索工具真实验证示例

teach-doc/
  07-built-in-search-tool.md   # 新增：本章教程
```

这里没有修改 `FunctionCallAgent`、`ToolRegistry` 或 `executor`。这是一个重要信号：前面设计的工具注册和执行封装已经足够承载内置搜索工具。

## 4. 定义搜索工具的公共类型

文件 `src/tools/builtin/search.ts` 先从类型开始。

我们需要列出支持哪些搜索后端：

```ts
export const SUPPORTED_SEARCH_BACKENDS = [
  "hybrid",
  "advanced",
  "tavily",
  "serpapi",
  "duckduckgo",
  "searxng",
  "perplexity",
] as const;

export type SearchBackend = (typeof SUPPORTED_SEARCH_BACKENDS)[number];
```

这里保留了两个组合模式：

- `hybrid`：用户友好的默认值，内部会按组合搜索处理。
- `advanced`：和 `hybrid` 一样走多 provider fallback。

然后定义统一的搜索结果结构：

```ts
export interface SearchResult {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score?: number;
  source?: string;
  publishedDate?: string;
}

export interface SearchResponse {
  query: string;
  backend: string;
  answer?: string;
  results: SearchResult[];
  notices: string[];
}
```

每个 provider 返回的数据都不一样。

Tavily 的结果字段是 `title`、`url`、`content`、`raw_content`。

SerpApi 的自然搜索结果在 `organic_results` 里，链接字段叫 `link`，摘要字段叫 `snippet`。

SearXNG 通常返回 `results`，结果里可能有 `url`、`title`、`content`、`engine`。

Perplexity 会返回模型生成的 `choices[0].message.content`，同时可能返回 `citations` 或 `search_results`。

如果每个 provider 都直接把原始 JSON 往外抛，Agent 很难稳定使用。所以我们先把它们归一化成 `SearchResponse`，最后再统一格式化成文本。

## 5. 为什么 SearchTool.run() 返回字符串

当前 SDK 的工具结果类型是：

```ts
export type ToolResult = string | Promise<string>;
```

所以 `SearchTool.run()` 也返回字符串：

```ts
async run(parameters: ToolParameters): Promise<string> {
  try {
    const request = this.createRequest(parameters);
    const response = await this.searchWithRequest(request);
    const mode = normalizeMode(readString(readParameter(parameters, ["mode", "returnMode", "return_mode"])));

    if (mode === "structured" || mode === "json" || mode === "dict") {
      return JSON.stringify(response, null, 2);
    }

    return this.formatTextResponse(response);
  } catch (error) {
    return `搜索失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
```

这里有两个设计选择。

第一，默认返回 `text`。Agent 最终要把工具结果交给 LLM，文本格式最直接。格式化后的内容会包含搜索关键词、使用的搜索源、直接答案、参考来源、摘要和链接。

第二，保留 `structured/json/dict` 模式。但因为工具接口当前只能返回字符串，所以这些模式返回的是 `JSON.stringify(response, null, 2)`。这让开发者可以在调试时看到结构化内容，同时不破坏工具基类。

如果未来 SDK 要支持“工具返回对象”，可以扩展 `ToolResult`。但这一章不做这个改动，因为搜索工具本身不需要推动底层接口变化。

## 6. 工具参数如何设计

`SearchTool.getParameters()` 决定模型在 function calling 里看到什么 schema。

```ts
getParameters(): ToolParameter[] {
  return [
    {
      name: "query",
      type: "string",
      description: "搜索查询关键词或问题",
      required: true,
    },
    {
      name: "backend",
      type: "string",
      description: "搜索后端：hybrid、advanced、tavily、serpapi、duckduckgo、searxng 或 perplexity",
      required: false,
      default: this.backend,
    },
    {
      name: "maxResults",
      type: "integer",
      description: "最多返回多少条搜索结果，范围 1 到 20",
      required: false,
      default: 5,
    },
    {
      name: "fetchFullPage",
      type: "boolean",
      description: "是否尝试抓取搜索结果页面正文",
      required: false,
      default: false,
    },
    {
      name: "mode",
      type: "string",
      description: "返回模式：text、structured、json 或 dict。Agent 默认使用 text",
      required: false,
      default: "text",
    },
  ];
}
```

最重要的参数是 `query`。模型通过原生 function calling 调用工具时，会生成这样的 arguments：

```json
{
  "query": "Tavily Search API max_results include_answer include_raw_content",
  "backend": "tavily",
  "maxResults": 5
}
```

但我们还要兼容前面章节的文本协议工具调用。

`SimpleAgent` 的简单文本调用可能会被解析成：

```js
{ input: "Tavily Search API" }
```

所以 `SearchTool.createRequest()` 同时读取 `query` 和 `input`：

```ts
const query = firstString(readParameter(parameters, ["query", "input"]));
```

这样同一个内置搜索工具既能被 `FunctionCallAgent` 使用，也能被 `SimpleAgent` 和 `ReActAgent` 使用。

## 7. provider 配置从哪里来

`SearchTool` 的构造函数接收 `SearchToolOptions`：

```ts
const searchTool = new SearchTool({
  backend: "tavily",
});
```

如果用户不手动传 key，它会从环境变量读取：

```text
SEARCH_BACKEND=hybrid
TAVILY_API_KEY=
SERPAPI_API_KEY=
SEARXNG_URL=http://localhost:8888
PERPLEXITY_API_KEY=
```

每个 provider 的最小配置如下：

```text
Tavily:
  TAVILY_API_KEY
  TAVILY_SEARCH_DEPTH 可选，默认 basic

SerpApi:
  SERPAPI_API_KEY
  SERPAPI_GL 可选，默认 cn
  SERPAPI_HL 可选，默认 zh-cn

DuckDuckGo:
  不需要 API Key

SearXNG:
  SEARXNG_URL 可选，默认 http://localhost:8888
  SEARXNG_LANGUAGE 可选，默认 zh-CN

Perplexity:
  PERPLEXITY_API_KEY
  PERPLEXITY_ENDPOINT 可选，默认 https://api.perplexity.ai/v1/sonar
  PERPLEXITY_MODEL 可选
```

默认 `backend` 是 `SEARCH_BACKEND`，如果没有配置就是 `hybrid`。

## 8. Tavily provider 如何实现

Tavily provider 对应 `searchTavily()`。

核心请求是：

```ts
const payload = await this.fetchJson(this.tavilyEndpoint, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${this.tavilyApiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    query: request.query,
    max_results: request.maxResults,
    include_answer: true,
    include_raw_content: request.fetchFullPage,
    search_depth: this.tavilySearchDepth,
  }),
});
```

这里的 `request.maxResults` 来自工具参数 `maxResults`，最后会传给 Tavily 的 `max_results`。

`include_answer: true` 表示希望 Tavily 同时返回一个直接答案。这个答案不一定每次都有，但如果有，`SearchTool` 会把它放在格式化文本的“直接答案”区域。

`include_raw_content` 对应工具参数 `fetchFullPage`。默认不抓全文，因为全文会增加延迟和 token 体积。只有用户明确需要更多上下文时才打开。

Tavily 返回后，我们只保留 Agent 需要的字段：

```ts
const results = asObjectArray(data.results)
  .slice(0, request.maxResults)
  .map((item) =>
    normalizeResult({
      title: firstString(item.title, item.url),
      url: firstString(item.url) ?? "",
      content: firstString(item.content) ?? "",
      rawContent: this.limitOptionalText(firstString(item.raw_content, item.rawContent, item.content), request),
      score: firstNumber(item.score),
      source: firstString(item.source),
    }),
  );
```

这样 Agent 不需要关心 Tavily 的原始响应结构。

## 9. SerpApi provider 如何实现

SerpApi provider 对应 `searchSerpApi()`。

它使用 Google 搜索参数：

```ts
const url = `${this.serpApiEndpoint}?${encodeQuery({
  engine: "google",
  q: request.query,
  api_key: this.serpApiKey,
  gl: this.serpApiGl,
  hl: this.serpApiHl,
  num: request.maxResults,
})}`;
```

然后读取两个位置。

第一，`answer_box` 里可能有直接答案：

```ts
const answerBox = isObject(data.answer_box) ? data.answer_box : {};
const answer = firstString(answerBox.answer, answerBox.snippet, answerBox.title);
```

第二，自然搜索结果在 `organic_results`：

```ts
const results = asObjectArray(data.organic_results)
  .slice(0, request.maxResults)
  .map((item) =>
    normalizeResult({
      title: firstString(item.title, item.link) ?? "",
      url: firstString(item.link) ?? "",
      content: firstString(item.snippet, item.description) ?? "",
      source: "serpapi",
    }),
  );
```

SerpApi 需要 `SERPAPI_API_KEY`。如果没有配置，直接使用 `backend: "serpapi"` 会返回搜索失败；如果走 `hybrid`，它会跳过或记录 notice，再尝试其他 provider。

## 10. DuckDuckGo provider 如何实现

DuckDuckGo provider 不需要 API Key。这里使用 DuckDuckGo Instant Answer JSON 接口。

请求参数是：

```ts
const url = `${this.duckDuckGoEndpoint}?${encodeQuery({
  q: request.query,
  format: "json",
  no_html: 1,
  skip_disambig: 1,
})}`;
```

它的返回结构和标准搜索页不同，经常会有：

- `AbstractText`
- `AbstractURL`
- `Heading`
- `RelatedTopics`

所以实现里会先读直接摘要，再递归整理 `RelatedTopics`。

这个 provider 适合作为无 key 兜底，但它不是完整 Google/Bing 搜索结果替代。教程和示例不把它作为主路径，是因为它对普通长查询的结果不如 Tavily 稳定。

## 11. SearXNG provider 如何实现

SearXNG provider 对应 `searchSearxng()`。

它默认连接：

```text
http://localhost:8888/search
```

也可以通过环境变量改成自己的实例：

```text
SEARXNG_URL=http://localhost:8888
```

请求参数是：

```ts
const url = `${this.searxngUrl}/search?${encodeQuery({
  q: request.query,
  format: "json",
  language: this.searxngLanguage,
  safesearch: 1,
  categories: "general",
})}`;
```

SearXNG 的一个实际限制是：不是所有公开实例都开放 JSON 格式。有些实例会因为 `format=json` 没启用而返回 403。所以如果团队需要稳定使用 SearXNG，最好自己部署实例，并确认 `settings.yml` 里允许 JSON 输出。

## 12. Perplexity provider 如何实现

Perplexity provider 对应 `searchPerplexity()`。

它适合“搜索 + 总结”一体化的场景，因为 Perplexity 返回的核心内容通常是一段模型生成答案，同时附带引用或搜索结果。

默认 endpoint 是：

```text
https://api.perplexity.ai/v1/sonar
```

请求体是：

```ts
const body = {
  messages: [
    {
      role: "system",
      content: "Search the web and provide factual information with sources.",
    },
    {
      role: "user",
      content: request.query,
    },
  ],
};
```

如果配置了 `PERPLEXITY_MODEL`，会额外带上 `model`。

返回结果里优先读取 `search_results`：

```ts
const searchResults = asObjectArray(data.search_results);
```

如果没有 `search_results`，就退回读取 `citations`：

```ts
asArray(data.citations).map((url, index) =>
  normalizeResult({
    title: `Perplexity Source ${request.loopCount + 1}-${index + 1}`,
    url: readString(url) ?? "",
    content: index === 0 ? answer ?? "" : "See main Perplexity response above.",
    source: "perplexity",
  }),
);
```

这保证 Perplexity 的结果也能被统一格式化给 Agent。

## 13. hybrid 和 advanced 如何工作

`hybrid` 会被视作 `advanced`：

```ts
const backend = request.backend === "hybrid" ? "advanced" : request.backend;
```

组合搜索的顺序是：

```text
1. Tavily，如果配置了 TAVILY_API_KEY
2. SerpApi，如果配置了 SERPAPI_API_KEY
3. SearXNG，如果配置了 SEARXNG_URL
4. DuckDuckGo，无需 key
5. Perplexity，如果配置了 PERPLEXITY_API_KEY
```

每一次失败都会记录到 `notices`。如果某个 provider 返回了有效结果，就直接返回，并把之前的 notice 合并进去。

这样设计的好处是默认模式可用性更高。用户只配 Tavily 时走 Tavily；没有 Tavily 时还能尝试 DuckDuckGo；如果团队有自建 SearXNG，也能通过环境变量接上。

## 14. 工具如何注册给 Agent

搜索工具和普通工具一样注册：

```js
const searchTool = new SearchTool({
  backend: "tavily",
});

const registry = new ToolRegistry();
registry.registerTool(searchTool);
```

`ToolRegistry.registerTool()` 会把工具放进内部 `Map`：

```ts
this.tools.set(tool.name, tool);
```

之后 `FunctionCallAgent` 会调用：

```ts
this.toolRegistry.getOpenAIToolSchemas();
```

而 `SearchTool` 从 `Tool` 基类继承了 `toOpenAISchema()`。这个方法会读取 `getParameters()`，生成 OpenAI-compatible schema：

```json
{
  "type": "function",
  "function": {
    "name": "search",
    "description": "智能网页搜索工具，支持 Tavily、SerpApi、DuckDuckGo、SearXNG、Perplexity 和 hybrid/advanced 组合搜索。",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "搜索查询关键词或问题"
        }
      },
      "required": ["query"]
    }
  }
}
```

这就是模型能“看见”搜索工具的原因。

## 15. Agent 如何执行 search tool_calls

`FunctionCallAgent.run()` 的主循环会请求模型：

```ts
const response = await this.llm.invokeMessage(messages, {
  ...llmOptions,
  tools: toolSchemas,
  tool_choice: toolChoice,
});
```

如果模型返回：

```json
{
  "tool_calls": [
    {
      "id": "call_xxx",
      "type": "function",
      "function": {
        "name": "search",
        "arguments": "{\"query\":\"Tavily Search API max_results\"}"
      }
    }
  ]
}
```

Agent 会解析 arguments：

```ts
const parsedArguments = this.parseFunctionCallArguments(toolCall.function.arguments);
```

再执行：

```ts
const result = await executeRegisteredToolWithParameters(this.toolRegistry, toolName, parsedArguments);
```

`executeRegisteredToolWithParameters()` 会从注册表找到 `SearchTool`，然后调用：

```ts
await tool.run(convertParameterTypes(tool, parameters));
```

搜索完成后，Agent 会把结果写成 tool message：

```ts
messages.push({
  role: "tool",
  content: result,
  name: toolName,
  tool_call_id: toolCall.id,
});
```

模型下一轮就能基于搜索结果生成最终回答。

## 16. 为什么示例使用 Tavily

示例文件是 `examples/07-built-in-search-tool.mjs`。

它固定使用 Tavily：

```js
const searchTool = new SearchTool({
  backend: "tavily",
});
```

并且在运行前检查：

```js
if (!process.env.TAVILY_API_KEY) {
  console.error("缺少 TAVILY_API_KEY。请先复制 examples/.env.example 为 examples/.env，并填入 Tavily API Key。");
  process.exitCode = 1;
}
```

这样做是为了避免示例在没有 key 的情况下静默失败。

然后创建 Agent：

```js
const agent = new FunctionCallAgent({
  name: "内置搜索助手",
  llm,
  config,
  toolRegistry: registry,
  maxToolIterations: 1,
  systemPrompt: [
    "你是一个严谨的中文技术资料检索助手。",
    "回答前必须先调用 search 工具获取资料；最终回答要基于搜索结果，并列出来源链接。",
    "不要编造来源。没有搜索结果时，要明确说明没有找到可引用来源。",
  ].join("\n"),
});
```

最后运行时强制第一轮调用 `search`：

```js
const answer = await agent.run(task, {
  maxToolIterations: 1,
  toolChoice: {
    type: "function",
    function: {
      name: "search",
    },
  },
  temperature: 0.2,
  onStep: printSearchStep,
});
```

`maxToolIterations: 1` 很重要。第一轮强制 search，工具结果回填后主循环达到上限，Agent 会再请求一次最终回答。这次最终回答不会继续携带 `tools`，所以模型会基于搜索结果写总结，而不是继续调用工具。

## 17. 如何配置和运行示例

先构建 SDK：

```bash
pnpm build
```

复制环境变量：

```bash
cp examples/.env.example examples/.env
```

至少填入两类配置。

第一类是 LLM：

```bash
LLM_API_KEY=your-llm-key
LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
LLM_MODEL_ID=your-model
```

第二类是 Tavily：

```bash
TAVILY_API_KEY=tvly-your-key
```

然后运行：

```bash
node examples/07-built-in-search-tool.mjs
```

你会看到类似这样的进度：

```text
执行进度：
  - 模型请求调用工具：search
    参数：{"query":"Tavily Search API max_results include_answer include_raw_content","backend":"tavily"}
  - Tavily 搜索结果预览：搜索关键词：...
  - 最终回复已生成。
```

最后的助手回复应该基于搜索结果总结，并列出来源链接。

## 18. 本章实现完成后的能力边界

现在 SDK 已经有一个可复用的内置搜索工具。

它支持：

- `SearchTool` 普通注册。
- `search()`、`searchTavily()`、`searchSerpApi()`、`searchDuckDuckGo()`、`searchSearxng()`、`searchPerplexity()`、`searchHybrid()` 便捷函数。
- `FunctionCallAgent` 原生 function calling。
- `SimpleAgent` 的 `input` 参数兼容。
- `ReActAgent` 的文本工具调用兼容。
- Tavily、SerpApi、DuckDuckGo、SearXNG、Perplexity。
- `hybrid/advanced` 组合 fallback。
- 文本结果和 JSON 字符串结果。

它暂时不做这些事：

- 不自动注册到 `globalRegistry`。搜索是联网能力，应该由使用者明确注册。
- 不把搜索结果永久保存到 Agent 历史。长期历史仍然只保存用户输入和最终回答。
- 不引入 Tavily、SerpApi 或 DuckDuckGo 的第三方 SDK 依赖。当前实现使用运行环境的 `fetch`。
- 不做浏览器级页面渲染。`fetchFullPage` 只尝试抓取 HTML 并做轻量文本清洗。

这保持了本章的边界：我们完成一个真实可用的内置工具，同时不扩大 Agent 框架本身的复杂度。
