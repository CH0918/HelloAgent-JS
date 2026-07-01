# 从0构建SDK第1节：从零构建一个最小可用的 LLM SDK

这一节我们不先讨论复杂的 Agent、工具调用、记忆系统或工作流编排，而是从最基础的问题开始：如何手写一个可以被别人 `import` 的 TypeScript SDK，并让它完成一次大模型调用？

本节配套代码仓库在 GitHub：<https://github.com/CH0918/HelloAgent-JS>。你可以先对照文章理解设计，再打开仓库查看完整源码和 examples。

一个智能体框架最终会有很多模块，但最底层一定离不开三件事：

1. 能表示一条消息，例如用户说了什么、助手回复了什么。
2. 能读取配置，例如 API Key、模型名、服务地址。
3. 能调用大模型，并把结果用统一的接口返回给上层。

本节完成的就是这三件事。做完后，我们会得到一个最小 SDK，它可以这样使用：

```ts
import { HelloAgentsLLM, Message } from "helloagent-js";

const message = new Message("你好，请介绍一下你自己。", "user");

const llm = new HelloAgentsLLM({
  provider: "deepseek",
  apiKey: process.env.DEEPSEEK_API_KEY,
});

const answer = await llm.invoke([message.toDict()]);
console.log(answer);
```

这段代码看起来很短，但背后需要解决 SDK 工程、类型设计、错误处理、环境变量、模型服务适配、流式输出等问题。我们会一步一步拆开。

## 1. 本节目标

完成本节后，项目应该具备以下能力：

- 可以通过 `pnpm build` 把 TypeScript 编译成 JavaScript。
- 可以从 `dist/index.js` 导入 SDK 的公开 API。
- SDK 暴露 `Message`、`Config`、`HelloAgentsLLM` 和框架异常类型。
- `HelloAgentsLLM` 支持 OpenAI 兼容接口。
- 用户可以显式传入 `apiKey`、`baseUrl`、`model`，也可以通过环境变量提供。
- SDK 能自动识别常见模型服务商，例如 OpenAI、DeepSeek、通义千问兼容模式、ModelScope、Kimi、智谱、Ollama、本地 vLLM 等。
- SDK 同时支持非流式调用和流式调用。
- examples 目录里有可运行样例，方便手动验证。

本节只做 LLM SDK 的第一层能力，不做 Agent 基类，不做工具系统。这样学习路径会更清楚：先让 SDK 能稳定调用模型，再让 Agent 使用这个 SDK。

## 2. 先理解 SDK 的结构

在写代码前，先看最终目录。一个最小 SDK 不应该把所有逻辑都塞进 `index.ts`，而是要把职责拆开：

```text
helloagent-js/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   └── core/
│       ├── exceptions.ts
│       ├── message.ts
│       ├── config.ts
│       └── llm.ts
├── examples/
│   ├── README.md
│   ├── package.json
│   ├── .env.example
│   └── 01-real-world-usage.mjs
└── teach-doc/
    └── 01-core-llm-layer.md
```

每个文件的职责如下：

- `src/index.ts`：SDK 的门面。用户从这里导入公开能力。
- `src/core/exceptions.ts`：统一异常类型。后续排查问题时，可以知道错误来自 SDK 哪一层。
- `src/core/message.ts`：消息对象。它负责把一条消息转换成大模型 API 能理解的格式。
- `src/core/config.ts`：基础配置对象。它负责从代码参数或环境变量里得到配置。
- `src/core/llm.ts`：模型调用核心。它负责选择 provider、解析凭证、创建客户端、发起调用。
- `examples/`：可运行案例。SDK 不能只靠文字说明，必须有可以执行的最小样例。

这个结构的原则是：一个文件只负责一件主要事情。以后加 Agent、Tools、Memory 时，也能继续沿用这种分层方式。

## 3. 初始化 package.json

SDK 首先是一个 npm 包。即使暂时不发布到 npm，也应该按包的方式组织代码，因为这样用户才能用标准方式导入。

`package.json` 里最关键的是这几项：

```json
{
  "name": "helloagent-js",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "openai": "^4.104.0"
  },
  "devDependencies": {
    "typescript": "^6.0.3"
  }
}
```

逐项解释：

- `"type": "module"` 表示这个包使用 ESM 模块系统，也就是 `import/export`。
- `"main"` 指向编译后的 JS 入口。
- `"types"` 指向编译后的类型声明文件。
- `"exports"` 控制用户 `import { ... } from "helloagent-js"` 时实际拿到什么。
- `"build": "tsc"` 用 TypeScript 编译项目。
- `"typecheck": "tsc --noEmit"` 只检查类型，不生成文件。
- `"openai"` 是运行时依赖。我们使用它连接任何 OpenAI 兼容服务。

这里有一个重要细节：SDK 源码放在 `src/`，真正给用户运行的是 `dist/`。所以 examples 里会先要求运行 `pnpm build`。

## 4. 配置 TypeScript 编译

接着配置 `tsconfig.json`。这个文件决定 TypeScript 怎么把 `src/` 编译成 `dist/`。

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "sourceMap": true,
    "declaration": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

这里最需要理解的是三组配置：

第一组是输出位置：

- `rootDir: "./src"` 表示源码目录是 `src`。
- `outDir: "./dist"` 表示编译结果放到 `dist`。
- `declaration: true` 表示生成 `.d.ts` 类型声明文件。SDK 必须提供类型声明，否则用户在 TypeScript 项目里使用时体验会很差。

第二组是模块系统：

- `module: "NodeNext"`
- `moduleResolution: "NodeNext"`

这两项配合 `"type": "module"` 使用。启用后，源码里的相对导入要写 `.js` 后缀，例如：

```ts
import { HelloAgentsException } from "./exceptions.js";
```

虽然源码文件实际叫 `exceptions.ts`，但编译后会变成 `exceptions.js`。在 NodeNext 模式下，TypeScript 要求你提前写编译后的后缀。

第三组是严格检查：

- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`

这些配置会让编译更严格。刚开始会感觉麻烦，但做 SDK 时这是好事，因为 SDK 一旦被别人依赖，类型越清楚，后续维护越轻松。

## 5. 第一个核心文件：异常体系

先写 `src/core/exceptions.ts`。

为什么第一步不是 LLM，而是异常？

因为 SDK 一定会遇到错误，例如缺少 API Key、服务地址不正确、模型返回格式异常、网络连接失败。如果每个地方都随手 `throw new Error(...)`，调用方很难判断错误来自哪里。我们需要先定义框架自己的异常类型。

完整代码：

```ts
export class HelloAgentsException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelloAgentsException";
  }
}

export class LLMException extends HelloAgentsException {
  constructor(message: string) {
    super(message);
    this.name = "LLMException";
  }
}

export class AgentException extends HelloAgentsException {
  constructor(message: string) {
    super(message);
    this.name = "AgentException";
  }
}

export class ConfigException extends HelloAgentsException {
  constructor(message: string) {
    super(message);
    this.name = "ConfigException";
  }
}

export class ToolException extends HelloAgentsException {
  constructor(message: string) {
    super(message);
    this.name = "ToolException";
  }
}
```

现在虽然只用到了 `HelloAgentsException`，但提前定义 `AgentException`、`ToolException` 是合理的，因为后续章节会继续扩展 Agent 和工具系统。

这里不要写太复杂。异常层只负责表达“这是什么类型的错误”，不要在这里处理日志、重试、上报等逻辑。

## 6. 第二个核心文件：消息系统

接着写 `src/core/message.ts`。

大模型 API 接收的消息通常长这样：

```ts
{ role: "user", content: "你好" }
```

其中 `role` 表示消息角色。常见角色有：

- `system`：系统提示词，用来规定助手的行为。
- `user`：用户输入。
- `assistant`：模型回复。
- `tool`：工具执行结果，后续做工具调用时会用到。

我们先定义角色类型：

```ts
export type MessageRole = "user" | "assistant" | "system" | "tool";
```

然后定义构造消息时可以传入的选项：

```ts
export interface MessageOptions {
  timestamp?: Date;
  metadata?: Record<string, unknown>;
}
```

`timestamp` 表示消息创建时间，`metadata` 用来保存额外信息。比如以后你可能想记录这条消息来自哪个工具、属于哪个会话、token 数是多少。

再定义 OpenAI 兼容格式：

```ts
export interface OpenAIMessage {
  role: MessageRole;
  content: string;
}
```

最后实现 `Message` 类：

```ts
export class Message {
  readonly content: string;
  readonly role: MessageRole;
  readonly timestamp: Date;
  readonly metadata: Record<string, unknown>;

  constructor(content: string, role: MessageRole, options: MessageOptions = {}) {
    this.content = content;
    this.role = role;
    this.timestamp = options.timestamp ?? new Date();
    this.metadata = options.metadata ?? {};
  }

  toDict(): OpenAIMessage {
    return {
      role: this.role,
      content: this.content,
    };
  }

  toString(): string {
    return `[${this.role}] ${this.content}`;
  }
}
```

这里有两个设计点：

第一，`toDict()` 只返回 `role` 和 `content`。虽然 `Message` 自己有 `timestamp` 和 `metadata`，但大模型 API 不一定接受这些字段。SDK 内部可以保存更多信息，发送给模型时要转成模型认识的格式。

第二，字段使用 `readonly`。这表示消息创建后不建议再修改。对话历史里最怕消息被后续代码无意改掉，所以默认不可变更稳。

## 7. 第三个核心文件：配置对象

接着写 `src/core/config.ts`。

配置对象的作用是集中管理默认参数。比如默认模型、默认 provider、temperature、最大 token 数、日志级别等。先定义构造参数：

```ts
export interface ConfigOptions {
  defaultModel?: string;
  defaultProvider?: string;
  temperature?: number;
  maxTokens?: number;
  debug?: boolean;
  logLevel?: string;
  maxHistoryLength?: number;
}
```

再定义导出成普通对象时的结构：

```ts
export interface ConfigDict {
  defaultModel: string;
  defaultProvider: string;
  temperature: number;
  maxTokens?: number;
  debug: boolean;
  logLevel: string;
  maxHistoryLength: number;
}
```

然后准备读取环境变量的辅助函数：

```ts
type Env = Record<string, string | undefined>;

function currentEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

function readNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
```

这里不直接写 `process.env`，而是通过 `globalThis` 取，是为了让类型更明确，也让未来在非 Node 环境里扩展时更容易调整。

最后实现 `Config`：

```ts
export class Config {
  readonly defaultModel: string;
  readonly defaultProvider: string;
  readonly temperature: number;
  readonly maxTokens?: number;
  readonly debug: boolean;
  readonly logLevel: string;
  readonly maxHistoryLength: number;

  constructor(options: ConfigOptions = {}) {
    this.defaultModel = options.defaultModel ?? "gpt-3.5-turbo";
    this.defaultProvider = options.defaultProvider ?? "openai";
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens;
    this.debug = options.debug ?? false;
    this.logLevel = options.logLevel ?? "INFO";
    this.maxHistoryLength = options.maxHistoryLength ?? 100;
  }

  static fromEnv(env: Env = currentEnv()): Config {
    return new Config({
      debug: env.DEBUG?.toLowerCase() === "true",
      logLevel: env.LOG_LEVEL ?? "INFO",
      temperature: readNumber(env.TEMPERATURE) ?? 0.7,
      maxTokens: readNumber(env.MAX_TOKENS),
    });
  }

  toDict(): ConfigDict {
    return {
      defaultModel: this.defaultModel,
      defaultProvider: this.defaultProvider,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      debug: this.debug,
      logLevel: this.logLevel,
      maxHistoryLength: this.maxHistoryLength,
    };
  }
}
```

现在我们有两种创建配置的方式：

```ts
const config = new Config({ temperature: 0.3 });
```

或者：

```ts
const config = Config.fromEnv();
```

这就是 SDK 常见的设计：参数优先，环境变量兜底。用户写 demo 时可以手动传参，部署时可以用环境变量。

## 8. 第四个核心文件：LLM 类型设计

现在开始写最重要的 `src/core/llm.ts`。

不要一上来就写类。先把类型想清楚。LLM 客户端至少需要知道：

- 支持哪些 provider。
- 一条聊天消息是什么结构。
- 构造 LLM 时能传哪些参数。
- OpenAI 兼容客户端应该长什么样。
- 模型响应大概是什么结构。

先导入依赖：

```ts
import OpenAI from "openai";

import { HelloAgentsException } from "./exceptions.js";
import type { MessageRole, OpenAIMessage } from "./message.js";
```

定义支持的 provider：

```ts
export type SupportedProvider =
  | "openai"
  | "deepseek"
  | "qwen"
  | "modelscope"
  | "kimi"
  | "zhipu"
  | "ollama"
  | "vllm"
  | "local"
  | "auto"
  | "custom";
```

这里的重点不是列出越多越好，而是统一一套入口。以后用户不需要记每个服务商的 base URL，只要传 `provider`，SDK 内部处理默认值。

定义消息类型：

```ts
export type ChatMessage = OpenAIMessage & {
  role: MessageRole;
};
```

定义构造参数：

```ts
export interface HelloAgentsLLMOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  provider?: SupportedProvider;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  env?: Record<string, string | undefined>;
  client?: OpenAICompatibleClient;
  extraOptions?: Record<string, unknown>;
}
```

每个字段含义如下：

- `model`：模型名，例如 `deepseek-chat`。
- `apiKey`：模型服务 API Key。
- `baseUrl`：OpenAI 兼容 API 地址。
- `provider`：服务商名称。
- `temperature`：采样温度，越高越发散。
- `maxTokens`：最多生成多少 token。
- `timeout`：请求超时时间，单位是秒。
- `env`：允许测试或样例传入一份假的环境变量。
- `client`：允许注入一个假的 OpenAI 兼容客户端，方便不用真实 API Key 也能验证逻辑。
- `extraOptions`：预留给模型服务的额外参数。

`client` 是一个很重要的设计。没有它，所有验证都必须真实联网；有了它，我们就可以在 examples 里用 mock client 演示 `invoke` 和 `streamInvoke`。

## 9. 定义 OpenAI 兼容客户端形状

为了避免 SDK 和某个具体 SDK 实现绑死，我们先定义一个“只要长得像 OpenAI Chat Completions 就能用”的接口：

```ts
interface ChatCompletionChoice {
  message?: {
    content?: string | null;
  };
  delta?: {
    content?: string | null;
  };
}

interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
}

interface ChatCompletionChunk {
  choices: ChatCompletionChoice[];
}

interface ChatCompletionCreateParams {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface OpenAICompatibleClient {
  chat: {
    completions: {
      create(
        params: ChatCompletionCreateParams,
      ):
        | Promise<ChatCompletionResponse>
        | Promise<AsyncIterable<ChatCompletionChunk>>
        | AsyncIterable<ChatCompletionChunk>;
    };
  };
}
```

这里故意只定义 SDK 目前需要用到的字段：

- 非流式响应读取 `choices[0].message.content`。
- 流式响应读取 `choices[0].delta.content`。

不要一开始就把 OpenAI 的所有响应字段都建模出来。SDK 的第一版应该保持小而清楚。等后面要支持 function calling、tool calls、usage 统计时，再扩展类型。

## 10. 写环境变量和工具函数

LLM 类需要读取环境变量、判断字符串是否存在、判断响应是不是流式迭代器。先写这些小函数：

```ts
type Env = Record<string, string | undefined>;

function currentEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

function hasValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function readTimeout(env: Env, timeout: number | undefined): number {
  if (timeout !== undefined) {
    return timeout;
  }

  const parsed = Number(env.LLM_TIMEOUT);
  return Number.isFinite(parsed) ? parsed : 60;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ChatCompletionChunk> {
  return typeof (value as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator] === "function";
}
```

这些函数很小，但能让后面的类代码更干净。

例如 `hasValue()` 不只判断真假，还通过 `value is string` 告诉 TypeScript：如果这个函数返回 true，后面的 value 就是 string。

`isAsyncIterable()` 用来区分两种响应：

- 非流式：普通对象，里面有 `choices[0].message.content`。
- 流式：异步迭代器，可以 `for await ... of`。

## 11. 实现 HelloAgentsLLM 构造函数

先搭出类的字段：

```ts
export class HelloAgentsLLM {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly provider: SupportedProvider;
  readonly temperature: number;
  readonly maxTokens?: number;
  readonly timeout: number;

  private readonly client: OpenAICompatibleClient;
  private readonly env: Env;
  private readonly extraOptions: Record<string, unknown>;
}
```

这些字段里，公开的字段都是 `readonly`，表示实例创建后不应该再变。这样调用方可以安全地读取：

```ts
console.log(llm.provider);
console.log(llm.model);
```

接着写构造函数：

```ts
constructor(options: HelloAgentsLLMOptions = {}) {
  this.env = options.env ?? currentEnv();
  this.temperature = options.temperature ?? 0.7;
  this.maxTokens = options.maxTokens;
  this.timeout = readTimeout(this.env, options.timeout);
  this.extraOptions = options.extraOptions ?? {};

  const requestedProvider = options.provider?.toLowerCase() as SupportedProvider | undefined;
  this.provider = requestedProvider ?? this.autoDetectProvider(options.apiKey, options.baseUrl);

  const credentials =
    requestedProvider === "custom"
      ? {
          apiKey: options.apiKey ?? this.env.LLM_API_KEY,
          baseUrl: options.baseUrl ?? this.env.LLM_BASE_URL,
        }
      : this.resolveCredentials(options.apiKey, options.baseUrl);

  this.apiKey = credentials.apiKey ?? "";
  this.baseUrl = credentials.baseUrl ?? "";
  this.model = options.model ?? this.env.LLM_MODEL_ID ?? this.getDefaultModel();

  if (!hasValue(this.apiKey) || !hasValue(this.baseUrl)) {
    throw new HelloAgentsException("API密钥和服务地址必须被提供或在.env文件中定义。");
  }

  this.client = options.client ?? this.createClient();
}
```

构造函数的执行顺序很重要：

1. 先确定环境变量来源。
2. 读取通用参数，例如 temperature、timeout。
3. 如果用户传了 provider，就使用用户指定的 provider。
4. 如果用户没传 provider，就自动检测。
5. 根据 provider 解析 API Key 和 base URL。
6. 根据 provider 得到默认模型。
7. 检查必要参数是否存在。
8. 创建真实客户端，或使用用户注入的 mock client。

这就是 SDK 初始化的主流程。后续排查任何初始化问题，都可以按这 8 步检查。

## 12. 自动识别 provider

`autoDetectProvider()` 的目标是：尽量减少用户配置。

如果用户已经设置了 `DEEPSEEK_API_KEY`，SDK 就可以推断 provider 是 `deepseek`。如果用户没有设置 provider 专属 key，但传了 `baseUrl`，SDK 也可以通过 URL 判断。

核心逻辑可以分成三层。

第一层：检查常见环境变量：

```ts
if (hasValue(this.env.OPENAI_API_KEY)) {
  return "openai";
}
if (hasValue(this.env.DEEPSEEK_API_KEY)) {
  return "deepseek";
}
if (hasValue(this.env.DASHSCOPE_API_KEY)) {
  return "qwen";
}
if (hasValue(this.env.MODELSCOPE_API_KEY)) {
  return "modelscope";
}
```

第二层：根据 API Key 的形态猜测：

```ts
const actualApiKey = apiKey ?? this.env.LLM_API_KEY;
if (hasValue(actualApiKey)) {
  const keyLower = actualApiKey.toLowerCase();
  if (actualApiKey.startsWith("ms-")) {
    return "modelscope";
  }
  if (keyLower === "ollama") {
    return "ollama";
  }
  if (keyLower === "vllm") {
    return "vllm";
  }
  if (keyLower === "local") {
    return "local";
  }
}
```

第三层：根据 base URL 猜测：

```ts
const actualBaseUrl = baseUrl ?? this.env.LLM_BASE_URL;
if (hasValue(actualBaseUrl)) {
  const baseUrlLower = actualBaseUrl.toLowerCase();
  if (baseUrlLower.includes("api.openai.com")) {
    return "openai";
  }
  if (baseUrlLower.includes("api.deepseek.com")) {
    return "deepseek";
  }
  if (baseUrlLower.includes("localhost") || baseUrlLower.includes("127.0.0.1")) {
    return "local";
  }
}
```

如果三层都判断不出来，就返回 `"auto"`。`auto` 的含义是：SDK 不知道具体服务商，只能使用通用的 `LLM_API_KEY` 和 `LLM_BASE_URL`。

自动检测不是为了替用户做所有决定，而是为了让常见场景更顺手。真正严肃的生产环境里，仍然建议显式传 `provider`、`baseUrl` 和 `model`。

## 13. 解析 API Key 和 base URL

识别 provider 后，就要把 provider 转成实际的 API Key 和 base URL。这一步放在 `resolveCredentials()` 里。

以 DeepSeek 为例：

```ts
case "deepseek":
  return {
    apiKey: apiKey ?? this.env.DEEPSEEK_API_KEY ?? this.env.LLM_API_KEY,
    baseUrl: baseUrl ?? this.env.LLM_BASE_URL ?? "https://api.deepseek.com",
  };
```

这段代码体现了优先级：

1. 用户显式传入的 `apiKey`、`baseUrl` 优先。
2. provider 专属环境变量其次。
3. 通用环境变量再次。
4. SDK 内置默认 base URL 最后兜底。

Ollama 和本地服务有一点特殊，因为本地服务可能不需要真实 API Key。我们可以给它一个占位值：

```ts
case "ollama":
  return {
    apiKey: apiKey ?? this.env.OLLAMA_API_KEY ?? this.env.LLM_API_KEY ?? "ollama",
    baseUrl: baseUrl ?? this.env.OLLAMA_HOST ?? this.env.LLM_BASE_URL ?? "http://localhost:11434/v1",
  };
```

这样用户本地起了 Ollama 后，可以不配置真实 key，也能创建客户端。

`custom` 和 `auto` 不设置默认地址，因为 SDK 不知道用户的自定义服务在哪里：

```ts
case "custom":
  return {
    apiKey: apiKey ?? this.env.LLM_API_KEY,
    baseUrl: baseUrl ?? this.env.LLM_BASE_URL,
  };
case "auto":
  return {
    apiKey: apiKey ?? this.env.LLM_API_KEY,
    baseUrl: baseUrl ?? this.env.LLM_BASE_URL,
  };
```

这也是为什么构造函数最后要检查 `apiKey` 和 `baseUrl`。如果缺失，就抛出清晰错误。

## 14. 选择默认模型

用户可能只传 provider，不传 model。此时 SDK 应该给一个能工作的默认模型。

这个逻辑放在 `getDefaultModel()`：

```ts
private getDefaultModel(): string {
  switch (this.provider) {
    case "openai":
      return "gpt-3.5-turbo";
    case "deepseek":
      return "deepseek-chat";
    case "qwen":
      return "qwen-plus";
    case "modelscope":
      return "Qwen/Qwen2.5-72B-Instruct";
    case "kimi":
      return "moonshot-v1-8k";
    case "zhipu":
      return "glm-4";
    case "ollama":
      return "llama3.2";
    case "vllm":
      return "meta-llama/Llama-2-7b-chat-hf";
    case "local":
      return "local-model";
    case "custom":
      return this.model || "gpt-3.5-turbo";
    case "auto":
      return "gpt-3.5-turbo";
  }
}
```

默认模型不是永远正确的。不同服务商的模型列表会变化，用户最终应该能通过 `model` 覆盖默认值。SDK 的职责是提供一个合理起点，而不是替代服务商文档。

## 15. 创建真实 OpenAI 兼容客户端

当用户没有传 `client` 时，SDK 要创建真实客户端：

```ts
private createClient(): OpenAICompatibleClient {
  return new OpenAI({
    apiKey: this.apiKey,
    baseURL: this.baseUrl,
    timeout: this.timeout * 1000,
  }) as unknown as OpenAICompatibleClient;
}
```

这里有两个细节：

第一，OpenAI SDK 的参数叫 `baseURL`，不是 `baseUrl`。我们对外暴露 `baseUrl` 是为了符合 TypeScript 常见命名习惯，但传给 OpenAI SDK 时必须使用它要求的字段名。

第二，SDK 内部的 `timeout` 单位是秒，OpenAI SDK 的 `timeout` 单位是毫秒，所以要乘以 `1000`。

## 16. 实现非流式调用 invoke

非流式调用是最容易理解的一种：发出请求，等待完整回答，然后返回字符串。

```ts
async invoke(messages: ChatMessage[], options: Record<string, unknown> = {}): Promise<string> {
  try {
    const temperature = typeof options.temperature === "number" ? options.temperature : this.temperature;
    const maxTokens = typeof options.maxTokens === "number" ? options.maxTokens : this.maxTokens;
    const { temperature: _temperature, maxTokens: _maxTokens, ...restOptions } = options;
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...this.extraOptions,
      ...restOptions,
    });

    if (isAsyncIterable(response)) {
      throw new HelloAgentsException("LLM非流式调用返回了流式响应。");
    }

    return response.choices[0]?.message?.content ?? "";
  } catch (error) {
    throw new HelloAgentsException(`LLM调用失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

执行流程如下：

1. 从本次调用参数里读取 `temperature` 和 `maxTokens`。
2. 如果本次没有传，就使用实例默认值。
3. 调用 `client.chat.completions.create()`。
4. 如果意外拿到流式响应，抛出错误。
5. 从 `choices[0].message.content` 取文本。
6. 如果底层报错，统一包装成 `HelloAgentsException`。

这里把底层错误包装起来，是为了让调用方不用知道底层到底是 OpenAI SDK 报错、网络报错，还是自定义服务报错。对 SDK 用户来说，它都是一次 LLM 调用失败。

## 17. 实现流式调用 think 和 streamInvoke

流式调用适合聊天界面。模型每生成一段内容，就把这一段返回给用户。

```ts
async *think(messages: ChatMessage[], temperature?: number): AsyncGenerator<string> {
  try {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: temperature ?? this.temperature,
      max_tokens: this.maxTokens,
      stream: true,
      ...this.extraOptions,
    });

    if (!isAsyncIterable(response)) {
      throw new HelloAgentsException("LLM流式调用没有返回可迭代响应。");
    }

    for await (const chunk of response) {
      const content = chunk.choices[0]?.delta?.content ?? "";
      if (content) {
        yield content;
      }
    }
  } catch (error) {
    throw new HelloAgentsException(`LLM调用失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

`async *` 表示这是一个异步生成器。调用方可以这样消费：

```ts
for await (const chunk of llm.think([{ role: "user", content: "你好" }])) {
  process.stdout.write(chunk);
}
```

再提供一个更直观的别名：

```ts
streamInvoke(messages: ChatMessage[], options: Record<string, unknown> = {}): AsyncGenerator<string> {
  const temperature = typeof options.temperature === "number" ? options.temperature : undefined;
  return this.think(messages, temperature);
}
```

为什么保留两个名字？

- `think()` 更适合智能体语义，表示“让模型思考并逐段返回”。
- `streamInvoke()` 更适合 SDK 语义，表示“流式调用”。

两个方法底层做同一件事，方便不同使用习惯的用户。

## 18. 导出 SDK 公共 API

核心文件写完后，还不能算 SDK。用户不会直接去找 `src/core/llm.ts`，而是从包入口导入。所以要修改 `src/index.ts`：

```ts
export const version = "0.1.0";

export {
  AgentException,
  ConfigException,
  HelloAgentsException,
  LLMException,
  ToolException,
} from "./core/exceptions.js";
export { Config } from "./core/config.js";
export { HelloAgentsLLM } from "./core/llm.js";
export { Message } from "./core/message.js";

export type { ConfigDict, ConfigOptions } from "./core/config.js";
export type {
  ChatMessage,
  HelloAgentsLLMOptions,
  OpenAICompatibleClient,
  SupportedProvider,
} from "./core/llm.js";
export type { MessageOptions, MessageRole, OpenAIMessage } from "./core/message.js";
```

这里同时导出运行时代码和类型：

- `export { HelloAgentsLLM }` 是运行时导出。
- `export type { HelloAgentsLLMOptions }` 是类型导出。

这个区分很重要。TypeScript 编译后，类型会被擦除，不会出现在运行时 JS 里。

## 19. 例子的验证

SDK 写完后，不要把验证拆成很多零散片段。更好的方式是写一个接近真实业务的完整用例，让读者看到 SDK 在一个小场景里如何被组织起来。

本节只保留一个用例：

```text
examples/01-real-world-usage.mjs
```

这个用例模拟“构建一个可对话的 CLI 助手”。它不是单纯打印一个对象，也不是只 mock 一个响应，而是把本节已经实现的核心能力串起来：

1. 从 `examples/.env` 读取模型配置。
2. 创建 `Config`，保存 SDK 层的默认配置。
3. 创建 `HelloAgentsLLM`，连接 OpenAI 兼容模型服务。
4. 使用 `Message` 构造 system prompt 和用户消息。
5. 使用 `invoke()` 做一次非流式调用。
6. 使用 `streamInvoke()` 做一次流式调用。
7. 把模型回复写回历史记录。
8. 根据 `maxHistoryLength` 裁剪历史。
9. 演示如何捕获 SDK 抛出的异常。

这一个例子足够覆盖本节 SDK 的主要能力，也更接近真实用户会怎么使用 SDK。

### 19.1 准备 examples 子项目

真实用例需要读取 `.env` 文件。Node.js 默认不会自动加载 `.env`，所以 examples 目录里单独准备了一个很小的子项目：

```text
examples/
├── package.json
├── pnpm-lock.yaml
├── .env.example
├── README.md
└── 01-real-world-usage.mjs
```

`examples/package.json` 只需要一个依赖：

```json
{
  "name": "helloagent-js-examples",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "dotenv": "^17.4.2"
  }
}
```

这里把 `dotenv` 放在 examples 子项目里，而不是强行变成 SDK 的运行时依赖。原因是 SDK 本身只负责读取 `process.env`，不负责决定环境变量从哪里加载。真实业务项目可以用 `dotenv`，也可以用部署平台自己的环境变量系统。

安装依赖时，先安装根项目，再安装 examples：

```bash
pnpm install
pnpm build

cd examples
pnpm install
cd ..
```

`pnpm build` 很重要，因为用例从 `../dist/index.js` 导入 SDK。我们验证的是“编译后的 SDK 能不能被普通 JS 项目使用”，而不是直接跑 `src` 里的 TypeScript 源码。

### 19.2 准备 .env 配置

用例会读取 `examples/.env`。为了避免把真实 API Key 提交进仓库，仓库里只放模板：

```bash
cp examples/.env.example examples/.env
```

模板里保留了两类配置。

第一类是通用配置：

```bash
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL_ID=
LLM_TIMEOUT=60
```

如果你使用的是任意 OpenAI 兼容服务，只要它支持 `/chat/completions` 这一类接口，就可以优先填写这几项。

第二类是 provider 专属配置：

```bash
# OpenAI
# OPENAI_API_KEY=

# DeepSeek
# DEEPSEEK_API_KEY=

# 通义千问
# DASHSCOPE_API_KEY=

# Ollama
# OLLAMA_API_KEY=ollama
# OLLAMA_HOST=http://localhost:11434/v1

# vLLM
# VLLM_API_KEY=vllm
# VLLM_HOST=http://localhost:8000/v1
```

provider 专属变量适合自动检测。比如设置了 `DEEPSEEK_API_KEY`，`HelloAgentsLLM` 就可以推断 provider 是 `deepseek`。

当前示例代码里为了避免 shell 里已有的环境变量干扰测试，显式指定了：

```js
const llm = new HelloAgentsLLM({
  provider: "local",
});
```

这意味着默认会走本地 OpenAI 兼容服务，地址是：

```text
http://localhost:8000/v1
```

如果你的本地服务不是这个地址，可以在 `.env` 里设置：

```bash
LLM_API_KEY=local
LLM_BASE_URL=http://localhost:8000/v1
LLM_MODEL_ID=local-model
```

也可以把示例里的 `provider: "local"` 改成其他 provider，例如 `deepseek` 或 `qwen`。

### 19.3 读取 .env 并导入 SDK

用例开头先加载 `.env`：

```js
import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });
```

这段代码做了三件事：

1. 使用 `dotenv` 读取环境变量。
2. 通过 `import.meta.url` 找到当前示例文件所在目录。
3. 明确加载 `examples/.env`，而不是误读项目根目录的 `.env`。

然后从编译产物导入 SDK：

```js
import { HelloAgentsLLM, Message, Config } from "../dist/index.js";
```

这里故意导入 `../dist/index.js`。因为 SDK 用户拿到的不是你的 `src/core/llm.ts`，而是编译后的包入口。examples 应该模拟真实使用方式。

### 19.4 初始化 Config 和 HelloAgentsLLM

接下来创建配置对象：

```js
const config = new Config({
  defaultProvider: "auto",
  temperature: 0.7,
  maxTokens: 40960,
  maxHistoryLength: 50,
});
```

这段配置体现了 SDK 的上层使用习惯：

- `defaultProvider` 表示默认 provider 策略。
- `temperature` 表示生成内容的发散程度。
- `maxTokens` 表示最多生成多少 token。
- `maxHistoryLength` 表示对话历史最多保留多少条。

当前 `Config` 还不会自动注入 `HelloAgentsLLM`，它只是一个配置容器。后续实现 `Agent` 基类时，`Agent` 会更自然地使用它管理历史和默认参数。

然后创建 LLM 客户端：

```js
const llm = new HelloAgentsLLM({
  provider: "local",
});
```

这行代码会触发 `HelloAgentsLLM` 的构造流程：

1. 读取 `process.env`。
2. 确认 provider 是 `local`。
3. 解析本地服务的默认 API Key 和 base URL。
4. 读取模型名。
5. 创建 OpenAI 兼容客户端。

示例随后打印关键信息：

```js
console.log(`🔌 provider : ${llm.provider}`);
console.log(`📍 baseUrl  : ${llm.baseUrl}`);
console.log(`🧠 model    : ${llm.model}\n`);
```

这一步是非常实用的调试习惯。调用模型前先打印 provider、base URL 和 model，可以快速发现配置是否读错。

### 19.5 使用 Message 构建对话历史

接下来创建系统提示词：

```js
const systemPrompt = new Message(
  "你是一个代码审查助手，用中文回答，风格简洁。",
  "system",
);

const history = [systemPrompt];
```

这里没有直接写普通对象，而是使用 `Message` 类。原因是 `Message` 后续可以承载更多信息，例如时间戳、metadata、工具调用来源等。

当真正调用模型时，再统一转换：

```js
history.map((m) => m.toDict())
```

这一步很关键。SDK 内部可以用更丰富的对象管理消息，但发给模型时必须是 OpenAI 兼容格式：

```js
{ role: "system", content: "..." }
```

这种设计能同时兼顾“内部可扩展”和“外部协议兼容”。

### 19.6 验证非流式调用 invoke

非流式调用的代码如下：

```js
history.push(new Message("一行代码解释什么是闭包？", "user"));

const answer = await llm.invoke(history.map((m) => m.toDict()));
console.log("📨 invoke 结果：\n", answer, "\n---\n");

history.push(new Message(answer, "assistant"));
```

这段代码可以拆成四步理解：

1. 用户问题写入历史。
2. 把历史消息转换成模型 API 格式。
3. 调用 `llm.invoke()` 等待完整回复。
4. 把模型回复作为 assistant 消息写回历史。

为什么要把回复也写回历史？

因为对话不是一次性问答。下一轮用户继续提问时，模型需要知道前面发生了什么。现在虽然还没有实现 `Agent` 基类，但这个例子已经展示了 Agent 未来要做的核心事情：管理消息历史。

### 19.7 验证流式调用 streamInvoke

接着做一次流式调用：

```js
history.push(new Message("用 TypeScript 写一个防抖函数。", "user"));

console.log("📨 流式输出：\n");

const stream = llm.streamInvoke(history.map((m) => m.toDict()));

let fullResponse = "";
for await (const chunk of stream) {
  process.stdout.write(chunk);
  fullResponse += chunk;
}
console.log("\n\n---\n");

history.push(new Message(fullResponse, "assistant"));
```

流式调用和非流式调用的最大区别是：结果不是一次性返回字符串，而是逐段返回。

`for await ... of` 是消费异步迭代器的语法：

```js
for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

每收到一个 chunk，就立即写到终端。用户看到的效果类似聊天产品里的“打字机输出”。

同时，示例把每个 chunk 拼成 `fullResponse`：

```js
fullResponse += chunk;
```

这是因为流式输出结束后，我们仍然需要把完整 assistant 回复写回历史。否则下一轮对话就会丢失这次模型回答。

### 19.8 验证历史裁剪和异常处理

对话历史不能无限增长。历史越长，请求越慢，token 成本也越高。所以示例用 `maxHistoryLength` 做一个最小裁剪：

```js
while (history.length > config.maxHistoryLength) {
  history.splice(1, 1);
}
```

这里从索引 `1` 开始删，而不是从 `0` 开始删，是为了保留 system prompt。system prompt 通常定义了助手身份和回答风格，应该尽量保留。

示例最后演示异常捕获：

```js
import { HelloAgentsException } from "../dist/index.js";

try {
  new HelloAgentsLLM({
    provider: "custom",
  });
} catch (err) {
  if (err instanceof HelloAgentsException) {
    console.log("✅ 异常被正确捕获：", err.message);
  }
}
```

`custom` provider 不会自动给默认 API Key 和 base URL。这里故意不传配置，就是为了触发 SDK 的参数校验。

这个测试说明两件事：

1. SDK 在缺少关键配置时会主动失败，而不是等到底层请求时报一个更难理解的网络错误。
2. 调用方可以通过 `instanceof HelloAgentsException` 判断这是 SDK 抛出的异常。

### 19.9 手动验证这个用例

完整验证顺序如下：

```bash
pnpm install
pnpm build
pnpm typecheck

cd examples
pnpm install
cd ..

cp examples/.env.example examples/.env
```

然后编辑 `examples/.env`，填入你的模型服务配置。

如果你已经有本地 OpenAI 兼容服务运行在 `http://localhost:8000/v1`，可以直接运行：

```bash
node examples/01-real-world-usage.mjs
```

如果你的服务地址或 provider 不同，需要先调整 `examples/.env` 或 `examples/01-real-world-usage.mjs` 里的 provider。

运行成功时，你应该看到：

- 当前检测到的 provider、base URL、model。
- `invoke()` 的完整回答。
- `streamInvoke()` 的逐段输出。
- 对话历史条数和最后一条消息预览。
- `custom` provider 缺少配置时的异常捕获结果。

## 20. 当前 SDK 的边界

这一节完成的是一个 LLM SDK 的最小核心。它已经能被导入、能被编译、能读取配置、能创建模型客户端、能非流式和流式调用。

但它还不是完整的 Agent 框架。当前还没有：

- Agent 基类
- 对话历史管理
- 系统提示词组装
- SimpleAgent
- 工具注册表
- 工具调用协议
- ReAct、Reflection、Plan-and-Solve 等 Agent 范式

下一节适合继续实现 `Agent` 基类和 `SimpleAgent`。到那时，我们会把本节的 `HelloAgentsLLM` 当作底层能力，让 Agent 负责更上层的事情：接收用户输入、组装消息、维护历史、调用 LLM、返回回答。

这就是构建框架时最重要的节奏：先做稳定的小地基，再一层一层往上加能力。每一层都能单独运行、单独验证，整个 SDK 才不会变成一团难以理解的代码。
