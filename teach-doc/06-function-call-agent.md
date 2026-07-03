# 从0构建SDK第6节：实现 FunctionCallAgent 的原生函数调用

前面几节我们已经实现了几类 Agent：

1. `SimpleAgent`：把工具说明写进提示词，让模型输出 `[TOOL_CALL:name:params]` 这样的文本协议。
2. `ReActAgent`：让模型按 `Thought -> Action -> Observation` 的格式一步一步调用工具。
3. `ReflectionAgent`：让模型先回答，再反思，再改进。
4. `PlanAndSolveAgent`：先规划步骤，再逐步执行。

这些 Agent 都能工作，但只要涉及工具调用，就会遇到一个共同问题：它们依赖模型“按我们写的文本格式输出”。如果模型少写一个括号、把参数名写错、在工具调用前后夹杂解释文字，Agent 就需要额外解析和纠错。

这一节我们实现 `FunctionCallAgent`。它使用 OpenAI-compatible Chat Completions 的原生函数调用能力：我们把工具定义作为 `tools` 参数交给模型，模型不再输出自定义文本，而是在 assistant message 里返回结构化的 `tool_calls`。Agent 执行工具后，把结果作为 `role: "tool"` 的消息回填给模型，模型再基于工具结果生成最终回答。

这章的目标不是做一个功能最多的 Agent，而是把原生函数调用的最小闭环写清楚：

```text
用户问题
  -> LLM 返回 assistant.tool_calls
  -> Agent 解析 arguments
  -> Agent 执行本地工具
  -> Agent 追加 role: "tool" 消息
  -> LLM 生成最终回答
  -> Agent 保存长期历史
```

## 1. 本章最终效果

写完这一章后，我们可以这样使用 SDK：

```js
import { FunctionCallAgent, HelloAgentsLLM, Tool, ToolRegistry } from "helloagent-js";

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

const llm = new HelloAgentsLLM();
const registry = new ToolRegistry();
registry.registerTool(new QuoteCalculatorTool());

const agent = new FunctionCallAgent({
  name: "Function Call 报价助手",
  llm,
  toolRegistry: registry,
});

const answer = await agent.run("8 套企业版授权，每套 1299 元，18% 折扣，请计算报价。");
console.log(answer);
```

这段代码里没有 `[TOOL_CALL:...]`，也没有 `Action: tool_name[...]`。工具调用由模型 API 返回的 `tool_calls` 承载，Agent 只负责执行和回填。

## 2. 为什么需要 FunctionCallAgent

先看 `SimpleAgent` 的工具调用方式。

它会把工具说明写进 system prompt，然后要求模型输出：

```text
[TOOL_CALL:quote_calculator:unitPrice=1299,quantity=8,discountRate=0.18]
```

这个方案适合教学，因为它能让我们手写一个完整工具循环。但它有三个明显限制。

第一，工具调用格式由 prompt 约束。模型是否按格式输出，取决于模型遵循指令的能力。

第二，参数解析由我们自己维护。比如 `number`、`integer`、`boolean`、`array` 都要从字符串转换回来。

第三，模型不一定理解“工具调用”和“最终回答”的边界。它可能一边调用工具，一边把内部协议暴露给用户。

Function calling 的思路不同。我们把工具定义成 JSON Schema：

```json
{
  "type": "function",
  "function": {
    "name": "quote_calculator",
    "description": "根据商品单价、数量和折扣率计算报价，返回小计、折扣金额和最终应付金额。",
    "parameters": {
      "type": "object",
      "properties": {
        "unitPrice": {
          "type": "number",
          "description": "商品单价"
        },
        "quantity": {
          "type": "integer",
          "description": "购买数量"
        }
      },
      "required": ["unitPrice", "quantity"]
    }
  }
}
```

然后调用模型时传入：

```ts
{
  model,
  messages,
  tools,
  tool_choice: "auto"
}
```

如果模型判断需要工具，它返回的 assistant message 会带 `tool_calls`。Agent 执行工具，再把结果作为 `role: "tool"` 消息放回 `messages`。这是模型 API 认可的结构化协议，比自定义文本协议更稳定。

## 3. 本章修改哪些文件

本章会修改和新增这些文件：

```text
src/
  core/
    message.ts                 # 增加 OpenAIToolCall 和 tool 消息字段
    llm.ts                     # 增加 invokeMessage()，返回完整 assistant message
  tools/
    registry.ts                # 增加 getOpenAIToolSchemas()
    executor.ts                # 增加 executeRegisteredToolWithParameters()
  agents/
    function-call-agent.ts     # 新增 FunctionCallAgent
  index.ts                     # 导出 FunctionCallAgent 和新增类型

examples/
  06-function-call-agent.mjs   # 真实模型手动验证示例
  README.md                    # 增加第 6 个 example 的运行说明

teach-doc/
  06-function-call-agent.md    # 本章教程
```

这里的关键设计是分层：

- `core/llm.ts` 只负责调用模型，并返回模型原始 assistant message 中我们关心的结构。
- `tools/base.ts` 和 `tools/registry.ts` 只负责把工具变成 OpenAI-compatible schema。
- `tools/executor.ts` 只负责执行工具。
- `agents/function-call-agent.ts` 只负责组织 messages、处理 `tool_calls` 循环、保存历史。

不要把所有逻辑塞进 Agent。Agent 应该知道“何时调用 LLM、何时执行工具”，但不应该知道底层 client 怎么创建，也不应该重写工具 schema 规则。

## 4. 扩展消息类型

之前的 `OpenAIMessage` 很简单：

```ts
export interface OpenAIMessage {
  role: MessageRole;
  content: string;
}
```

这对普通聊天足够，但 function calling 需要两种新消息。

第一种是 assistant message。模型请求调用工具时，assistant message 会带 `tool_calls`：

```ts
{
  role: "assistant",
  content: "",
  tool_calls: [
    {
      id: "call_xxx",
      type: "function",
      function: {
        name: "quote_calculator",
        arguments: "{\"unitPrice\":1299,\"quantity\":8,\"discountRate\":0.18}"
      }
    }
  ]
}
```

第二种是 tool message。Agent 执行工具后，需要用 `tool_call_id` 告诉模型“这是哪一次工具调用的结果”：

```ts
{
  role: "tool",
  tool_call_id: "call_xxx",
  name: "quote_calculator",
  content: "{\"subtotal\":10392,\"discount\":1870.56,\"payable\":8521.44}"
}
```

所以我们在 `src/core/message.ts` 里增加：

```ts
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}
```

然后扩展 `OpenAIMessage`：

```ts
export interface OpenAIMessage {
  role: MessageRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}
```

这里没有把 `Message` 类改复杂。`Message` 仍然适合长期历史：

```ts
new Message("用户输入", "user");
new Message("最终回答", "assistant");
```

`tool_calls` 和 `tool_call_id` 主要存在于 `FunctionCallAgent.run()` 的临时 `messages` 里，不需要永久保存到 `Agent.history`。

## 5. 为什么 LLM 层要增加 invokeMessage()

之前 `HelloAgentsLLM.invoke()` 只返回字符串：

```ts
const response = await this.client.chat.completions.create(...);
return response.choices[0]?.message?.content ?? "";
```

普通聊天只关心 `content`，这个设计很清楚。但 function calling 不能只拿 `content`，因为模型可能返回：

```json
{
  "content": null,
  "tool_calls": [...]
}
```

如果我们继续只返回字符串，`tool_calls` 就丢了。

一个做法是让 `FunctionCallAgent` 直接访问 `HelloAgentsLLM` 内部的 client：

```ts
llm.client.chat.completions.create(...)
```

但当前 TS 版里 `client` 是私有字段：

```ts
private readonly client: OpenAICompatibleClient;
```

外部 Agent 不应该碰它。否则 `FunctionCallAgent` 会依赖 LLM 的内部实现细节。后面如果 `HelloAgentsLLM` 改了 client 字段名、错误包装、provider 适配，Agent 就会坏。

所以我们在 `HelloAgentsLLM` 上增加一个公开方法：

```ts
export interface LLMMessageResponse {
  role: "assistant";
  content: string;
  toolCalls: OpenAIToolCall[];
  refusal?: string;
}
```

再实现：

```ts
async invokeMessage(messages: ChatMessage[], options: Record<string, unknown> = {}): Promise<LLMMessageResponse> {
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

    const message = response.choices[0]?.message;
    const refusal = typeof message?.refusal === "string" ? message.refusal : undefined;
    return {
      role: "assistant",
      content: extractMessageContent(message?.content),
      toolCalls: message?.tool_calls ?? [],
      refusal,
    };
  } catch (error) {
    throw new HelloAgentsException(`LLM调用失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

这段代码保留了 `HelloAgentsLLM` 原来的职责：

1. 选择模型。
2. 处理 `temperature`。
3. 处理 `maxTokens` 到 `max_tokens` 的映射。
4. 合并 `extraOptions`。
5. 包装错误。
6. 隐藏底层 OpenAI SDK client。

`refusal` 是一个兼容性辅助字段。有些 OpenAI-compatible 服务在拒绝某次工具调用、遇到不支持的 `tool_choice`，或者返回非标准状态时，不会把原因写进 `content`，而是写到 `message.refusal`。`FunctionCallAgent` 不把它当最终回答展示给用户，但可以用它生成更清楚的异常信息。

旧的 `invoke()` 不删除，而是复用 `invokeMessage()`：

```ts
async invoke(messages: ChatMessage[], options: Record<string, unknown> = {}): Promise<string> {
  const response = await this.invokeMessage(messages, options);
  return response.content;
}
```

这样已有的 Agent 不需要改。

## 6. 提取 message.content

有些模型返回的 `message.content` 是字符串，有些兼容服务可能返回数组结构。为了让 `invokeMessage()` 稳定，我们加了一个小函数：

```ts
function extractMessageContent(content: ChatCompletionContent | null | undefined): string {
  if (content === null || content === undefined) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      if (typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("");
}
```

Function calling 场景下，`content` 为空很常见。模型可能只返回工具调用，不返回文本。这里返回空字符串即可，Agent 后续会看 `toolCalls`。

## 7. 工具如何变成 OpenAI schema

我们在前面章节已经设计过 `Tool` 基类。每个工具都有：

```ts
abstract run(parameters: ToolParameters): ToolResult;

abstract getParameters(): ToolParameter[];
```

`getParameters()` 返回工具参数定义。例如报价工具：

```ts
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
```

这些信息刚好能转换成 OpenAI-compatible schema。`src/tools/base.ts` 里已经有：

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

这一节我们不重新发明 schema 生成规则，而是在 `ToolRegistry` 上加统一出口：

```ts
getOpenAIToolSchemas(): OpenAIToolSchema[] {
  const schemas = [...this.tools.values()].map((tool) => tool.toOpenAISchema());

  for (const [name, info] of this.functions.entries()) {
    schemas.push({
      type: "function",
      function: {
        name,
        description: info.description,
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "输入文本",
            },
          },
          required: ["input"],
        },
      },
    });
  }

  return schemas;
}
```

这里有两类工具：

1. `registerTool()` 注册的 `Tool` 对象：直接调用 `tool.toOpenAISchema()`。
2. `registerFunction()` 注册的简单函数：统一包装成只有 `input` 字符串参数的函数工具。

这样 `FunctionCallAgent` 不需要知道工具存在 Map 里，也不需要访问注册表内部字段。

## 8. 为什么需要对象参数执行函数

之前 `executeRegisteredTool()` 的输入是字符串：

```ts
executeRegisteredTool(registry, "quote_calculator", "unitPrice=1299,quantity=8")
```

它服务的是文本协议 Agent，所以会先调用：

```ts
parseToolParameters(tool, parameters)
```

Function calling 不一样。模型返回的 `arguments` 是 JSON 字符串：

```json
"{\"unitPrice\":1299,\"quantity\":8,\"discountRate\":0.18}"
```

Agent 解析后已经得到对象：

```ts
{
  unitPrice: 1299,
  quantity: 8,
  discountRate: 0.18
}
```

这时候再把对象拼回字符串、再交给旧解析器，是多余的。

所以在 `src/tools/executor.ts` 里增加：

```ts
export async function executeRegisteredToolWithParameters(
  registry: ToolRegistry,
  toolName: string,
  parameters: ToolParameters,
): Promise<string> {
  const tool = registry.getTool(toolName);
  if (tool) {
    try {
      const result = await tool.run(convertParameterTypes(tool, parameters));
      return String(result);
    } catch (error) {
      return `工具调用失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const func = registry.getFunction(toolName);
  if (func) {
    try {
      const input = parameters.input;
      return await func(typeof input === "string" ? input : JSON.stringify(parameters));
    } catch (error) {
      return `工具调用失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return `错误：未找到工具 '${toolName}'`;
}
```

注意这里仍然调用了 `convertParameterTypes()`。原因是不同模型或兼容服务可能把数字参数返回成字符串：

```json
{
  "quantity": "8"
}
```

工具定义里 `quantity` 是 `integer`，执行前可以尽量转成数字。这样工具实现不需要处理太多模型返回差异。

## 9. FunctionCallAgent 的配置类型

新增文件 `src/agents/function-call-agent.ts`。

第一步定义工具选择策略：

```ts
export type FunctionCallToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };
```

这对应 OpenAI-compatible chat completions 的 `tool_choice`：

- `"auto"`：模型自行决定是否调用工具。
- `"none"`：不允许调用工具，只生成普通文本。
- `"required"`：要求模型必须调用工具。
- 指定某个函数：强制模型调用指定工具。

然后定义事件类型：

```ts
export type FunctionCallStepEventType = "assistant" | "tool-call" | "tool-result" | "finish";

export interface FunctionCallStepEvent {
  iteration: number;
  type: FunctionCallStepEventType;
  content: string;
  toolName?: string;
  toolCallId?: string;
  arguments?: ToolParameters;
}
```

`onStep` 不是 Agent 运行的必要条件，但它对真实应用很有用。前端可以用它显示：

- 模型准备调用哪个工具。
- 工具参数是什么。
- 工具执行结果是什么。
- 最终回答是否生成。

再定义构造参数：

```ts
export interface FunctionCallAgentOptions extends AgentOptions {
  toolRegistry?: ToolRegistry;
  enableToolCalling?: boolean;
  defaultToolChoice?: FunctionCallToolChoice;
  maxToolIterations?: number;
}
```

和每次运行时的参数：

```ts
export interface FunctionCallAgentRunOptions extends Record<string, unknown> {
  maxToolIterations?: number;
  toolChoice?: FunctionCallToolChoice;
  onStep?: (event: FunctionCallStepEvent) => void;
}
```

这里的 `RunOptions` 继承 `Record<string, unknown>`，是为了允许用户继续传 LLM 参数，例如 `temperature` 或其他 OpenAI-compatible 参数。

## 10. 构造 FunctionCallAgent

类声明：

```ts
export class FunctionCallAgent extends Agent {
  readonly toolRegistry: ToolRegistry;

  private readonly defaultToolChoice: FunctionCallToolChoice;
  private readonly maxToolIterations: number;
  private enableToolCalling: boolean;
```

构造函数：

```ts
constructor(options: FunctionCallAgentOptions) {
  super(options);
  this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
  this.enableToolCalling = options.enableToolCalling ?? true;
  this.defaultToolChoice = options.defaultToolChoice ?? "auto";
  this.maxToolIterations = options.maxToolIterations ?? 3;
}
```

这里即使用户没有传 `toolRegistry`，也会创建一个空注册表。这样用户可以先创建 Agent，再用 `addTool()` 添加工具：

```ts
const agent = new FunctionCallAgent({ name: "助手", llm });
agent.addTool(new QuoteCalculatorTool());
```

`hasTools()` 会检查注册表里是否真的有工具：

```ts
hasTools(): boolean {
  return this.enableToolCalling && this.toolRegistry.listTools().length > 0;
}
```

所以空注册表不会导致模型请求里出现空 tools。

## 11. 构建带工具说明的 system prompt

虽然原生 function calling 主要依靠 `tools` 参数，但 system prompt 仍然有价值。它告诉模型什么时候该使用工具、最终回答要注意什么。

实现：

```ts
private getEnhancedSystemPrompt(): string {
  const basePrompt = this.systemPrompt ?? "你是一个可靠的AI助理，能够在需要时调用工具完成任务。";

  if (!this.hasTools()) {
    return basePrompt;
  }

  const toolsDescription = this.toolRegistry.getToolsDescription();
  if (!toolsDescription || toolsDescription === "暂无可用工具") {
    return basePrompt;
  }

  return `${basePrompt}

## 可用工具
当你判断需要外部信息、计算或业务动作时，可以通过原生函数调用使用以下工具：
${toolsDescription}

请根据任务主动决定是否调用工具。工具结果会由系统回填给你，你需要基于工具结果给出最终回答。
如果决定调用工具，必须使用模型 API 的原生 tool_calls 结构返回；不要在普通文本中输出 call(...)、print(...)、default_api.xxx(...) 或 JSON 字符串来表示工具调用。`;
}
```

这里没有要求模型输出某个文本格式。因为工具调用格式由 `tools` 参数约束，而不是 prompt 约束。

最后一行是为了兼容一些使用 Gemini、Claude 或本地模型包装出来的 OpenAI-compatible 服务。它们有时会把“函数调用”理解成普通文本里的代码式调用，例如 `call(...)` 或 `default_api.xxx(...)`。这类内容不是标准 `tool_calls`，服务端可能会返回空内容或 `Malformed function call`。所以我们在 prompt 里明确告诉模型：要调用工具就走 API 的原生 `tool_calls` 字段，不要自己写代码式函数调用。

## 12. 构造请求消息

`FunctionCallAgent` 仍然继承 `Agent`，所以它可以复用长期历史：

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

`buildBaseMessages()` 会做两件事：

1. 如果有 system prompt，就放在第一条。
2. 把 `Agent.history` 里的历史消息追加进去。

然后本轮用户输入作为最后一条 `user` 消息。

## 13. 主循环第一步：没有工具时直接普通调用

`run()` 开始时先解构参数：

```ts
const {
  maxToolIterations = this.maxToolIterations,
  toolChoice = this.defaultToolChoice,
  onStep,
  ...llmOptions
} = options;
```

然后构建 messages 和 tools：

```ts
const messages = this.buildMessages(inputText);
const toolSchemas = this.buildToolSchemas();
```

如果没有工具，就退化成普通 Agent：

```ts
if (toolSchemas.length === 0) {
  const response = await this.llm.invoke(messages, llmOptions);
  this.saveTurn(inputText, response);
  return response;
}
```

这个分支很重要。它保证 `FunctionCallAgent` 即使没有工具，也不会发一个空 tools 请求。

## 14. 主循环第二步：请求模型返回 tool_calls

进入循环：

```ts
let currentIteration = 0;

while (currentIteration < maxToolIterations) {
  const response = await this.llm.invokeMessage(messages, {
    ...llmOptions,
    tools: toolSchemas,
    tool_choice: toolChoice,
  });
```

这里使用的是 `invokeMessage()`，不是 `invoke()`。因为我们要拿完整结构：

```ts
{
  role: "assistant",
  content: "...",
  toolCalls: [...]
}
```

如果模型返回了一段中间文本，可以通过事件交给调用方：

```ts
if (response.content) {
  onStep?.({
    iteration: currentIteration + 1,
    type: "assistant",
    content: response.content,
  });
}
```

有些模型在 tool call 前会给一点文字，有些不会。这不是最终回答，只是中间状态。

## 15. 主循环第三步：没有 tool_calls 时结束

先把本轮要执行的工具调用取出来：

```ts
const toolCalls =
  response.toolCalls.length > 0
    ? response.toolCalls
    : this.recoverMalformedToolCalls(response, currentIteration + 1);
```

正常情况下，工具调用来自 `response.toolCalls`。后面的 `recoverMalformedToolCalls()` 是一个兼容性兜底：有些 Gemini-compatible 或本地 OpenAI-compatible 服务会把模型的错误函数调用放进 `message.refusal`，例如：

```text
Malformed function call: call
print(default_api.quote_calculator(unitPrice=1299, quantity=8, discountRate=0.18))
```

这不是标准 `tool_calls`，但里面包含了一个已注册工具名和简单参数。为了让 Agent 不因为这类兼容层格式问题直接失败，我们只在 `content` 为空、`toolCalls` 也为空、并且 `refusal` 里能匹配到已注册工具时，把它恢复成内部 `OpenAIToolCall`。这不是重新设计一套文本协议；它只是修复 provider 已经承认的 malformed function call。

然后判断是否结束。如果没有任何可执行工具调用，通常说明模型已经生成最终文本。但这里不能只看 `toolCalls`，还要确认 `content` 真的有内容：

```ts
if (toolCalls.length === 0) {
  if (response.content.trim().length > 0) {
    return this.finishRun(inputText, messages, response.content, currentIteration + 1, onStep);
  }

  if (hasExecutedTool) {
    const finalResponse = await this.requestFinalResponse(messages, llmOptions);
    return this.finishRun(inputText, messages, finalResponse.content, currentIteration + 1, onStep, finalResponse);
  }

  throw this.createEmptyFinalResponseError(response);
}
```

为什么要多做这层判断？

因为不同模型服务的 function calling 兼容程度不一样。正常的工具调用中，`content` 为空是合理的，只要同时有 `toolCalls` 就能继续执行工具。但如果没有 `toolCalls`，`content` 也为空，Agent 就不能把它当成最终回答保存。否则用户会看到一条空白回复，长期历史里也会留下空 assistant 消息。

这里分三种情况：

1. 有最终文本：直接结束。
2. 没有最终文本，但本轮已经执行过工具：再发一次不带工具的最终整理请求，让模型基于已有工具结果写最终回答。
3. 没有最终文本，也没有执行过工具：抛出清楚的 Agent 异常，让调用方知道模型服务没有返回可用内容。

恢复 malformed function call 的核心代码如下：

```ts
private recoverMalformedToolCalls(response: LLMMessageResponse, iteration: number): OpenAIToolCall[] {
  if (!response.refusal || response.content.trim().length > 0) {
    return [];
  }

  const recoveredCall = this.parseMalformedToolCall(response.refusal, iteration);
  return recoveredCall ? [recoveredCall] : [];
}

private parseMalformedToolCall(text: string, iteration: number): OpenAIToolCall | undefined {
  const functionCallPattern = /(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\s*\(([^()]*)\)/g;

  for (const match of text.matchAll(functionCallPattern)) {
    const toolName = match[1];
    if (!toolName || (!this.toolRegistry.getTool(toolName) && !this.toolRegistry.getFunction(toolName))) {
      continue;
    }

    return {
      id: `recovered-call-${iteration}`,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(this.parseMalformedArguments(match[2] ?? "")),
      },
    };
  }

  return undefined;
}

private parseMalformedArguments(argumentsText: string): ToolParameters {
  const parsed: ToolParameters = {};

  for (const part of argumentsText.split(",")) {
    const [name, ...valueParts] = part.split("=");
    const parameterName = name?.trim();
    if (!parameterName) {
      continue;
    }

    parsed[parameterName] = this.parseMalformedArgumentValue(valueParts.join("=").trim());
  }

  return parsed;
}

private parseMalformedArgumentValue(value: string): unknown {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) && value !== "" ? numberValue : value;
}
```

注意这里有一个安全边界：只有工具名已经在 `ToolRegistry` 里注册过，Agent 才会恢复并执行。否则它仍然会失败，而不是执行一个模型临时编出来的函数名。

这里有两个保存动作要区分：

1. `messages.push(...)`：保存到本次 `run()` 的临时消息链里。
2. `this.saveTurn(...)`：保存到 Agent 的长期历史里。

临时消息链包含工具调用细节。长期历史只保存用户输入和最终回答。

## 16. 主循环第四步：追加 assistant tool_calls 消息

如果模型返回了标准 `toolCalls`，或者我们从 provider 的 malformed refusal 里恢复出了 `toolCalls`，都必须先把 assistant message 放进 messages：

```ts
messages.push(this.createAssistantToolCallMessage(response.content, toolCalls));
```

辅助方法是：

```ts
private createAssistantToolCallMessage(content: string, toolCalls: OpenAIToolCall[]): ChatMessage {
  return {
    role: "assistant",
    content,
    tool_calls: toolCalls,
  };
}
```

这一步不能省。

OpenAI-compatible 协议要求：每条 `role: "tool"` 消息前面，必须有一条 assistant message 声明它对应的 `tool_calls`。如果只追加 tool 结果，不追加 assistant tool_calls，下一轮请求很可能被服务端拒绝。

正确顺序是：

```text
user: 请计算报价
assistant: tool_calls=[call_123]
tool: tool_call_id=call_123, content=...
assistant: 最终回答
```

## 17. 主循环第五步：解析 arguments

每个 tool call 形如：

```ts
{
  id: "call_123",
  type: "function",
  function: {
    name: "quote_calculator",
    arguments: "{\"unitPrice\":1299,\"quantity\":8,\"discountRate\":0.18}"
  }
}
```

`arguments` 是字符串，需要解析成对象：

```ts
private parseFunctionCallArguments(argumentsText: string | undefined): ToolParameters {
  if (!argumentsText) {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return isToolParameters(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
```

辅助判断：

```ts
function isToolParameters(value: unknown): value is ToolParameters {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

如果模型返回了非法 JSON，这里先返回 `{}`。工具执行层会把错误作为字符串结果回填给模型，模型有机会基于错误继续修正。

## 18. 主循环第六步：执行工具并追加 tool 消息

执行每个工具：

```ts
const result = await executeRegisteredToolWithParameters(this.toolRegistry, toolName, parsedArguments);
```

然后追加 tool message：

```ts
messages.push({
  role: "tool",
  content: result,
  name: toolName,
  tool_call_id: toolCall.id,
});
```

这里的 `tool_call_id` 必须等于模型返回的 `toolCall.id`。模型可能一次返回多个工具调用，所以每个工具结果都要通过 id 对齐。

同时触发事件：

```ts
onStep?.({
  iteration: currentIteration + 1,
  type: "tool-result",
  content: result,
  toolName,
  toolCallId: toolCall.id,
  arguments: parsedArguments,
});
```

这一轮所有工具执行完成后，循环继续。下一次请求模型时，`messages` 已经包含工具结果，模型就能生成最终回答，或者继续请求调用别的工具。

## 19. 为什么要限制 maxToolIterations

工具循环必须有上限：

```ts
while (currentIteration < maxToolIterations) {
  ...
  currentIteration += 1;
}
```

原因很简单：模型可能反复要求调用工具。比如工具返回错误，模型继续重试；或者模型没判断好，重复调用同一个工具。没有上限就可能变成无限循环。

默认值是：

```ts
this.maxToolIterations = options.maxToolIterations ?? 3;
```

每次运行时也可以覆盖：

```ts
await agent.run(task, {
  maxToolIterations: 5,
});
```

超过上限后，我们再发一次最终整理请求：

```ts
const finalResponse = await this.requestFinalResponse(messages, llmOptions);
return this.finishRun(inputText, messages, finalResponse.content, currentIteration + 1, onStep, finalResponse);
```

`requestFinalResponse()` 会刻意移除 `tools` 和 `tool_choice`：

```ts
private async requestFinalResponse(
  messages: ChatMessage[],
  llmOptions: Record<string, unknown>,
): Promise<LLMMessageResponse> {
  const finalOptions = { ...llmOptions };
  delete finalOptions.tools;
  delete finalOptions.tool_choice;
  return this.llm.invokeMessage(messages, finalOptions);
}
```

这里不要传 `tools`，也不要传 `tool_choice: "none"`。在标准 OpenAI-compatible 服务里，`tool_choice: "none"` 的意思是“本轮不要调用工具”。但一些兼容层对这个组合支持不好：当请求里同时有 `tools` 和 `tool_choice: "none"` 时，模型仍可能尝试返回工具调用，服务再把它包装成空 `content` 或 `refusal`。对最终整理请求来说，最稳妥的方式是直接不提供工具列表，让模型只能基于已有消息生成普通文本。

`finishRun()` 负责最后的保存和事件通知：

```ts
private finishRun(
  inputText: string,
  messages: ChatMessage[],
  content: string,
  iteration: number,
  onStep?: (event: FunctionCallStepEvent) => void,
  response?: LLMMessageResponse,
): string {
  if (content.trim().length === 0) {
    throw this.createEmptyFinalResponseError(response);
  }

  messages.push({ role: "assistant", content });
  onStep?.({
    iteration,
    type: "finish",
    content,
  });
  this.saveTurn(inputText, content);
  return content;
}
```

这一步保证只有非空文本会进入长期历史。如果模型服务返回空结果，调用方会得到明确异常，而不是一条看起来“成功生成”但内容为空的回复。

## 20. 长期历史如何保存

`FunctionCallAgent` 最后调用：

```ts
private saveTurn(inputText: string, response: string): void {
  this.addMessage(new Message(inputText, "user"));
  this.addMessage(new Message(response, "assistant"));
}
```

长期历史只保存两条：

```text
user: 本轮用户输入
assistant: 本轮最终回答
```

为什么不把 tool_calls 和 tool results 也保存进去？

因为 tool_calls 是本轮执行协议，不一定适合作为下一轮对话上下文长期保留。它里面可能包含内部工具名、工具参数、业务规则、中间错误。普通聊天历史应该尽量干净，只保留用户看得懂的最终答案。

如果应用需要审计工具调用，可以在 `onStep` 里把事件保存到数据库，而不是塞进 `Agent.history`。

## 21. 为什么 streamRun 先回退到 run

普通流式输出只需要处理：

```text
delta.content
```

Function calling 的流式输出更复杂。模型可能把工具参数拆成多段：

```text
delta.tool_calls[0].function.arguments = "{\"unit"
delta.tool_calls[0].function.arguments = "Price\":1299"
delta.tool_calls[0].function.arguments = ",\"quantity\":8}"
```

真实流式 function calling 需要：

1. 按 tool call index 聚合参数片段。
2. 拼完整 function name。
3. 判断 arguments JSON 是否完整。
4. 执行工具。
5. 追加 tool message。
6. 再发起下一轮 streaming 请求。

这会让第一版复杂很多。所以本章先实现：

```ts
async *streamRun(inputText: string, options: FunctionCallAgentRunOptions = {}): AsyncGenerator<string> {
  yield await this.run(inputText, options);
}
```

它不是逐 token streaming，而是保持和其他 Agent 一致的 `streamRun()` 方法形状。后续可以单独实现真正的 tool-call streaming。

## 22. 导出 SDK API

最后更新 `src/index.ts`。

导出类：

```ts
export { FunctionCallAgent } from "./agents/function-call-agent.js";
```

导出 LLM 返回类型和 tool call 类型：

```ts
export type {
  ChatMessage,
  HelloAgentsLLMOptions,
  LLMMessageResponse,
  OpenAICompatibleClient,
  SupportedProvider,
} from "./core/llm.js";

export type { MessageOptions, MessageRole, OpenAIMessage, OpenAIToolCall } from "./core/message.js";
```

导出 Agent 类型：

```ts
export type {
  FunctionCallAgentOptions,
  FunctionCallAgentRunOptions,
  FunctionCallStepEvent,
  FunctionCallStepEventType,
  FunctionCallToolChoice,
} from "./agents/function-call-agent.js";
```

导出新的工具执行函数：

```ts
export {
  executeRegisteredTool,
  executeRegisteredToolWithParameters,
  parseToolParameters,
} from "./tools/executor.js";
```

这样用户可以从统一入口导入所有公开能力。

## 23. 写一个真实 example

新增文件：

```text
examples/06-function-call-agent.mjs
```

这个示例继续使用 B2B SaaS 报价场景。它注册三个工具：

1. `quote_calculator`：计算小计、折扣、应付金额。
2. `discount_approval_checker`：判断折扣是否需要审批。
3. `payment_schedule_builder`：生成付款计划。

初始化 LLM：

```js
const llm = new HelloAgentsLLM({
  provider: process.env.LLM_PROVIDER ?? "local",
  temperature: config.temperature,
  maxTokens: config.maxTokens,
});
```

创建注册表：

```js
const registry = new ToolRegistry();
registry.registerTool(new QuoteCalculatorTool());
registry.registerTool(new DiscountApprovalTool());
registry.registerTool(new PaymentScheduleTool());
```

创建 Agent：

```js
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
```

运行：

```js
const answer = await agent.run(task, {
  maxToolIterations: 5,
  toolChoice: "auto",
  temperature: 0.2,
  onStep: printFunctionCallStep,
});
```

这里的 `onStep` 会打印工具调用过程：

```js
function printFunctionCallStep(event) {
  if (event.type === "tool-call") {
    console.log(`  - 模型请求调用工具：${event.toolName}`);
    console.log(`    参数：${JSON.stringify(event.arguments)}`);
    return;
  }

  if (event.type === "tool-result") {
    console.log(`    结果：${event.content}`);
    return;
  }
}
```

真实产品里可以把这些事件展示成“正在计算报价”“正在检查审批要求”“正在生成付款计划”。普通用户不一定需要看到原始工具名和参数，但开发阶段打印出来有助于理解链路。

## 24. 运行验证

先构建 SDK：

```bash
pnpm build
```

准备 example 环境变量：

```bash
cp examples/.env.example examples/.env
```

编辑 `examples/.env`，填入真实模型服务配置。这个示例需要模型服务支持 OpenAI-compatible `tools` 参数。如果你的本地模型服务不支持 function calling，它可能会忽略工具、报错，或者返回普通文本。

运行：

```bash
node examples/06-function-call-agent.mjs
```

正常情况下你会看到类似输出：

```text
provider : local
baseUrl  : http://localhost:8000/v1
model    : local-model

tools    : quote_calculator, discount_approval_checker, payment_schedule_builder

========== FunctionCallAgent 原生函数调用 ==========

用户：
客户要采购 8 套企业版授权，每套 1299 元，销售希望给 18% 折扣。
...

执行进度：
  - 模型请求调用工具：quote_calculator
    参数：{"unitPrice":1299,"quantity":8,"discountRate":0.18}
    结果：小计 10392.00 元，折扣 1870.56 元，应付 8521.44 元。
  - 模型请求调用工具：discount_approval_checker
    参数：{"discountRate":0.18,"payable":8521.44}
    结果：销售经理审批。发送客户前需要销售经理确认。
  - 模型请求调用工具：payment_schedule_builder
    参数：{"payable":8521.44,"installments":3,"upfrontRate":0.4}
    结果：合同签署后 3408.58 元；第 2 期 2556.43 元；第 3 期 2556.43 元。
  - 最终回复已生成。
```

最后会打印最终业务回答和长期历史消息数：

```text
可观测状态：
长期历史消息数：2
```

长期历史是 2，说明本轮内部工具调用没有写入长期聊天历史。

## 25. 和 SimpleAgent、ReActAgent 的区别

现在我们有三种工具 Agent。

`SimpleAgent` 的特点是轻：

```text
工具说明写进 prompt
模型输出 [TOOL_CALL:name:params]
Agent 用正则解析
```

它适合最小教学和简单助手。

`ReActAgent` 的特点是过程清晰：

```text
Thought
Action
Observation
Finish
```

它适合需要多步探索、想观察推理行动过程的任务。

`FunctionCallAgent` 的特点是结构化：

```text
tools schema
assistant.tool_calls
role: "tool"
final assistant answer
```

它适合模型和服务端都支持 OpenAI-compatible function calling 的场景。工具调用比文本协议更稳定，参数也更结构化。

三者不是互相替代，而是适合不同阶段：

1. 想理解 Agent 工具循环，先看 `SimpleAgent`。
2. 想理解推理和行动的迭代过程，看 `ReActAgent`。
3. 想在支持工具调用的模型上做更稳的生产链路，用 `FunctionCallAgent`。

## 26. 本章小结

这一章我们实现了 FunctionCallAgent 的完整闭环：

1. 扩展 `OpenAIMessage`，支持 `tool_calls` 和 `tool_call_id`。
2. 在 `HelloAgentsLLM` 中增加 `invokeMessage()`，返回完整 assistant message。
3. 在 `ToolRegistry` 中增加 `getOpenAIToolSchemas()`。
4. 在 `tools/executor.ts` 中增加 `executeRegisteredToolWithParameters()`。
5. 新增 `FunctionCallAgent`，实现 `tools -> tool_calls -> tool result -> final answer` 循环。
6. 保持长期历史干净，只保存用户输入和最终回答。
7. 新增真实 example，通过报价场景验证原生函数调用。

到这里，SDK 已经具备三条不同层次的工具调用路径：文本工具协议、ReAct 行动协议、OpenAI-compatible 原生函数调用。后续可以继续扩展内置工具、真正的 streaming function calling，或者围绕工具调用做评估和可观测性。
