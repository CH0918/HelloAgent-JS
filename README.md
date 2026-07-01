# HelloAgent-JS

JavaScript version of the Hello Agents LLM client.

## Setup

```bash
npm install
cp .env.example .env
```

Then fill in `.env`:

```env
LLM_MODEL_ID=your-model-id
LLM_API_KEY=your-api-key
LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
LLM_TIMEOUT=60
MODELSCOPE_API_KEY=your-modelscope-api-key
EVOLINK_API_KEY=your-evolink-api-key
OLLAMA_API_KEY=ollama
```

## Run

```bash
npm start
```

Run the local Ollama example:

```bash
pnpm example:ollama
```

## Custom Providers

```ts
import { MyLLM } from "./src/my-llm.js";

const modelscopeLLM = new MyLLM({
  provider: "modelscope",
});

const evolinkLLM = new MyLLM({
  provider: "evolink",
  model: "your-evolink-model-id",
});

const ollamaLLM = new MyLLM({
  provider: "ollama",
});
```

`MyLLM` extends `HelloAgentsLLM`. When `provider` is `modelscope`, it reads
`MODELSCOPE_API_KEY`, uses
`https://api-inference.modelscope.cn/v1/`, and defaults to
`Qwen/Qwen2.5-VL-72B-Instruct`.

When `provider` is `evolink`, it reads `EVOLINK_API_KEY` and uses
`https://direct.evolink.ai/v1` by default.

When `provider` is `ollama`, it uses the local OpenAI-compatible Ollama
endpoint `http://localhost:11434/v1`, defaults to `qwen3:8b`, and does not
require a real API key. You can override the model and endpoint with `model`
and `baseUrl`.

## 7.3 框架接口实现

在前面的实现中，我们已经构建了 `HelloAgentsLLM` 这一核心组件，解决了与大语言模型通信的关键问题。它负责把消息发送给 OpenAI 兼容接口，并以流式方式收集模型返回的内容。不过，一个可扩展的智能体框架不能只有模型调用层。上层应用还需要统一的消息格式、集中化的配置对象，以及一个能够约束不同智能体实现方式的基类。

因此，本节在 TypeScript 版本中补充了三个基础文件：

- `src/message.ts`：定义框架内统一的消息格式，让智能体、模型调用层和后续上下文工程使用同一种消息对象。
- `src/config.ts`：提供中心化配置管理，把默认模型、温度、日志级别、历史记录长度等参数从业务代码中抽离出来。
- `src/agent.ts`：定义所有智能体的抽象基类 `Agent`，为后续实现 `SimpleAgent`、`ReActAgent` 等不同类型的智能体提供统一接口。

这三个文件的定位可以概括为：`Message` 负责规范数据，`Config` 负责管理运行参数，`Agent` 负责定义智能体的统一行为边界。它们本身并不承担复杂推理逻辑，而是为后续章节中的智能体实现打下稳定的结构基础。

### 7.3.1 Message 类

在智能体与大语言模型的交互过程中，对话历史是非常重要的上下文。用户输入、系统提示词、模型回复、工具调用结果，本质上都可以被抽象成一条条消息。如果每个模块都直接使用普通对象，很容易出现字段不统一、角色名写错、日志信息无法补充等问题。

为了解决这个问题，`src/message.ts` 中定义了一个简洁的 `Message` 类：

```ts
type MessageRole = "user" | "assistant" | "system" | "tool";

class Message {
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

  toDict(): OpenAIMessageDict {
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

这里最关键的是 `MessageRole` 类型。它将消息角色限制为 `"user"`、`"assistant"`、`"system"`、`"tool"` 四种取值，对应 OpenAI Chat Completions API 中常见的消息角色。这样做可以在 TypeScript 编译阶段提前发现错误，例如把 `"users"` 或 `"bot"` 误写成角色名时，编辑器和类型检查都会立即提示。

除了 `content` 和 `role` 这两个核心字段，`Message` 还保留了 `timestamp` 和 `metadata`。`timestamp` 用于记录消息创建时间，方便后续调试、日志追踪或展示对话历史；`metadata` 则用于承载扩展信息，例如工具调用 ID、检索来源、token 统计或其他业务上下文。也就是说，框架内部可以保留更丰富的信息，但发送给模型时只暴露模型真正需要的字段。

`toDict()` 方法承担了这个转换职责。它会把内部的 `Message` 对象转换成 OpenAI API 兼容的普通对象：

```ts
const message = new Message("你好，请介绍一下你自己", "user");

message.toDict();
// { role: "user", content: "你好，请介绍一下你自己" }
```

这个设计体现的是“对内丰富，对外兼容”的原则。框架内部可以逐步扩展消息对象，而不会影响底层模型接口所要求的数据格式。

### 7.3.2 Config 类

随着框架功能增加，配置项也会逐渐变多。如果这些参数散落在不同文件中，上层应用在切换模型、调整温度、开启调试模式时就会变得很不方便。`Config` 类的职责，就是把这些运行参数集中起来，并支持从环境变量中读取。

`src/config.ts` 中的配置项按用途分为三类：

- LLM 配置：`defaultModel`、`defaultProvider`、`temperature`、`maxTokens`
- 系统配置：`debug`、`logLevel`
- 框架配置：`maxHistoryLength`

核心实现如下：

```ts
class Config {
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
}
```

这些默认值让框架在零配置状态下也有一个明确的运行行为。例如，如果使用者没有显式指定 `temperature`，框架会使用 `0.7`；如果没有设置历史记录长度，默认最多保留 `100` 条消息。默认值并不意味着固定不可变，而是为初学者和示例代码提供一个稳定的起点。

更重要的是 `fromEnv()` 方法。它允许使用者通过环境变量覆盖默认配置，而不需要修改源码：

```ts
const config = Config.fromEnv();
```

当前支持的环境变量包括：

```env
LLM_MODEL_ID=gpt-4o-mini
LLM_PROVIDER=openai
TEMPERATURE=0.7
MAX_TOKENS=1024
DEBUG=false
LOG_LEVEL=INFO
MAX_HISTORY_LENGTH=100
```

这在部署到不同环境时尤其有用。比如本地开发时可以使用本地模型或测试模型，线上部署时再通过环境变量切换为生产模型。业务代码只依赖 `Config` 对象，不需要关心配置来源是默认值、构造参数，还是环境变量。

`toDict()` 方法则用于把配置对象转换成普通对象，方便日志输出、调试检查或后续序列化：

```ts
const config = new Config({ temperature: 0.2, debug: true });

config.toDict();
// {
//   defaultModel: "gpt-3.5-turbo",
//   defaultProvider: "openai",
//   temperature: 0.2,
//   maxTokens: undefined,
//   debug: true,
//   logLevel: "INFO",
//   maxHistoryLength: 100
// }
```

### 7.3.3 Agent 抽象基类

`Agent` 是整个框架的顶层抽象。它并不负责规定某一种具体的智能体应该如何推理，也不直接决定是否使用工具、是否使用规划、是否使用 ReAct 流程。它的作用是定义一个智能体至少应该具备哪些共同属性和行为。

在 TypeScript 中，我们使用 `abstract class` 来表达这个抽象：

```ts
abstract class Agent {
  readonly name: string;
  readonly llm: HelloAgentsLLM;
  readonly systemPrompt?: string;
  readonly config: Config;
  protected readonly history: Message[] = [];

  constructor(
    name: string,
    llm: HelloAgentsLLM,
    systemPrompt?: string,
    config: Config = new Config(),
  ) {
    this.name = name;
    this.llm = llm;
    this.systemPrompt = systemPrompt;
    this.config = config;
  }

  abstract run(inputText: string, options?: Record<string, unknown>): Promise<string> | string;
}
```

构造函数清晰地声明了一个 Agent 的核心依赖：

- `name`：智能体名称，便于日志、调试和展示。
- `llm`：底层大语言模型客户端，当前使用 `HelloAgentsLLM`。
- `systemPrompt`：可选的系统提示词，用于定义智能体身份、规则或行为边界。
- `config`：配置对象，用于控制温度、历史记录长度、日志级别等参数。

其中最重要的是 `run()` 方法。它被声明为抽象方法，意味着 `Agent` 本身不能直接实例化，所有子类都必须实现自己的运行逻辑。这样做可以保证不同智能体拥有统一的执行入口。例如，后续章节可以实现一个最简单的 `SimpleAgent`：

```ts
class SimpleAgent extends Agent {
  async run(inputText: string): Promise<string> {
    const userMessage = new Message(inputText, "user");
    this.addMessage(userMessage);

    const messages = this.getHistory()
      .filter((message) => message.role !== "tool")
      .map((message) => message.toDict());

    const response = await this.llm.think(
      messages,
      this.config.temperature,
    );

    const output = response ?? "";
    this.addMessage(new Message(output, "assistant"));
    return output;
  }
}
```

这段示例展示了三个基础组件之间的协作关系：用户输入先被封装为 `Message`，然后加入 `Agent` 的历史记录；调用模型时，通过 `toDict()` 转换成 OpenAI 兼容格式；模型调用使用 `Config` 中的温度参数；最后，模型回复也被封装为 `Message` 并写回历史记录。

除了抽象入口，`Agent` 基类还提供了通用的历史记录管理方法：

```ts
addMessage(message: Message): void
clearHistory(): void
getHistory(): Message[]
```

这些方法让不同智能体不必重复实现基础的对话历史管理逻辑。`getHistory()` 返回的是历史数组副本，而不是内部数组本身，这样可以避免外部代码直接修改 `Agent` 内部状态。这个细节虽然简单，但对于后续构建更复杂的上下文管理机制很重要。

`toString()` 方法则用于输出便于调试的描述信息：

```ts
Agent(name=assistant, provider=openai-compatible)
```

当后续引入多个 Agent、多种 Provider 或更复杂的编排流程时，这类字符串表示可以帮助我们快速定位当前正在运行的是哪个智能体，以及它使用的模型服务来源。

### 7.3.4 统一导出

为了让这些基础接口可以被上层应用直接使用，`src/index.ts` 中已经补充了统一导出：

```ts
export { Agent } from "./agent.js";
export { Config } from "./config.js";
export { Message } from "./message.js";
export type { ConfigOptions } from "./config.js";
export type { MessageOptions, MessageRole, OpenAIMessageDict } from "./message.js";
```

这样，使用者既可以从具体文件导入，也可以从框架入口导入：

```ts
import { Agent, Config, HelloAgentsLLM, Message } from "./src/index.js";
```

至此，`HelloAgent-JS` 已经具备了一个智能体框架所需的基础接口层：`HelloAgentsLLM` 负责模型通信，`Message` 负责消息表示，`Config` 负责配置管理，`Agent` 负责定义智能体统一规范。后续无论是实现简单问答 Agent，还是实现带工具调用和推理循环的 ReAct Agent，都可以在这套基础结构之上继续扩展。
