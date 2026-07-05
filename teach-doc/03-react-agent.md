# 从0构建SDK第3节：实现 ReActAgent 的推理与行动循环

上一节我们实现了 `SimpleAgent`。它已经能做三件重要的事：

1. 把用户输入、系统提示词和历史消息组装起来。
2. 把工具说明交给模型。
3. 解析 `[TOOL_CALL:tool_name:parameters]`，执行工具，再让模型基于工具结果回答。

这一节继续往前走，实现一个更经典的 Agent 范式：`ReActAgent`。

ReAct 的名字来自 Reasoning and Acting，也就是“推理”和“行动”结合。它不是让模型一次性给出完整答案，而是要求模型每一步都先写出自己的分析，再选择一个行动，拿到观察结果后继续下一步。这个循环通常写成：

```text
Thought -> Action -> Observation -> Thought -> Action -> Observation -> ... -> Finish
```

完成本节后，你可以这样使用 SDK：

```ts
import { HelloAgentsLLM, ReActAgent, Tool, ToolRegistry } from "helloagent-js";

class QuoteCalculatorTool extends Tool {
  constructor() {
    super("quote_calculator", "根据商品单价、数量和折扣率计算报价。");
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

const agent = new ReActAgent({
  name: "ReAct报价助手",
  llm,
  toolRegistry: registry,
  maxSteps: 4,
  systemPrompt: "涉及金额计算时必须调用 quote_calculator，不要心算。",
});

const answer = await agent.run("3 套授权，每套 199 元，15% 折扣，应付多少钱？");
console.log(answer);
console.log(agent.getScratchpad());
```

这段代码背后的流程是：模型先输出 `Thought` 和 `Action`，Agent 解析 `Action`，执行 `quote_calculator`，把结果作为 `Observation` 放回执行历史，然后再次询问模型。模型有足够信息后输出 `Action: Finish[...]`，Agent 取出最终答案并保存到历史消息。

## 1. 本节目标

本节要新增这些能力：

- 新增 `src/tools/executor.ts`，把工具参数解析和工具执行抽成公共函数。
- 让 `SimpleAgent` 和 `ReActAgent` 共用同一套工具执行规则。
- 新增 `src/agents/react-agent.ts`，实现 `ReActAgent`。
- 支持默认 ReAct prompt，也支持用户传入 `customPrompt`。
- 支持 `Thought:` 和 `Action:` 的解析。
- 支持 `Action: tool_name[input]` 调用工具。
- 支持 `Action: Finish[最终答案]` 结束任务。
- 支持 `maxSteps`，防止模型一直循环。
- 支持 `onStep`，在每一步解析出 Thought、Action、Observation、Finish 或错误时，把内部事件回调给调用层。
- 提供 `getScratchpad()` 查看本次 ReAct 执行轨迹。
- 在 `examples/03-react-agent.mjs` 中提供真实模型运行示例：连续多轮 `agent.run()`，并把内部执行过程转换成用户可见进度。

这一节仍然不做 OpenAI 原生 function calling，也不做多工具并行调用。原因很简单：我们现在的目标是理解 ReAct 范式本身。先把文本协议、工具执行、观察结果回填跑通，再考虑更高级的模型原生工具调用能力。

## 2. 本节目录结构

本节新增和修改的文件如下：

```text
helloagent-js/
├── src/
│   ├── index.ts
│   ├── agents/
│   │   ├── simple-agent.ts
│   │   └── react-agent.ts
│   └── tools/
│       ├── base.ts
│       ├── executor.ts
│       └── registry.ts
├── examples/
│   ├── README.md
│   ├── 02-simple-agent-with-tools.mjs
│   └── 03-react-agent.mjs
└── teach-doc/
    ├── 02-simple-agent-with-tools.md
    └── 03-react-agent.md
```

每个文件的职责如下：

- `src/tools/executor.ts`：工具执行器。它负责把模型输出的参数字符串转成工具需要的对象，然后调用 `ToolRegistry` 中的工具或函数。
- `src/agents/simple-agent.ts`：继续负责简单工具调用 Agent，但工具执行逻辑改为复用 `executeRegisteredTool()`。
- `src/agents/react-agent.ts`：ReActAgent 的主体。它负责构造 ReAct prompt、解析 Thought/Action、执行工具、维护本轮 scratchpad、保存最终历史。
- `src/index.ts`：SDK 统一出口。把 `ReActAgent`、`ReActAgentOptions`、`ReActAgentRunOptions`、`executeRegisteredTool` 和 `parseToolParameters` 导出。
- `examples/03-react-agent.mjs`：真实运行示例。读取 `examples/.env`，初始化真实 LLM，注册多个报价相关工具，连续调用多轮 `agent.run()`，并把内部 ReAct 事件转换成页面可见的业务进度。

## 3. 为什么先抽 `tools/executor.ts`

在实现 `ReActAgent` 前，先看一个容易踩坑的问题。

`SimpleAgent` 已经有工具调用能力，它能把这样的文本：

```text
[TOOL_CALL:quote_calculator:unitPrice=199,quantity=3,discountRate=0.15]
```

解析成：

```ts
{
  unitPrice: 199,
  quantity: 3,
  discountRate: 0.15
}
```

而 ReActAgent 里的 Action 会更像这样：

```text
Action: quote_calculator[unitPrice=199,quantity=3,discountRate=0.15]
```

虽然外层格式不一样，但真正执行工具时，内部参数解析规则应该一致。如果 `SimpleAgent` 和 `ReActAgent` 各写一套解析逻辑，后续就会出现一个 Agent 支持 JSON 参数，另一个不支持；一个 Agent 能把 `quantity` 转成整数，另一个只传字符串。这种分叉会让框架越来越难维护。

所以我们新增 `src/tools/executor.ts`，把“字符串参数 -> 工具参数对象 -> 执行工具”抽出来。

先看入口函数：

```ts
export async function executeRegisteredTool(
  registry: ToolRegistry,
  toolName: string,
  parameters: string,
): Promise<string> {
  const tool = registry.getTool(toolName);
  if (tool) {
    try {
      const parsedParameters = parseToolParameters(tool, parameters);
      const result = await tool.run(parsedParameters);
      return String(result);
    } catch (error) {
      return `工具调用失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const func = registry.getFunction(toolName);
  if (func) {
    try {
      return await func(parameters);
    } catch (error) {
      return `工具调用失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return `错误：未找到工具 '${toolName}'`;
}
```

这段代码做了三层判断：

1. 先看 `ToolRegistry` 里有没有同名 `Tool` 对象。
2. 如果有，就按工具的 `getParameters()` 声明解析参数类型，再调用 `tool.run()`。
3. 如果没有 `Tool` 对象，再看有没有通过 `registerFunction()` 注册的普通函数。
4. 如果都没有，返回清晰的错误字符串。

这里没有抛异常给 Agent。原因是工具调用失败也是一种 Observation，Agent 可以把错误信息交回模型，让模型尝试修正 Action。

## 4. 工具参数如何解析

`parseToolParameters()` 支持三种输入。

第一种是 JSON：

```text
{"unitPrice":199,"quantity":3,"discountRate":0.15}
```

代码会先尝试 `JSON.parse()`：

```ts
if (trimmed.startsWith("{")) {
  try {
    const parsed = JSON.parse(trimmed) as ToolParameters;
    return convertParameterTypes(tool, parsed);
  } catch {
    // Falls through to the lightweight key=value parser below.
  }
}
```

如果 JSON 解析失败，不直接终止，而是继续走后面的轻量解析。这是为了容忍模型偶尔输出不完整 JSON 的情况。

第二种是 `key=value`：

```text
unitPrice=199,quantity=3,discountRate=0.15
```

代码会按逗号切开，再按等号拆出参数名和参数值：

```ts
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
  return inferAction(tool.name, convertParameterTypes(tool, parsed));
}
```

这里的 `valueParts.join("=")` 是一个小细节。它允许值里继续出现等号，避免 `a=b=c` 被截断成只剩 `b`。

第三种是简单字符串：

```text
TypeScript Agent 框架
```

这种输入会转成：

```ts
{ input: "TypeScript Agent 框架" }
```

对 `memory` 和 `rag` 这种工具，代码会做一个轻量推断，把简单字符串转成搜索动作：

```ts
function inferSimpleParameters(toolName: string, parameters: string): ToolParameters {
  if (toolName === "rag" || toolName === "memory") {
    return { action: "search", query: parameters };
  }

  return { input: parameters };
}
```

这个推断不是 ReActAgent 独有的，它属于工具执行层，所以放在 `executor.ts` 里。

## 5. 实现 ReActAgent 的构造参数

`src/agents/react-agent.ts` 里先定义默认提示词：

```ts
export const DEFAULT_REACT_PROMPT = `你是一个具备推理和行动能力的AI助手。你可以通过思考分析问题，然后调用合适的工具来获取信息，最终给出准确的答案。

## 可用工具
{tools}

## 工作流程
请严格按照以下格式进行回应，每次只能执行一个步骤：

Thought: 分析当前问题，思考需要什么信息或采取什么行动。
Action: 选择一个行动，格式必须是以下之一：
- \`{tool_name}[{tool_input}]\`：调用指定工具。
- \`Finish[最终答案]\`：当你有足够信息给出最终答案时。

## 当前任务
Question: {question}

## 执行历史
{history}

现在开始你的推理和行动：`;
```

这个模板里有三个占位符：

- `{tools}`：当前注册的工具说明，由 `ToolRegistry.getToolsDescription()` 生成。
- `{question}`：当前用户问题。
- `{history}`：本次 ReAct 循环里的 Thought、Action、Observation 轨迹。

然后定义构造参数：

```ts
export interface ReActAgentOptions extends AgentOptions {
  toolRegistry?: ToolRegistry;
  maxSteps?: number;
  customPrompt?: string;
}
```

这里继承了 `AgentOptions`，所以 `ReActAgent` 天然拥有 `name`、`llm`、`systemPrompt` 和 `config`。新增的三个字段分别是：

- `toolRegistry`：工具注册表。如果用户不传，就创建一个空注册表。
- `maxSteps`：最多执行多少步 ReAct 循环，默认是 5。
- `customPrompt`：自定义 ReAct 模板。如果业务场景需要更强约束，可以替换默认模板。

类的初始化代码如下：

```ts
export class ReActAgent extends Agent {
  readonly toolRegistry: ToolRegistry;
  private readonly maxSteps: number;
  private readonly promptTemplate: string;
  private currentHistory: string[];

  constructor(options: ReActAgentOptions) {
    super(options);
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.maxSteps = options.maxSteps ?? 5;
    this.promptTemplate = options.customPrompt ?? DEFAULT_REACT_PROMPT;
    this.currentHistory = [];
  }
}
```

`toolRegistry` 是公开只读属性。这里的“只读”表示外部不能把整个注册表替换成另一个对象，但可以继续调用 `agent.toolRegistry.registerTool(...)` 或 `agent.toolRegistry.registerFunction(...)` 添加工具。这和很多 Agent 框架里把工具注册表作为 Agent 能力入口的设计一致。

`currentHistory` 是本次运行的 scratchpad。它只保存当前问题内部的推理轨迹，不会永久写入 Agent 的跨轮对话历史。

## 6. ReActAgent 的主循环

`run()` 是 ReActAgent 的核心。

```ts
async run(inputText: string, options: ReActAgentRunOptions = {}): Promise<string> {
  const { maxSteps = this.maxSteps, onStep, ...llmOptions } = options;
  this.currentHistory = [];

  for (let currentStep = 1; currentStep <= maxSteps; currentStep += 1) {
    const prompt = this.buildPrompt(inputText);
    const response = await this.llm.invoke(this.buildMessages(prompt), llmOptions);
    const parsedStep = this.parseStep(response);

    if (parsedStep.thought) {
      this.currentHistory.push(`Thought: ${parsedStep.thought}`);
      onStep?.({
        step: currentStep,
        type: "thought",
        content: parsedStep.thought,
      });
    }

    if (!parsedStep.action) {
      const observation = "未能解析出有效的 Action，请严格使用 Action: tool_name[input] 或 Action: Finish[最终答案]。";
      this.currentHistory.push(`Observation: ${observation}`);
      onStep?.({
        step: currentStep,
        type: "error",
        content: observation,
      });
      continue;
    }

    onStep?.({
      step: currentStep,
      type: "action",
      content: parsedStep.action,
    });

    if (parsedStep.action.startsWith("Finish")) {
      const finalAnswer = this.parseActionInput(parsedStep.action) || response;
      onStep?.({
        step: currentStep,
        type: "finish",
        content: finalAnswer,
      });
      this.saveTurn(inputText, finalAnswer);
      return finalAnswer;
    }

    const action = this.parseAction(parsedStep.action);
    if (!action) {
      const observation = "无效的 Action 格式，请使用 工具名[参数]。";
      this.currentHistory.push(`Action: ${parsedStep.action}`);
      this.currentHistory.push(`Observation: ${observation}`);
      onStep?.({
        step: currentStep,
        type: "error",
        content: observation,
      });
      continue;
    }

    const observation = await executeRegisteredTool(this.toolRegistry, action.toolName, action.toolInput);
    this.currentHistory.push(`Action: ${parsedStep.action}`);
    this.currentHistory.push(`Observation: ${observation}`);
    onStep?.({
      step: currentStep,
      type: "observation",
      content: observation,
      toolName: action.toolName,
      toolInput: action.toolInput,
    });
  }

  const finalAnswer = "抱歉，我无法在限定步数内完成这个任务。";
  onStep?.({
    step: maxSteps,
    type: "finish",
    content: finalAnswer,
  });
  this.saveTurn(inputText, finalAnswer);
  return finalAnswer;
}
```

这段代码可以拆成七步理解。

第一步，取出 `maxSteps` 和 `onStep`。用户可以在构造函数里设置默认步数，也可以在单次 `run()` 时覆盖；`onStep` 是可选回调，用来把内部执行事件交给调用层：

```ts
const { maxSteps = this.maxSteps, onStep, ...llmOptions } = options;
```

第二步，每次运行前清空 `currentHistory`。因为 scratchpad 只属于当前问题：

```ts
this.currentHistory = [];
```

第三步，构造 prompt 并调用 LLM：

```ts
const prompt = this.buildPrompt(inputText);
const response = await this.llm.invoke(this.buildMessages(prompt), llmOptions);
```

第四步，解析模型输出里的 `Thought` 和 `Action`：

```ts
const parsedStep = this.parseStep(response);
```

第五步，如果 Action 是 `Finish[...]`，说明模型认为信息足够了，Agent 取出最终答案，写入历史，返回结果。

第六步，如果 Action 是工具调用，就解析工具名和输入，调用 `executeRegisteredTool()`，再把观察结果写回 `currentHistory`。下一轮 prompt 会带上这些历史，让模型基于 Observation 继续推理。

第七步，在关键节点触发 `onStep`。比如解析出 Thought 时触发 `thought`，解析出 Action 时触发 `action`，工具执行完成后触发 `observation`，结束时触发 `finish`。SDK 只负责提供内部事件，不决定这些事件是否应该展示给用户。

`onStep` 的事件类型如下：

```ts
export type ReActStepEventType = "thought" | "action" | "observation" | "finish" | "error";

export interface ReActStepEvent {
  step: number;
  type: ReActStepEventType;
  content: string;
  toolName?: string;
  toolInput?: string;
}
```

其中：

- `step`：当前 ReAct 循环的第几步。
- `type`：事件类型。
- `content`：事件内容。对 `thought` 来说是模型思考文本；对 `action` 来说是原始 Action；对 `observation` 来说是工具返回结果；对 `finish` 来说是最终回答。
- `toolName`：仅工具观察结果里有，表示本次工具名。
- `toolInput`：仅工具观察结果里有，表示本次工具输入。

调用层可以这样使用：

```ts
const answer = await agent.run(userInput, {
  maxSteps: 6,
  onStep(event) {
    if (event.type === "observation") {
      console.log("工具结果：", event.toolName, event.content);
    }
  },
});
```

注意，不建议把 `onStep` 事件原样发给普通前端用户。`thought`、`action`、`observation` 都可能包含内部工具名、参数和系统执行过程。更稳的做法是在业务层把它转换成用户可见进度，比如“正在计算报价金额”“付款计划已生成”。

## 7. Prompt 如何组装

`buildPrompt()` 负责把工具、问题、执行历史填进模板：

```ts
private buildPrompt(inputText: string): string {
  const tools = this.toolRegistry.getToolsDescription();
  const history = this.currentHistory.length > 0 ? this.currentHistory.join("\n") : "暂无执行历史";

  return this.promptTemplate
    .replaceAll("{tools}", tools)
    .replaceAll("{question}", inputText)
    .replaceAll("{history}", history);
}
```

第一次运行时，`history` 是“暂无执行历史”。模型会看到问题和工具说明，然后产生第一步 Action。

执行一次工具后，`history` 可能变成：

```text
Thought: 这个问题需要准确计算折扣后的金额，应该调用报价计算器。
Action: quote_calculator[unitPrice=199,quantity=3,discountRate=0.15]
Observation: {"subtotal":597,"discount":89.55,"payable":507.45}
```

第二轮模型看到这个历史，就应该输出：

```text
Thought: 已经拿到小计、折扣和应付金额，可以给出最终答案。
Action: Finish[小计为 597 元，折扣金额为 89.55 元，最终应付 507.45 元。]
```

这就是 ReAct 的核心：模型不是一次性回答，而是基于行动结果逐步修正自己的下一步。

## 8. Thought 和 Action 如何解析

解析函数是 `parseStep()`：

```ts
private parseStep(text: string): ParsedStep {
  const thoughtMatch = text.match(/Thought:\s*([\s\S]*?)(?=\n\s*Action:|$)/i);
  const actionMatch = text.match(/Action:\s*([^\n]+)/i);

  return {
    thought: thoughtMatch?.[1]?.trim(),
    action: actionMatch?.[1]?.trim(),
  };
}
```

这里有两个正则。

第一个正则读取 `Thought:` 后面的内容，直到遇到下一行 `Action:`。用 `[\s\S]*?` 是为了支持 Thought 里出现换行。

第二个正则读取 `Action:` 后面的一行。当前版本要求每一轮只执行一个 Action，所以只读取一行就够了。

如果模型没有输出 Action，Agent 不会直接崩溃，而是把格式错误写成 Observation：

```ts
this.currentHistory.push("Observation: 未能解析出有效的 Action，请严格使用 Action: tool_name[input] 或 Action: Finish[最终答案]。");
continue;
```

这样下一轮模型还能看到错误信息，并有机会按正确格式重试。

## 9. Action 如何解析和执行

普通工具调用格式是：

```text
quote_calculator[unitPrice=199,quantity=3,discountRate=0.15]
```

解析函数是：

```ts
private parseAction(actionText: string): ParsedAction | undefined {
  const match = actionText.match(/^([a-zA-Z_][\w.-]*)\[(.*)\]$/s);
  if (!match) {
    return undefined;
  }

  return {
    toolName: match[1] ?? "",
    toolInput: match[2] ?? "",
  };
}
```

工具名允许字母、数字、下划线、点号和短横线。这样未来接入 MCP 或其他工具命名规范时，不会只能用普通单词。

如果 Action 是结束指令：

```text
Finish[最终答案]
```

就用 `parseActionInput()` 取出方括号中的内容：

```ts
private parseActionInput(actionText: string): string {
  const match = actionText.match(/^\w+\[(.*)\]$/s);
  return match?.[1]?.trim() ?? "";
}
```

注意，`Finish` 本身不是工具。它是 ReActAgent 的停止信号。

## 10. 为什么 scratchpad 不写入长期历史

`ReActAgent` 有两类历史。

第一类是 `Agent` 基类里的长期历史。它保存跨轮对话：

```text
user: 客户要买 3 套授权...
assistant: 小计为 597 元...
```

第二类是 ReActAgent 自己的 `currentHistory`。它保存当前任务内部的执行轨迹：

```text
Thought: ...
Action: ...
Observation: ...
```

这两类历史不能混在一起。

如果把所有 `Thought / Action / Observation` 都写入长期历史，下一轮用户只是问“帮我把刚才答案改短一点”，模型却会看到大量上一次工具调用细节，容易受到干扰。更合理的做法是：长期历史只保存用户看得懂的输入和最终回答；中间轨迹只在本次运行中使用，需要调试时通过 `getScratchpad()` 查看。

所以 `ReActAgent` 结束时只调用：

```ts
private saveTurn(inputText: string, response: string): void {
  this.addMessage(new Message(inputText, "user"));
  this.addMessage(new Message(response, "assistant"));
}
```

## 11. 注册工具和查看轨迹

`ReActAgent` 提供了和 `SimpleAgent` 类似的工具管理方法：

```ts
addTool(tool: Tool, autoExpand = true): void {
  this.toolRegistry.registerTool(tool, autoExpand);
}

removeTool(toolName: string): boolean {
  return this.toolRegistry.unregisterTool(toolName);
}

listTools(): string[] {
  return this.toolRegistry.listTools();
}
```

如果你在创建 Agent 后才拿到工具，也可以这样添加：

```ts
agent.addTool(new QuoteCalculatorTool());
console.log(agent.listTools());
```

为了调试 ReAct 过程，还提供了：

```ts
getScratchpad(): string[] {
  return [...this.currentHistory];
}
```

它返回副本，而不是直接返回内部数组。这样外部代码不能意外修改 Agent 内部状态。

## 12. 导出 SDK API

最后更新 `src/index.ts`：

```ts
export { DEFAULT_REACT_PROMPT, ReActAgent } from "./agents/react-agent.js";
export { executeRegisteredTool, parseToolParameters } from "./tools/executor.js";

export type {
  ReActAgentOptions,
  ReActAgentRunOptions,
  ReActStepEvent,
  ReActStepEventType,
} from "./agents/react-agent.js";
```

这样用户就可以从 SDK 根入口导入：

```ts
import { ReActAgent, ToolRegistry, Tool } from "helloagent-js";
```

不要让用户去 import `src/agents/react-agent.ts` 这种内部路径。SDK 应该通过统一出口暴露稳定能力。

## 13. 运行真实示例

本节新增的示例是 `examples/03-react-agent.mjs`。它不再只是问一次问题、看一次最终答案，而是模拟一个真实 chatbot 会话：

1. 第一轮：用户让 Agent 生成完整报价方案。
2. 第二轮：用户基于上一轮结果，要求改写成内部审批说明。
3. 第三轮：用户继续要求改写成发给客户的简短邮件。

这三轮对话复用同一个 `ReActAgent` 实例，所以 `Agent` 的长期历史会从 2 条增长到 4 条，再增长到 6 条。这个例子可以帮助你理解：一次 `run()` 内部可能多次调用 LLM 和工具，但长期历史只保存用户输入和最终回答；多轮 chatbot 则通过多次调用 `agent.run()` 累积长期历史。

### 13.1 准备环境

先构建 SDK：

```bash
pnpm build
```

确认 examples 依赖已安装：

```bash
cd examples
pnpm install
cd ..
```

准备环境变量：

```bash
cp examples/.env.example examples/.env
```

如果你使用本地 OpenAI 兼容服务，可以在 `examples/.env` 中配置：

```bash
LLM_API_KEY=local
LLM_BASE_URL=http://localhost:8000/v1
LLM_MODEL_ID=local-model
```

然后运行：

```bash
node examples/03-react-agent.mjs
```

### 13.2 注册多个工具

当前示例注册了三个本地业务工具：

```ts
const registry = new ToolRegistry();
registry.registerTool(new QuoteCalculatorTool());
registry.registerTool(new DiscountApprovalTool());
registry.registerTool(new PaymentScheduleTool());
```

这三个工具分别负责：

- `QuoteCalculatorTool`：计算商品小计、折扣金额和最终应付金额。
- `DiscountApprovalTool`：根据折扣率和应付金额判断是否需要审批。
- `PaymentScheduleTool`：根据应付金额、分期期数和首付款比例生成付款计划。

在真实产品里，这些工具可能会变成 CRM 查询、报价系统、审批系统、合同系统等外部能力。这里先用本地工具，是为了让你能稳定看到 ReAct 的多步工具调用过程。

### 13.3 连续调用多次 `agent.run()`

示例底部定义了一个 `runConversationTurn()`，每一轮都复用同一个 `agent`：

```js
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
```

然后连续调用三次：

```js
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
```

这就是 Web chatbot 里常见的模式：同一个会话 ID 对应同一个 Agent 历史。用户每发一条消息，后端就调用一次 `agent.run(userInput)`。如果是在生产环境里，长期历史通常会保存在数据库中；这里为了演示，直接复用同一个内存里的 `agent` 实例。

### 13.4 把内部执行过程转换成用户可见进度

`ReActAgent` 内部会产生 `Thought / Action / Observation`。这些内容适合开发者调试，但不应该直接展示给普通用户，因为里面可能包含工具名、工具参数、内部规则或系统执行轨迹。

所以示例里没有把 `onStep` 原样打印，而是通过 `printPublicStep()` 转成业务进度：

```js
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
```

注意这里的分层：

- SDK 层提供内部事件：`thought`、`action`、`observation`、`finish`、`error`。
- 业务层决定哪些信息可以给用户看。
- 前端只渲染安全的业务进度，例如“正在计算报价金额”“付款计划已生成”。

这比直接把 `Thought / Action / Observation` 发到页面更稳。用户知道系统在做什么，但不会看到内部工具名、参数和执行协议。

### 13.5 清洗最终答案并写回长期历史

即使系统提示词要求模型不要泄露内部过程，模型也可能偶尔把工具名或 `Thought / Action` 混进最终回复里。示例里加了两层保护。

第一层是系统提示词：

```js
systemPrompt: [
  "你是一个严谨的中文商务报价助手。",
  "当用户请求报价、审批判断或付款计划时，你需要在内部静默使用可用工具完成计算和检查，不要心算。",
  "工具调用、工具名称、工具参数、Thought、Action、Observation、执行历史都属于系统内部过程，绝不能出现在最终回复里。",
  "最终回复只能呈现面向用户的业务内容，例如报价明细、审批结论、付款安排、邮件正文或内部说明。",
  "如果用户要求基于上一轮继续改写，请直接基于上一轮最终业务结果改写，不要解释你上一轮调用过什么工具，也不要复述任何内部执行记录。",
].join("\n")
```

第二层是业务侧清洗：

```js
const publicAnswer = sanitizeAssistantAnswer(answer);
replaceLastAssistantAnswer(agent, publicAnswer);
```

`sanitizeAssistantAnswer()` 负责从模型最终输出里取出用户可见答案，并替换掉内部工具名。`replaceLastAssistantAnswer()` 则把清洗后的答案写回 Agent 的长期历史。这样第二轮、第三轮继续对话时，模型看到的是干净的业务答案，而不是包含内部执行过程的 assistant 历史。

### 13.6 运行结果

下面是一段实际运行输出。不同模型的文字表达可能略有差异，但整体结构应该相同：三轮连续对话，每轮都有用户可见执行进度，长期历史消息数依次是 2、4、6。

```text
========== 第 1 轮对话 ==========

用户：
 客户要采购 8 套企业版授权，每套 1299 元，销售希望给 18% 折扣。客户想分 3 期付款，首付款 40%。请帮我形成一份可以发给销售经理确认的报价方案：先算小计、折扣和应付金额，再判断是否需要审批，最后给出付款计划。 

页面可见执行进度：
(node:16847) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.
(Use `node --trace-deprecation ...` to show where the warning was created)
  - 正在计算报价金额...
  - 报价金额已计算：小计 10392.00 元，折扣 1870.56 元，应付 8521.44 元。
  - 正在检查折扣审批要求...
  - 审批要求已确认：销售经理审批。发送客户前需要销售经理确认。
  - 正在生成付款计划...
  - 付款计划已生成：合同签署后 3408.58 元；第 2 期 2556.43 元；第 3 期 2556.43 元。
  - 正在整理最终回复...
  - 本轮回复已生成。

助手：
 **企业版授权采购报价方案**

尊敬的销售经理：

您好！

根据客户需求，现就企业版授权采购事宜形成如下报价方案，请您审阅：

**1. 报价明细：**
*   商品：企业版授权
*   单价：1299 元/套
*   数量：8 套
*   小计：10392 元
*   折扣率：18%
*   折扣金额：1870.56 元
*   **应付总金额：8521.44 元**

**2. 审批判断：**
*   折扣率：18%
*   应付金额：8521.44 元
*   **审批结论：需要销售经理审批。**
*   **审批原因：折扣率超过 10% 且不超过 20%。**
*   **建议动作：此报价在发送客户前，需要您进行确认。**

**3. 付款计划：**
*   应付总金额：8521.44 元
*   分期期数：3 期
*   首付款比例：40%
*   **付款安排：**
    *   合同签署后支付首付款：3408.58 元 (40%)
    *   第 2 期支付：2556.43 元 (30%)
    *   第 3 期支付：2556.43 元 (30%)

请您审阅以上方案，如有任何疑问或建议，请随时提出。

谢谢！ 

当前长期历史消息数：2

========== 第 2 轮对话 ==========

用户：
 基于刚才的报价方案，帮我改写成一段内部审批说明，语气正式一点，重点说明为什么需要销售经理审批。 

页面可见执行进度：
  - 正在检查折扣审批要求...
  - 审批要求已确认：销售经理审批。发送客户前需要销售经理确认。
  - 正在整理最终回复...
  - 本轮回复已生成。

助手：
 **内部审批说明**

**事由：** 企业版授权采购报价审批

**背景：** 客户计划采购 8 套企业版授权，单价 1299 元/套。销售申请 18% 折扣。

**报价详情：**
*   商品：企业版授权
*   数量：8 套
*   单价：1299 元/套
*   小计：10392 元
*   折扣率：18%
*   折扣金额：1870.56 元
*   **应付总金额：8521.44 元**

**审批要点：**
根据公司内部审批政策，本次报价的折扣率为 18%，应付总金额为 8521.44 元。由于折扣率超过了 10% 且未超过 20%，**此报价需要销售经理进行审批**。

**建议动作：**
在将此报价发送给客户之前，请销售经理审阅并确认。

**特此说明，请予审批。** 

当前长期历史消息数：4

========== 第 3 轮对话 ==========

用户：
 再把刚才的内容改成可以发给客户的简短邮件。不要暴露内部审批规则，只说明报价金额、折扣优惠和付款安排。 

页面可见执行进度：
  - 正在计算报价金额...
  - 报价金额已计算：小计 10392.00 元，折扣 1870.56 元，应付 8521.44 元。
  - 正在生成付款计划...
  - 付款计划已生成：合同签署后 3408.58 元；第 2 期 2556.43 元；第 3 期 2556.43 元。
  - 正在整理最终回复...
  - 本轮回复已生成。

助手：
 尊敬的客户：

您好！

感谢您对我们企业版授权的关注。根据您的需求，我们为您准备了以下采购方案：

**报价详情：**
*   企业版授权 8 套
*   原价：10392 元
*   **折扣优惠：1870.56 元**
*   **最终报价：8521.44 元**

**付款安排：**
为方便您安排资金，我们提供分 3 期付款的方案：
*   合同签署后支付首付款（40%）：3408.58 元
*   第 2 期支付（30%）：2556.43 元
*   第 3 期支付（30%）：2556.43 元

如您对以上方案有任何疑问或需要进一步沟通，请随时联系我们。

期待与您合作！

诚挚地，
[您的公司名称] 

当前长期历史消息数：6
```

这里的 Node `punycode` deprecation warning 来自运行时依赖，不影响 ReActAgent 的执行结果。你可以忽略它，或者用 `node --trace-deprecation` 追踪具体来源。

## 14. 本节小结

这一节我们实现了 `ReActAgent`，它比 `SimpleAgent` 多了一个明确的推理与行动循环。

`SimpleAgent` 更适合简单任务：模型看到工具说明后，可以直接选择是否调用工具。它的协议更轻，适合普通助手场景。

`ReActAgent` 更适合需要多步探索的任务：模型每一步都要输出 `Thought` 和 `Action`，Agent 执行工具后把 `Observation` 交回模型，直到模型用 `Finish` 结束。它的过程更长，但更容易调试，也更适合搜索、查询、计算、排错这类需要边走边看的任务。

到这里，我们的 TypeScript SDK 已经有三层能力：

1. `HelloAgentsLLM`：负责稳定调用 OpenAI 兼容模型。
2. `Agent` / `SimpleAgent`：负责基础对话、历史管理和最小工具调用。
3. `ReActAgent`：负责推理、行动、观察、结束的经典 Agent 循环。

下一步可以继续实现 ReflectionAgent 或 PlanAndSolveAgent。但在继续之前，建议你先多运行几次 `examples/03-react-agent.mjs`，观察不同模型是否能稳定遵守 `Thought / Action / Finish` 格式。ReAct 的核心能力很强，但它对模型的格式遵循能力也更敏感，这是使用这类文本协议 Agent 时必须理解的工程现实。
