# 从0构建SDK第2节：实现 Agent 基类、SimpleAgent 和最小工具系统

上一节我们完成了 SDK 的第一层能力：消息、配置、异常和大模型调用。那一层解决的是“如何稳定调用一个 OpenAI 兼容模型”。但只有 LLM 还不能叫 Agent，因为它还缺少三件事：

1. 不能长期保存对话历史。
2. 不能把用户输入、系统提示词、历史消息组织成一次完整上下文。
3. 不能在需要外部能力时调用工具。

这一节我们继续向上搭一层，写出第一个可用的 `SimpleAgent`。完成后，你可以这样使用 SDK：

```ts
import { HelloAgentsLLM, SimpleAgent, Tool, ToolRegistry } from "helloagent-js";

class QuoteCalculatorTool extends Tool {
  constructor() {
    super("quote_calculator", "根据单价、数量和折扣率计算报价。");
  }

  run(parameters) {
    const unitPrice = Number(parameters.unitPrice);
    const quantity = Number(parameters.quantity);
    const discountRate = Number(parameters.discountRate ?? 0);
    const subtotal = unitPrice * quantity;
    const discount = subtotal * discountRate;
    const payable = subtotal - discount;

    return JSON.stringify({ subtotal, discount, payable });
  }

  getParameters() {
    return [
      { name: "unitPrice", type: "number", description: "商品单价", required: true },
      { name: "quantity", type: "integer", description: "购买数量", required: true },
      { name: "discountRate", type: "number", description: "折扣率", required: false, default: 0 },
    ];
  }
}

const llm = new HelloAgentsLLM();
const registry = new ToolRegistry();
registry.registerTool(new QuoteCalculatorTool());

const agent = new SimpleAgent({
  name: "报价助手",
  llm,
  toolRegistry: registry,
  systemPrompt: "你是一个严谨的中文报价助手。需要计算金额时必须先调用工具。",
});

const answer = await agent.run("3 套授权，每套 199 元，给 15% 折扣，应付多少钱？");
console.log(answer);
```

这段代码背后包含了一个完整闭环：Agent 接收用户输入，告诉模型有哪些工具，模型按约定输出工具调用，Agent 解析并执行工具，再把工具结果交给模型生成最终回答。

本节配套代码仓库在 GitHub：<https://github.com/CH0918/HelloAgent-JS/tree/7.4>。你可以先对照文章理解设计，再打开仓库查看完整源码和 examples。

## 1. 本节目标

完成本节后，项目会增加这些能力：

- 新增 `Agent` 基类，统一保存 Agent 名称、LLM、系统提示词、配置和历史消息。
- 新增 `SimpleAgent`，支持普通对话、历史管理和流式运行。
- 新增 `Tool` 抽象，规定一个工具必须如何声明名称、描述、参数和执行逻辑。
- 新增 `ToolRegistry`，负责注册工具、查询工具、生成工具说明。
- `SimpleAgent` 可以把工具说明自动写入 system prompt。
- `SimpleAgent` 可以解析 `[TOOL_CALL:tool_name:parameters]` 格式的工具调用。
- `SimpleAgent` 可以执行工具，并把工具结果放回对话，让 LLM 生成最终回答。
- examples 目录里提供真实模型示例，不使用 mock LLM。

这一节只做 SimpleAgent 用到的工具系统，不做完整内置工具库，不做 OpenAI 原生 function calling，不做 ReAct 推理轨迹。这样学习路径更稳：先理解一个 Agent 的最小运行循环，再扩展更复杂的范式。

## 2. 先看新增目录结构

本节新增和修改的文件如下：

```text
helloagent-js/
├── src/
│   ├── index.ts
│   ├── core/
│   │   ├── agent.ts
│   │   ├── config.ts
│   │   ├── llm.ts
│   │   └── message.ts
│   ├── agents/
│   │   └── simple-agent.ts
│   └── tools/
│       ├── base.ts
│       └── registry.ts
├── examples/
│   ├── 01-real-world-usage.mjs
│   ├── 02-simple-agent-with-tools.mjs
│   └── .env.example
└── teach-doc/
    ├── 01-core-llm-layer.md
    └── 02-simple-agent-with-tools.md
```

每个文件的职责如下：

- `src/core/agent.ts`：Agent 基类。它不实现具体策略，只负责所有 Agent 都共有的状态和历史管理。
- `src/agents/simple-agent.ts`：SimpleAgent 实现。它负责组装消息、调用 LLM、识别工具调用、执行工具、保存历史。
- `src/tools/base.ts`：工具协议。它规定一个工具应该如何暴露名称、描述、参数列表和执行方法。
- `src/tools/registry.ts`：工具注册表。它负责保存工具、查找工具、列出工具、生成工具说明。
- `src/index.ts`：SDK 门面。把新增的 Agent、SimpleAgent、Tool、ToolRegistry 导出给用户。
- `examples/02-simple-agent-with-tools.mjs`：真实使用示例。它读取 `.env`，连接真实模型，注册报价工具，然后运行 Agent。

这里的结构和上一节保持同一个原则：核心抽象放 `core/`，具体 Agent 放 `agents/`，工具系统放 `tools/`。不要把所有东西塞进一个文件，否则后面加 ReAct、Reflection、Plan-and-Solve 时会很难拆。

## 3. 设计一个 Agent 最小闭环

在写代码前，先把一次 Agent 运行拆成清楚的步骤。

没有工具时，流程是：

```text
用户输入
  ↓
Agent 组装 system prompt + 历史消息 + 当前用户消息
  ↓
LLM 返回回答
  ↓
Agent 保存 user/assistant 到历史
  ↓
返回回答
```

有工具时，流程会多一轮：

```text
用户输入
  ↓
Agent 组装 system prompt + 工具说明 + 历史消息 + 当前用户消息
  ↓
LLM 输出工具调用标记
  ↓
Agent 解析工具名和参数
  ↓
ToolRegistry 找到对应工具
  ↓
Tool 执行并返回结果
  ↓
Agent 把工具结果追加到对话
  ↓
LLM 基于工具结果生成最终回答
  ↓
Agent 保存 user/assistant 到历史
  ↓
返回回答
```

这就是本节所有代码服务的目标。只要这条链路跑通，后续更复杂的 Agent 范式都可以在它上面继续扩展。

## 4. 实现 Agent 基类

先写 `src/core/agent.ts`。

为什么先写基类？因为不管未来有多少种 Agent，它们都会需要这些公共信息：

- Agent 的名字。
- Agent 使用哪个 LLM。
- Agent 的 system prompt。
- Agent 的配置对象。
- Agent 的历史消息。

先导入依赖：

```ts
import { Config } from "./config.js";
import type { HelloAgentsLLM } from "./llm.js";
import { Message } from "./message.js";
import type { MessageRole, OpenAIMessage } from "./message.js";
```

注意 `HelloAgentsLLM` 这里用 `import type`。因为 `Agent` 只在类型层面引用它，不需要在运行时导入这个类。TypeScript 编译后会把 type-only import 移除，生成的 JS 更干净。

接着定义构造参数：

```ts
export interface AgentOptions {
  name: string;
  llm: HelloAgentsLLM;
  systemPrompt?: string;
  config?: Config;
}
```

这里 `name` 和 `llm` 是必填的。没有名字，日志和调试时很难知道当前是谁在工作；没有 LLM，Agent 没法生成回答。

`systemPrompt` 和 `config` 是可选的。这样用户可以快速创建一个 Agent，也可以在需要时传入更细的配置。

然后写 `Agent` 类：

```ts
export abstract class Agent {
  readonly name: string;
  readonly llm: HelloAgentsLLM;
  readonly systemPrompt?: string;
  readonly config: Config;

  protected readonly history: Message[];

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.llm = options.llm;
    this.systemPrompt = options.systemPrompt;
    this.config = options.config ?? new Config();
    this.history = [];
  }

  abstract run(inputText: string, options?: Record<string, unknown>): Promise<string>;
}
```

这里有两个设计点。

第一，`Agent` 是 `abstract class`。它不能直接实例化，因为基类不知道“怎么运行”。SimpleAgent、ReActAgent、ReflectionAgent 都会有自己的运行策略，所以 `run()` 只定义方法形状，不在基类里实现。

第二，`history` 是 `protected`。这表示外部用户不能直接访问 `history`，但子类可以使用它。这样既保护了内部状态，又允许 `SimpleAgent` 在组装消息时读取历史。

## 5. 给 Agent 加历史管理

Agent 需要保存对话历史。最基础的三个方法是：

```ts
addMessage(message: Message): void {
  this.history.push(message);
  this.trimHistory();
}

clearHistory(): void {
  this.history.length = 0;
}

getHistory(): Message[] {
  return [...this.history];
}
```

逐个解释。

`addMessage()` 用来添加一条历史。添加后立即调用 `trimHistory()`，避免历史无限增长。

`clearHistory()` 用来清空历史。这里没有重新赋值 `this.history = []`，而是设置 `length = 0`。因为 `history` 被定义成 `readonly`，表示引用本身不变，但数组内容可以修改。

`getHistory()` 返回的是副本 `[...]`，不是内部数组。这样外部代码拿到历史后，即使调用 `push()` 或 `splice()`，也不会修改 Agent 内部状态。

接着写组装基础消息的方法：

```ts
protected buildBaseMessages(systemPrompt?: string): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const message of this.history) {
    messages.push(message.toDict());
  }

  return messages;
}
```

这个方法只负责两件事：

1. 如果有 system prompt，就放在消息数组最前面。
2. 把历史消息转换成 OpenAI 兼容格式。

当前用户输入不要在这里添加，因为不同 Agent 可能对当前输入有不同处理方式。SimpleAgent 会在自己的 `buildMessages()` 里追加当前用户消息。

最后写历史裁剪：

```ts
protected trimHistory(): void {
  const maxHistoryLength = this.config.maxHistoryLength;
  if (this.history.length <= maxHistoryLength) {
    return;
  }

  this.history.splice(0, this.history.length - maxHistoryLength);
}
```

这里的策略很简单：超过最大长度后，从最旧的消息开始删。后续如果要保留 system prompt、按 token 裁剪、做摘要记忆，都可以在这个方法上继续扩展。

## 6. 实现 Tool 参数类型

接下来写 `src/tools/base.ts`。

一个工具需要向 Agent 暴露参数信息。比如报价工具需要 `unitPrice`、`quantity`、`discountRate`。这些参数不仅给人看，也会被写进 system prompt，让模型知道调用工具时应该怎么传参。

先定义支持的参数类型：

```ts
export type ToolParameterType = "string" | "number" | "integer" | "boolean" | "array" | "object";
```

这个类型集合刻意保持简单，和 JSON Schema / OpenAI tools schema 的基础类型接近。现在 SimpleAgent 只做轻量类型转换，所以不需要一上来支持复杂嵌套 schema。

然后定义单个参数：

```ts
export interface ToolParameter {
  name: string;
  type: ToolParameterType;
  description: string;
  required?: boolean;
  default?: unknown;
}
```

字段含义如下：

- `name`：参数名，模型输出工具调用时必须使用这个名字。
- `type`：参数类型，SimpleAgent 会根据它做轻量类型转换。
- `description`：参数说明，会进入工具描述。
- `required`：是否必填。没有写时按必填处理。
- `default`：默认值说明。当前不会自动注入默认值，工具内部需要自己处理默认值。

再定义工具入参和返回值：

```ts
export type ToolParameters = Record<string, unknown>;
export type ToolResult = string | Promise<string>;
```

`ToolParameters` 用 `Record<string, unknown>`，是因为不同工具参数差异很大。框架层只负责传递参数对象，具体字段由工具自己解释。

`ToolResult` 支持同步字符串，也支持 `Promise<string>`。这样简单工具可以直接返回，网络请求类工具也可以异步返回。

## 7. 实现 Tool 抽象类

接着写工具基类：

```ts
export abstract class Tool {
  readonly name: string;
  readonly description: string;
  readonly expandable: boolean;

  constructor(name: string, description: string, expandable = false) {
    this.name = name;
    this.description = description;
    this.expandable = expandable;
  }

  abstract run(parameters: ToolParameters): ToolResult;

  abstract getParameters(): ToolParameter[];
}
```

每个具体工具都必须实现两个方法。

`run()` 是真正执行工具的地方。比如报价工具会在这里计算金额，搜索工具会在这里发起搜索请求，文件工具会在这里读写文件。

`getParameters()` 是工具的参数声明。SimpleAgent 不会读工具内部代码，它只能通过这个方法知道工具需要哪些参数。

我们还给 Tool 加几个辅助方法。

第一个是 `getExpandedTools()`：

```ts
getExpandedTools(): Tool[] | undefined {
  return undefined;
}
```

当前章节不会真正实现“一个工具展开为多个子工具”，但先留下这个接口。`ToolRegistry.registerTool()` 会读取 `expandable` 和 `getExpandedTools()`，后续实现 MemoryTool、RAGTool 这类复合工具时可以继续接上。

第二个是参数验证：

```ts
validateParameters(parameters: ToolParameters): boolean {
  return this.getParameters()
    .filter((parameter) => parameter.required ?? true)
    .every((parameter) => Object.hasOwn(parameters, parameter.name));
}
```

这里的逻辑是：找到所有必填参数，然后检查传入对象里是否都有这些字段。

注意当前 `SimpleAgent` 还没有强制调用 `validateParameters()`。原因是教学阶段先保持执行链路简单，工具内部也会做自己的校验。后续如果要增强鲁棒性，可以在执行工具前统一调用它。

第三个是 `toDict()`：

```ts
toDict(): ToolDict {
  return {
    name: this.name,
    description: this.description,
    parameters: this.getParameters(),
  };
}
```

这个方法方便调试和文档生成。调用方可以把工具转成普通对象查看。

第四个是 `toOpenAISchema()`。虽然当前 `SimpleAgent` 使用文本格式调用工具，但我们先把 OpenAI function calling schema 的转换口子留出来：

```ts
toOpenAISchema(): OpenAIToolSchema {
  const properties: OpenAIToolSchema["function"]["parameters"]["properties"] = {};
  const required: string[] = [];

  for (const parameter of this.getParameters()) {
    const description =
      parameter.default === undefined
        ? parameter.description
        : `${parameter.description} (默认: ${String(parameter.default)})`;

    properties[parameter.name] = {
      type: parameter.type,
      description,
    };

    if (parameter.type === "array") {
      properties[parameter.name].items = { type: "string" };
    }

    if (parameter.required ?? true) {
      required.push(parameter.name);
    }
  }

  return {
    type: "function",
    function: {
      name: this.name,
      description: this.description,
      parameters: {
        type: "object",
        properties,
        required,
      },
    },
  };
}
```

这段代码现在不是 SimpleAgent 的主链路，但它有两个价值：

1. 工具协议更接近真实生产系统，不只是一个临时对象。
2. 后续实现 `FunctionCallAgent` 时，可以直接复用这套工具定义。

## 8. 实现 ToolRegistry

工具定义好了，还需要一个地方统一管理工具。这个文件是 `src/tools/registry.ts`。

先导入类型：

```ts
import type { Tool } from "./base.js";
import type { ToolParameter } from "./base.js";
```

然后定义函数工具类型：

```ts
export type RegisteredFunction = (inputText: string) => string | Promise<string>;

interface FunctionToolInfo {
  description: string;
  func: RegisteredFunction;
}
```

除了继承 `Tool` 的对象工具，我们也允许直接注册一个函数作为工具。这是一个便利入口。比如：

```ts
registry.registerFunction("echo", "原样返回输入", async (input) => input);
```

不过当前 `SimpleAgent.executeToolCall()` 主路径只执行 `Tool` 对象，函数工具主要通过 `ToolRegistry.executeTool()` 使用。后续如果要让 SimpleAgent 也直接执行函数工具，可以在 `executeToolCall()` 里补 `getFunction()` 分支。

接着写注册表类：

```ts
export class ToolRegistry {
  private readonly tools: Map<string, Tool>;
  private readonly functions: Map<string, FunctionToolInfo>;

  constructor() {
    this.tools = new Map();
    this.functions = new Map();
  }
}
```

为什么用 `Map` 而不是普通对象？

- `Map` 的 key 可以明确是字符串。
- `Map` 有清晰的 `set/get/delete/values` API。
- 工具名覆盖、删除、遍历都更直观。

## 9. 注册 Tool 对象

`registerTool()` 是工具注册的核心方法：

```ts
registerTool(tool: Tool, autoExpand = true): void {
  if (autoExpand && tool.expandable) {
    const expandedTools = tool.getExpandedTools();
    if (expandedTools && expandedTools.length > 0) {
      for (const expandedTool of expandedTools) {
        this.tools.set(expandedTool.name, expandedTool);
      }
      return;
    }
  }

  this.tools.set(tool.name, tool);
}
```

这段代码有两条路径。

第一条是普通工具。比如 `QuoteCalculatorTool` 不需要展开，直接保存：

```ts
this.tools.set(tool.name, tool);
```

第二条是可展开工具。比如未来有一个 `memory` 工具，它可能包含 `memory_add`、`memory_search`、`memory_delete` 多个动作。如果 `expandable` 为 `true`，注册表会尝试调用 `getExpandedTools()`，把展开后的子工具逐个注册。

当前 7.4 阶段只实现 SimpleAgent 用到的最小部分，所以不会深入写自动展开逻辑。但提前把接口设计好，后续章节就不用推翻重写。

## 10. 查询、删除和列出工具

注册表还需要提供基础管理能力：

```ts
unregisterTool(name: string): boolean {
  const removedTool = this.tools.delete(name);
  const removedFunction = this.functions.delete(name);
  return removedTool || removedFunction;
}

getTool(name: string): Tool | undefined {
  return this.tools.get(name);
}

listTools(): string[] {
  return [...this.tools.keys(), ...this.functions.keys()];
}

getAllTools(): Tool[] {
  return [...this.tools.values()];
}

clear(): void {
  this.tools.clear();
  this.functions.clear();
}
```

这些方法看起来简单，但它们让 `SimpleAgent` 不需要直接接触 `Map`。Agent 只需要问注册表：

- 有没有某个工具？
- 当前有哪些工具？
- 删除某个工具是否成功？

这样工具存储方式以后即使从 `Map` 改成数据库或远程工具服务，Agent 侧也不用大改。

## 11. 生成工具说明

`SimpleAgent` 要让模型知道有哪些工具。模型看不到 TypeScript 对象，只能看到 prompt 里的文字说明。因此 `ToolRegistry` 需要把工具列表格式化成文本：

```ts
getToolsDescription(): string {
  const descriptions: string[] = [];

  for (const tool of this.tools.values()) {
    const parameters = this.formatParameters(tool.getParameters());
    descriptions.push(
      parameters
        ? `- ${tool.name}: ${tool.description} 参数: ${parameters}`
        : `- ${tool.name}: ${tool.description}`,
    );
  }

  for (const [name, info] of this.functions.entries()) {
    descriptions.push(`- ${name}: ${info.description}`);
  }

  return descriptions.length > 0 ? descriptions.join("\n") : "暂无可用工具";
}
```

其中参数格式化方法是：

```ts
private formatParameters(parameters: ToolParameter[]): string {
  return parameters
    .map((parameter) => {
      const required = parameter.required === false ? "可选" : "必需";
      return `${parameter.name}(${parameter.type}, ${required})`;
    })
    .join(", ");
}
```

比如报价工具的说明会变成类似：

```text
- quote_calculator: 根据单价、数量和折扣率计算报价。适合生成订单金额、折扣金额和应付金额。 参数: unitPrice(number, 必需), quantity(integer, 必需), discountRate(number, 可选)
```

这段文字后面会进入 SimpleAgent 的 system prompt。模型正是通过它知道工具名叫 `quote_calculator`，参数里有 `unitPrice`、`quantity` 和 `discountRate`。

## 12. 实现 SimpleAgent 的构造函数

现在可以写 `src/agents/simple-agent.ts`。

先导入依赖：

```ts
import { Agent } from "../core/agent.js";
import type { AgentOptions } from "../core/agent.js";
import type { ChatMessage } from "../core/llm.js";
import { Message } from "../core/message.js";
import type { ToolParameters, ToolParameterType } from "../tools/base.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/base.js";
```

再定义工具调用解析结果：

```ts
interface ParsedToolCall {
  toolName: string;
  parameters: string;
  original: string;
}
```

这里保留 `original` 很重要。因为模型回复里可能是：

```text
我需要先计算一下。[TOOL_CALL:quote_calculator:unitPrice=199,quantity=3,discountRate=0.15]
```

执行工具后，我们可能希望把工具调用标记从回复文本里移除，只保留“我需要先计算一下。”。所以解析时要保存原始匹配内容。

然后定义构造参数：

```ts
export interface SimpleAgentOptions extends AgentOptions {
  toolRegistry?: ToolRegistry;
  enableToolCalling?: boolean;
}
```

`SimpleAgentOptions` 继承 `AgentOptions`，说明 SimpleAgent 仍然需要 `name`、`llm`、`systemPrompt` 和 `config`。同时它多了两个工具相关参数：

- `toolRegistry`：工具注册表。
- `enableToolCalling`：是否启用工具调用。

接着写类：

```ts
export class SimpleAgent extends Agent {
  private toolRegistry?: ToolRegistry;
  private enableToolCalling: boolean;

  constructor(options: SimpleAgentOptions) {
    super(options);
    this.toolRegistry = options.toolRegistry;
    this.enableToolCalling = (options.enableToolCalling ?? true) && options.toolRegistry !== undefined;
  }
}
```

这里的判断逻辑是：默认启用工具调用，但必须真的传入 `toolRegistry`。如果没有工具注册表，就算 `enableToolCalling` 默认是 `true`，也不会启用工具调用。

## 13. 构建发送给 LLM 的消息

SimpleAgent 需要把 system prompt、工具说明、历史消息和当前输入组装成 LLM 消息：

```ts
private buildMessages(inputText: string): ChatMessage[] {
  return [
    ...this.buildBaseMessages(this.getEnhancedSystemPrompt()),
    {
      role: "user",
      content: inputText,
    },
  ];
}
```

这段代码分两层：

1. `getEnhancedSystemPrompt()` 生成增强版系统提示词。
2. `buildBaseMessages()` 来自 Agent 基类，负责放入 system prompt 和历史消息。

最后追加当前用户输入。

增强版 system prompt 是 SimpleAgent 支持工具调用的关键：

```ts
private getEnhancedSystemPrompt(): string {
  const basePrompt = this.systemPrompt ?? "你是一个有用的AI助手。";

  if (!this.hasTools() || !this.toolRegistry) {
    return basePrompt;
  }

  const toolsDescription = this.toolRegistry.getToolsDescription();
  if (!toolsDescription || toolsDescription === "暂无可用工具") {
    return basePrompt;
  }

  return `${basePrompt}

## 可用工具
你可以使用以下工具来帮助回答问题：
${toolsDescription}

## 工具调用格式
当需要使用工具时，请使用以下格式：
\`[TOOL_CALL:{tool_name}:{parameters}]\`

### 参数格式说明
1. 多个参数：使用 \`key=value\` 格式，用逗号分隔，例如 \`[TOOL_CALL:calculator_multiply:a=12,b=8]\`
2. 单个参数：直接使用 \`key=value\`，例如 \`[TOOL_CALL:search:query=TypeScript]\`
3. 简单查询：可以直接传入文本，例如 \`[TOOL_CALL:search:TypeScript]\`

### 重要提示
- 参数名必须与工具定义的参数名完全匹配
- 数字参数直接写数字，不需要引号
- 工具调用结果会自动插入到对话中，然后你可以基于结果继续回答`;
}
```

这段 prompt 做了三件事：

1. 保留用户传入的基础角色设定。
2. 追加当前可用工具列表。
3. 明确告诉模型工具调用格式。

为什么不用 OpenAI 原生 function calling？

因为本节目标是教学。文本格式可以让你清楚看到模型输出了什么，Agent 如何解析它，又如何把工具结果放回对话。等这条链路理解清楚后，再接原生 function calling 会更容易。

## 14. 判断当前 Agent 是否有工具

SimpleAgent 需要知道是否应该走工具路径：

```ts
hasTools(): boolean {
  return this.enableToolCalling && this.toolRegistry !== undefined && this.toolRegistry.listTools().length > 0;
}
```

必须同时满足三个条件：

1. 工具调用功能是启用的。
2. 有工具注册表。
3. 注册表里至少有一个工具。

如果没有工具，SimpleAgent 就退化成普通对话 Agent。

为了方便后续动态添加工具，还提供：

```ts
addTool(tool: Tool, autoExpand = true): void {
  if (!this.toolRegistry) {
    this.toolRegistry = new ToolRegistry();
  }

  this.toolRegistry.registerTool(tool, autoExpand);
  this.enableToolCalling = true;
}
```

这个方法允许用户先创建一个没有工具的 Agent，然后运行过程中再加工具：

```ts
const agent = new SimpleAgent({ name: "助手", llm });
agent.addTool(new QuoteCalculatorTool());
```

删除和列出工具也很直接：

```ts
removeTool(toolName: string): boolean {
  return this.toolRegistry?.unregisterTool(toolName) ?? false;
}

listTools(): string[] {
  return this.toolRegistry?.listTools() ?? [];
}
```

## 15. 实现 run：无工具路径

`run()` 是 SimpleAgent 的核心方法。先看没有工具时的路径：

```ts
async run(inputText: string, options: SimpleAgentRunOptions = {}): Promise<string> {
  const { maxToolIterations = 3, ...llmOptions } = options;
  const messages = this.buildMessages(inputText);

  if (!this.hasTools()) {
    const response = await this.llm.invoke(messages, llmOptions);
    this.saveTurn(inputText, response);
    return response;
  }

  // 有工具时继续走工具调用循环
}
```

这几行完成了普通对话：

1. 从 options 里取出 `maxToolIterations`，剩下的参数交给 LLM。
2. 调用 `buildMessages()` 组装消息。
3. 如果没有工具，直接 `llm.invoke()`。
4. 保存当前用户输入和模型回复。
5. 返回结果。

保存历史的方法是：

```ts
private saveTurn(inputText: string, response: string): void {
  this.addMessage(new Message(inputText, "user"));
  this.addMessage(new Message(response, "assistant"));
}
```

这里每轮对话保存两条消息：一条 user，一条 assistant。`addMessage()` 来自基类，它会自动裁剪历史长度。

## 16. 实现 run：工具调用循环

有工具时，SimpleAgent 进入一个循环：

```ts
let currentIteration = 0;
let finalResponse = "";

while (currentIteration < maxToolIterations) {
  const response = await this.llm.invoke(messages, llmOptions);
  const toolCalls = this.parseToolCalls(response);

  if (toolCalls.length === 0) {
    finalResponse = response;
    break;
  }

  let cleanResponse = response;
  const toolResults: string[] = [];

  for (const call of toolCalls) {
    cleanResponse = cleanResponse.replace(call.original, "").trim();
    toolResults.push(await this.executeToolCall(call.toolName, call.parameters));
  }

  messages.push({ role: "assistant", content: cleanResponse || response });
  messages.push({
    role: "user",
    content: `工具执行结果：\n${toolResults.join("\n\n")}\n\n请基于这些结果给出完整的回答。`,
  });
  currentIteration += 1;
}
```

这段代码就是工具调用的核心。

第一步，先问 LLM：

```ts
const response = await this.llm.invoke(messages, llmOptions);
```

第二步，检查 LLM 回复里有没有工具调用：

```ts
const toolCalls = this.parseToolCalls(response);
```

如果没有工具调用，说明模型已经给出最终回答：

```ts
if (toolCalls.length === 0) {
  finalResponse = response;
  break;
}
```

如果有工具调用，就逐个执行：

```ts
for (const call of toolCalls) {
  cleanResponse = cleanResponse.replace(call.original, "").trim();
  toolResults.push(await this.executeToolCall(call.toolName, call.parameters));
}
```

这里支持一条回复里出现多个工具调用。每个工具调用都会执行，结果放入 `toolResults`。

执行完工具后，把两条消息追加到当前对话：

```ts
messages.push({ role: "assistant", content: cleanResponse || response });
messages.push({
  role: "user",
  content: `工具执行结果：\n${toolResults.join("\n\n")}\n\n请基于这些结果给出完整的回答。`,
});
```

第一条是模型刚才的回复。第二条是“工具执行结果”。这里我们用 `user` 角色把工具结果喂回去，是为了兼容当前简单消息系统。后续如果要更贴近 OpenAI tool role，可以扩展 `Message` 和 LLM 参数结构。

为什么需要 `maxToolIterations`？

模型可能连续多次请求工具，甚至因为提示词不稳定反复请求同一个工具。如果没有上限，程序可能一直循环。默认最多 3 轮，是一个教学阶段足够安全的限制。

循环结束后，如果还没有最终回答，就再请求一次：

```ts
if (!finalResponse) {
  finalResponse = await this.llm.invoke(messages, llmOptions);
}

this.saveTurn(inputText, finalResponse);
return finalResponse;
```

这保证即使达到工具调用上限，也尽量让模型基于已有工具结果给出一个最终回答。

## 17. 解析工具调用

SimpleAgent 约定工具调用格式为：

```text
[TOOL_CALL:tool_name:parameters]
```

例如：

```text
[TOOL_CALL:quote_calculator:unitPrice=199,quantity=3,discountRate=0.15]
```

解析代码是：

```ts
private parseToolCalls(text: string): ParsedToolCall[] {
  const pattern = /\[TOOL_CALL:([^:\]]+):([^\]]+)\]/g;
  const calls: ParsedToolCall[] = [];

  for (const match of text.matchAll(pattern)) {
    calls.push({
      toolName: match[1]?.trim() ?? "",
      parameters: match[2]?.trim() ?? "",
      original: match[0],
    });
  }

  return calls.filter((call) => call.toolName.length > 0);
}
```

正则分成三部分：

- `TOOL_CALL`：固定前缀。
- `([^:\]]+)`：工具名，不能包含冒号和右方括号。
- `([^\]]+)`：参数文本，直到右方括号结束。

这个格式简单，但有边界：参数里不能直接包含 `]`。教学阶段可以接受。后续如果要支持复杂 JSON、嵌套对象、数组等，可以换成更严格的 parser 或直接使用原生 function calling。

## 18. 执行工具调用

解析出工具名和参数后，下一步是执行：

```ts
private async executeToolCall(toolName: string, parameters: string): Promise<string> {
  if (!this.toolRegistry) {
    return "错误：未配置工具注册表";
  }

  const tool = this.toolRegistry.getTool(toolName);
  if (!tool) {
    return `错误：未找到工具 '${toolName}'`;
  }

  try {
    const parsedParameters = this.parseToolParameters(tool, parameters);
    const result = await tool.run(parsedParameters);
    return `工具 ${toolName} 执行结果：\n${result}`;
  } catch (error) {
    return `工具调用失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
```

这段代码严格按顺序处理：

1. 没有工具注册表，返回错误。
2. 找不到工具，返回错误。
3. 解析参数。
4. 调用工具的 `run()`。
5. 把工具结果包装成一段文本，交给 LLM。

这里没有直接 `throw`，而是返回错误文本。原因是工具调用失败也可以成为模型上下文的一部分。比如模型调用了不存在的工具，Agent 可以把错误告诉模型，让模型重新回答或解释失败原因。

## 19. 解析工具参数

工具参数是模型输出的文本，需要转成对象。

入口方法是：

```ts
private parseToolParameters(tool: Tool, parameters: string): ToolParameters {
  const trimmed = parameters.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as ToolParameters;
      return this.convertParameterTypes(tool, parsed);
    } catch {
      // Falls through to the lightweight key=value parser below.
    }
  }

  if (trimmed.includes("=")) {
    const parsed: ToolParameters = {};
    const pairs = trimmed.split(",");
    for (const pair of pairs) {
      const [key, ...valueParts] = pair.split("=");
      const parameterName = key?.trim();
      if (!parameterName) {
        continue;
      }
      parsed[parameterName] = valueParts.join("=").trim();
    }
    return this.inferAction(tool.name, this.convertParameterTypes(tool, parsed));
  }

  return this.inferSimpleParameters(tool.name, trimmed);
}
```

它支持三种格式。

第一种是 JSON：

```text
[TOOL_CALL:quote_calculator:{"unitPrice":199,"quantity":3,"discountRate":0.15}]
```

如果参数以 `{` 开头，就先尝试 `JSON.parse()`。

第二种是 `key=value`：

```text
[TOOL_CALL:quote_calculator:unitPrice=199,quantity=3,discountRate=0.15]
```

这种格式最适合教学和手写。它会先按逗号分割，再按第一个等号分割。这里使用：

```ts
const [key, ...valueParts] = pair.split("=");
parsed[parameterName] = valueParts.join("=").trim();
```

而不是简单写 `const [key, value] = pair.split("=")`。这样即使值里包含等号，也不会直接丢失后面的内容。

第三种是纯文本：

```text
[TOOL_CALL:search:TypeScript SDK]
```

没有等号时，SimpleAgent 会把它转换成：

```ts
{ input: "TypeScript SDK" }
```

对于 `memory` 和 `rag` 这两个未来常见工具名，还会推断为搜索动作：

```ts
{ action: "search", query: "TypeScript SDK" }
```

## 20. 参数类型转换

模型输出的一切本质上都是文本。比如：

```text
unitPrice=199,quantity=3,discountRate=0.15
```

解析后最初会得到：

```ts
{
  unitPrice: "199",
  quantity: "3",
  discountRate: "0.15"
}
```

但工具希望拿到数字。于是 SimpleAgent 会读取工具的 `getParameters()`，按参数类型转换：

```ts
private convertParameterTypes(tool: Tool, parameters: ToolParameters): ToolParameters {
  const parameterTypes = new Map<string, ToolParameterType>();
  for (const parameter of tool.getParameters()) {
    parameterTypes.set(parameter.name, parameter.type);
  }

  const converted: ToolParameters = {};
  for (const [key, value] of Object.entries(parameters)) {
    const parameterType = parameterTypes.get(key);
    converted[key] = this.convertValue(value, parameterType);
  }

  return converted;
}
```

具体转换逻辑是：

```ts
private convertValue(value: unknown, parameterType: ToolParameterType | undefined): unknown {
  if (typeof value !== "string" || parameterType === undefined) {
    return value;
  }

  switch (parameterType) {
    case "number": {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    case "integer": {
      const parsed = Number(value);
      return Number.isInteger(parsed) ? parsed : value;
    }
    case "boolean":
      return ["true", "1", "yes"].includes(value.toLowerCase());
    case "array":
      return value.split("|").map((item) => item.trim());
    case "object":
    case "string":
      return value;
  }
}
```

这里有两个务实选择。

第一，转换失败就保留原值。比如 `quantity=三` 不能转成 integer，那就仍然传 `"三"` 给工具，由工具自己返回参数错误。

第二，数组用 `|` 分隔，而不是逗号。因为逗号已经用于分隔多个参数。比如：

```text
tags=agent|tool|typescript
```

会转换成：

```ts
["agent", "tool", "typescript"]
```

## 21. 为什么有 inferAction

代码里有两个轻量推断方法：

```ts
private inferAction(toolName: string, parameters: ToolParameters): ToolParameters {
  if (toolName === "memory") {
    return this.inferMemoryAction(parameters);
  }

  if (toolName === "rag") {
    return this.inferRagAction(parameters);
  }

  return parameters;
}
```

当前报价工具用不到它，但保留这个逻辑是为了后续章节的记忆和 RAG 工具。

比如模型输出：

```text
[TOOL_CALL:memory:recall=用户喜欢的编程语言]
```

可以推断成：

```ts
{
  action: "search",
  query: "用户喜欢的编程语言"
}
```

这样 prompt 可以更自然，工具执行参数也更规范。

不过这只是最小便利逻辑，不是完整工具规划系统。真正复杂的工具选择和参数生成，后续可以交给 ReActAgent 或 FunctionCallAgent。

## 22. 实现 streamRun

除了普通 `run()`，SimpleAgent 也提供流式运行：

```ts
async *streamRun(inputText: string, options: Record<string, unknown> = {}): AsyncGenerator<string> {
  const messages = this.buildMessages(inputText);
  let fullResponse = "";

  for await (const chunk of this.llm.streamInvoke(messages, options)) {
    fullResponse += chunk;
    yield chunk;
  }

  this.saveTurn(inputText, fullResponse);
}
```

这段代码和上一节的 `streamInvoke()` 用法一致：

1. 组装消息。
2. 调用 LLM 的流式接口。
3. 每拿到一个 chunk 就 `yield` 给调用方。
4. 同时拼出完整回复。
5. 流结束后保存历史。

当前 `streamRun()` 没有处理工具调用。原因是流式工具调用会涉及“边流式输出边检测完整工具标记”的问题，需要更复杂的状态机。为了保持 7.4 阶段清晰，我们先让流式运行只覆盖普通对话。

## 23. 导出 SDK 公共 API

写完新模块后，需要更新 `src/index.ts`。用户不应该从内部路径导入：

```ts
import { SimpleAgent } from "helloagent-js/dist/agents/simple-agent.js";
```

更好的方式是从 SDK 门面导入：

```ts
import { SimpleAgent, Tool, ToolRegistry } from "helloagent-js";
```

所以在 `src/index.ts` 里新增运行时导出：

```ts
export { Agent } from "./core/agent.js";
export { SimpleAgent } from "./agents/simple-agent.js";
export { Tool } from "./tools/base.js";
export { ToolRegistry, globalRegistry } from "./tools/registry.js";
```

再新增类型导出：

```ts
export type { AgentOptions } from "./core/agent.js";
export type { SimpleAgentOptions, SimpleAgentRunOptions } from "./agents/simple-agent.js";
export type {
  OpenAIToolSchema,
  ToolDict,
  ToolParameter,
  ToolParameters,
  ToolParameterType,
  ToolResult,
} from "./tools/base.js";
export type { RegisteredFunction } from "./tools/registry.js";
```

运行时导出和类型导出分开写，是为了让编译后的 JS 更准确。类型只存在于 TypeScript 编译阶段，不应该变成运行时代码。

## 24. 写一个真实的业务工具

现在看 `examples/02-simple-agent-with-tools.mjs`。

这个示例不是 mock，而是读取真实 `.env`，使用真实 LLM。示例场景是一个报价助手：用户给出商品单价、数量、折扣，Agent 必须调用工具计算金额。

先加载环境变量：

```js
import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });
```

然后导入 SDK：

```js
import { Config, HelloAgentsLLM, SimpleAgent, Tool, ToolRegistry } from "../dist/index.js";
```

因为 examples 运行的是编译产物，所以需要先执行：

```bash
pnpm build
```

再运行 example。

报价工具这样写：

```js
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
```

这里故意返回 JSON 字符串，而不是一段自然语言。原因是工具应该尽量返回结构化事实，让 LLM 负责解释给用户听。工具负责“算准”，LLM 负责“说清楚”。

## 25. 注册工具并创建 Agent

初始化配置和 LLM：

```js
const config = new Config({
  temperature: 0.2,
  maxTokens: 4096,
  maxHistoryLength: 20,
});

const llm = new HelloAgentsLLM({
  temperature: config.temperature,
  maxTokens: config.maxTokens,
});
```

这里没有显式写 provider。`HelloAgentsLLM` 会根据 `.env` 自动识别。你可以使用通用变量：

```bash
LLM_API_KEY=your-api-key
LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
LLM_MODEL_ID=your-model
```

也可以使用 provider 专属变量，例如：

```bash
DEEPSEEK_API_KEY=your-key
```

接着注册工具：

```js
const registry = new ToolRegistry();
registry.registerTool(new QuoteCalculatorTool());
```

然后创建 Agent：

```js
const agent = new SimpleAgent({
  name: "报价助手",
  llm,
  config,
  toolRegistry: registry,
  systemPrompt:
    "你是一个严谨的中文报价助手。遇到金额、折扣、总价、应付金额计算时，必须先调用 quote_calculator 工具，不要心算。拿到工具结果后，用简洁中文解释小计、折扣和最终应付金额。",
});
```

这段 system prompt 很重要。因为当前 SimpleAgent 使用文本工具调用协议，而不是 API 级 function calling。模型是否愿意按格式调用工具，很大程度取决于 prompt 是否明确。

这里我们写了两个约束：

1. 遇到金额、折扣、总价、应付金额计算时，必须先调用工具。
2. 拿到工具结果后，再用中文解释小计、折扣和应付金额。

## 26. 运行一次真实 Agent 调用

用户输入是：

```js
const userInput =
  "客户要买 3 套团队版授权，每套 199 元，现在给 15% 折扣。请帮我算出小计、折扣金额和最终应付金额。请先调用 quote_calculator 工具。";
```

然后调用 Agent：

```js
const answer = await agent.run(userInput, {
  maxToolIterations: 3,
});

console.log("🤖 Agent 回复：\n", answer, "\n");
console.log(`📋 历史消息数：${agent.getHistory().length}`);
```

理想情况下，模型第一轮会输出：

```text
[TOOL_CALL:quote_calculator:unitPrice=199,quantity=3,discountRate=0.15]
```

SimpleAgent 执行工具后，会把下面这类结果交回给模型：

```json
{
  "unitPrice": 199,
  "quantity": 3,
  "discountRate": 0.15,
  "subtotal": 597,
  "discount": 89.55,
  "payable": 507.45
}
```

最终模型应该用自然语言回复类似：

```text
小计为 597 元，15% 折扣金额为 89.55 元，最终应付 507.45 元。
```

如果模型没有按格式调用工具，SimpleAgent 会把它当普通回答返回。这是文本协议的天然限制。后续如果要让工具调用更稳定，可以实现 `FunctionCallAgent`，使用模型 API 原生工具调用能力。

## 27. 运行验证

先安装和构建：

```bash
pnpm install
pnpm build
```

再准备 examples 依赖：

```bash
cd examples
pnpm install
cd ..
```

复制环境变量模板：

```bash
cp examples/.env.example examples/.env
```

编辑 `examples/.env`，填入真实模型配置。

运行 02 示例：

```bash
node examples/02-simple-agent-with-tools.mjs
```

运行时你会看到：

- 当前识别到的 provider。
- 当前使用的 baseUrl。
- 当前使用的 model。
- 已注册工具 `quote_calculator`。
- 用户输入。
- Agent 最终回复。
- 历史消息数。

如果 `HelloAgentsLLM` 报缺少 API Key 或 baseUrl，说明 `.env` 没有被正确填写，或者 provider 自动检测没有命中。可以先用通用变量 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL_ID` 验证。

## 28. 本节实现的边界

到这里，我们已经有了一个真正可运行的 SimpleAgent，但它仍然是教学阶段的最小实现。

当前已经实现：

- Agent 基类。
- 历史消息管理。
- SimpleAgent 普通对话。
- SimpleAgent 工具调用循环。
- Tool 抽象。
- ToolRegistry 注册和查询。
- 文本格式工具调用。
- 真实模型 examples。

当前还没有实现：

- 内置工具库。
- 复杂参数 schema 校验。
- OpenAI 原生 function calling。
- 流式工具调用。
- ReAct 推理轨迹。
- Memory、RAG、MCP 等高级工具。
- 工具调用日志和可观测性。

这个边界是有意保留的。一个好的框架不是一开始堆满所有功能，而是先让核心链路清晰、能运行、能解释。SimpleAgent 的职责就是把“用户输入、上下文、LLM、工具、历史”这五件事串起来。

下一节可以在这个基础上继续扩展：要么实现更稳定的 function calling Agent，要么开始实现内置工具，例如 calculator、search、filesystem。无论走哪条路，今天写好的 `Agent`、`Tool` 和 `ToolRegistry` 都会继续复用。
