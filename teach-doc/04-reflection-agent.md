# 从0构建SDK第4节：实现 ReflectionAgent 的自我反思循环

上一节我们实现了 `ReActAgent`。

`ReActAgent` 的重点是“推理与行动”：模型先分析问题，再选择工具行动，工具返回观察结果后，模型继续推理，直到用 `Finish[...]` 给出最终答案。

这一节我们换一个经典 Agent 范式：`ReflectionAgent`。

`ReflectionAgent` 不依赖工具。它解决的问题也不是“我需要外部数据”，而是“我已经有了一个答案，但这个答案可能还不够好”。它会让模型先完成任务，再让模型审查自己的回答，然后根据审查意见重新改写。这个过程可以循环多次，直到模型认为“无需改进”，或者达到最大迭代次数。

本节要实现的链路是：

```text
用户任务
  -> 初始回答
  -> 反思反馈
  -> 判断是否无需改进
  -> 优化回答
  -> 再次反思
  -> 最终回答
```

这类 Agent 适合写作、代码生成、方案分析、报告整理等任务。它不一定需要调用工具，但它需要更好的“自我评审”和“自我修订”流程。

## 1. 本节目标

完成这一节后，我们的 SDK 会新增：

```ts
import { HelloAgentsLLM, ReflectionAgent } from "helloagent-js";

const llm = new HelloAgentsLLM();

const agent = new ReflectionAgent({
  name: "反思助手",
  llm,
  maxIterations: 2,
});

const answer = await agent.run("解释什么是递归算法，并给出一个 TypeScript 例子。");
console.log(answer);
```

这段代码看起来很短，但内部会完成四件事：

1. 组装初始任务 prompt，让模型给出第一版回答。
2. 保存第一版回答到短期记忆。
3. 组装反思 prompt，让模型审查当前回答。
4. 如果需要改进，就组装优化 prompt，生成新版本回答。

最后，`ReflectionAgent` 会把用户原始输入和最终答案写入 `Agent` 基类的长期历史。

这里要特别区分两个概念：

- 长期历史：`Agent` 基类里的 `history`，保存用户和助手之间的对话回合。
- 短期记忆：`ReflectionAgent` 单次运行时的 `ReflectionMemory`，保存本轮任务里的初稿、反馈和优化稿。

长期历史用于多轮会话。短期记忆用于一次任务内部的反思轨迹。它们不能混在一起。

## 2. 本节目录结构

实现完成后，本节会新增或修改这些文件：

```text
src/
  agents/
    reflection-agent.ts      # ReflectionAgent、ReflectionMemory 和默认提示词
  index.ts                   # SDK 统一导出 ReflectionAgent

examples/
  04-reflection-agent.mjs    # 真实模型运行示例
  README.md                  # 增加示例运行说明

teach-doc/
  04-reflection-agent.md     # 本节教程
```

这次不会改 `HelloAgentsLLM`。

原因是 `ReflectionAgent` 只是在上层组织多次 LLM 调用。底层 LLM 客户端已经能接收 messages 并返回字符串，不需要为了反思流程增加新的模型接口。

这次也不会改工具系统。

`ReflectionAgent` 的核心能力不是工具调用，而是同一个模型在不同 prompt 角色下完成“生成、评审、修订”。如果现在把工具也加进来，这一节的主线会变得不清晰。工具能力已经由 `SimpleAgent` 和 `ReActAgent` 展示过了。

## 3. 为什么需要 ReflectionAgent

先看普通 `SimpleAgent` 的工作方式：

```text
用户输入
  -> LLM
  -> 返回答案
```

这个流程很直接，但它有一个问题：模型只回答一次。

如果第一次回答里有遗漏、结构不好、边界条件没有覆盖，`SimpleAgent` 不会主动检查。用户只能继续追问：“你再检查一下”“这里是不是漏了某种情况”。

`ReflectionAgent` 把这个追问过程内置到 Agent 里。

它让模型先扮演“执行者”：

```text
请根据以下要求完成任务：

任务: {task}

请提供一个完整、准确的回答。
```

然后让模型再扮演“评审者”：

```text
请仔细审查以下回答，并找出可能的问题或改进空间：

# 原始任务:
{task}

# 当前回答:
{content}

请分析这个回答的质量，指出不足之处，并提出具体的改进建议。
如果回答已经很好，请回答"无需改进"。
```

如果评审者指出问题，就让模型再次扮演“修订者”：

```text
请根据反馈意见改进你的回答：

# 原始任务:
{task}

# 上一轮回答:
{last_attempt}

# 反馈意见:
{feedback}

请提供一个改进后的回答。
```

这就是 Reflection 的核心。不是换了一个模型，也不是加了神秘模块，而是用清晰的 prompt 分工，让模型在同一个任务中完成多个阶段。

## 4. 新建 `src/agents/reflection-agent.ts`

先创建文件：

```text
src/agents/reflection-agent.ts
```

文件开头引入四个模块：

```ts
import { Agent } from "../core/agent.js";
import type { AgentOptions } from "../core/agent.js";
import type { ChatMessage } from "../core/llm.js";
import { Message } from "../core/message.js";
```

这里的职责很明确：

- `Agent`：让 `ReflectionAgent` 继承统一的 Agent 基类。
- `AgentOptions`：复用 `name`、`llm`、`systemPrompt`、`config` 这些基础构造参数。
- `ChatMessage`：调用 `HelloAgentsLLM.invoke()` 时要传入标准消息数组。
- `Message`：最终把用户输入和最终答案写回长期历史。

注意 TypeScript 项目使用 NodeNext ESM，所以本地导入必须写 `.js` 后缀。虽然源码文件是 `.ts`，但编译后的运行文件是 `.js`，因此导入路径要面向运行时。

## 5. 定义三段 Prompt 模板

`ReflectionAgent` 需要三类 prompt。

第一类是初始回答：

```ts
export interface ReflectionPrompts {
  initial: string;
  reflect: string;
  refine: string;
}
```

这里先定义一个接口，而不是直接写普通对象。原因是用户后面可以传入自定义 prompt。我们需要明确告诉 TypeScript：自定义 prompt 必须包含 `initial`、`reflect`、`refine` 三个键。

接着定义默认模板：

```ts
export const DEFAULT_REFLECTION_PROMPTS: ReflectionPrompts = {
  initial: `
请根据以下要求完成任务：

任务: {task}

请提供一个完整、准确的回答。
`,
  reflect: `
请仔细审查以下回答，并找出可能的问题或改进空间：

# 原始任务:
{task}

# 当前回答:
{content}

请分析这个回答的质量，指出不足之处，并提出具体的改进建议。
如果回答已经很好，请回答"无需改进"。
`,
  refine: `
请根据反馈意见改进你的回答：

# 原始任务:
{task}

# 上一轮回答:
{last_attempt}

# 反馈意见:
{feedback}

请提供一个改进后的回答。
`,
};
```

模板里有四个占位符：

- `{task}`：用户原始任务。
- `{content}`：当前要被审查的回答。
- `{last_attempt}`：上一轮回答。
- `{feedback}`：反思阶段给出的反馈意见。

这四个占位符就是整个反思循环的数据流。

初始阶段只有 `{task}`。

反思阶段需要 `{task}` 和 `{content}`，因为模型既要知道原始要求，也要看到当前回答。

优化阶段需要 `{task}`、`{last_attempt}` 和 `{feedback}`，因为模型要知道自己要解决什么问题、上一版是什么、评审意见是什么。

## 6. 实现短期记忆 `ReflectionMemory`

`ReflectionAgent` 的一次运行内部会产生多条记录：

```text
execution  -> 初始回答
reflection -> 第一轮反馈
execution  -> 第一轮优化回答
reflection -> 第二轮反馈
execution  -> 第二轮优化回答
```

这些记录不应该全部写进长期对话历史。

如果把每一次反思反馈、每一次中间草稿都写入 `Agent.history`，下一轮用户对话会带上大量内部过程。这样既浪费上下文，也会让用户本来只想基于最终答案继续对话，却被中间草稿干扰。

所以我们新建一个短期记忆类。

先定义记录类型：

```ts
export type ReflectionRecordType = "execution" | "reflection";

export interface ReflectionRecord {
  type: ReflectionRecordType;
  content: string;
}
```

`execution` 表示模型生成的回答，包括初稿和优化稿。

`reflection` 表示模型给出的评审反馈。

然后实现 `ReflectionMemory`：

```ts
export class ReflectionMemory {
  private readonly records: ReflectionRecord[];

  constructor() {
    this.records = [];
  }

  addRecord(recordType: ReflectionRecordType, content: string): void {
    this.records.push({ type: recordType, content });
  }

  getRecords(): ReflectionRecord[] {
    return this.records.map((record) => ({ ...record }));
  }
}
```

这里 `getRecords()` 返回的是浅拷贝。调用方可以读取记录，但不能直接修改内部数组。

接着实现轨迹格式化：

```ts
getTrajectory(): string {
  const trajectory: string[] = [];

  for (const record of this.records) {
    if (record.type === "execution") {
      trajectory.push(`--- 上一轮尝试 (代码) ---\n${record.content}`);
    } else if (record.type === "reflection") {
      trajectory.push(`--- 评审员反馈 ---\n${record.content}`);
    }
  }

  return trajectory.join("\n\n").trim();
}
```

当前 `run()` 主流程不会直接依赖完整轨迹。它每次只需要最近一版回答和当前反馈。

但保留 `getTrajectory()` 有两个价值：

1. 示例或调试代码可以查看完整内部轨迹。
2. 后续如果要做更复杂的反思 prompt，可以把完整轨迹放进去。

最后实现获取最近一次执行结果：

```ts
getLastExecution(): string {
  for (let index = this.records.length - 1; index >= 0; index -= 1) {
    const record = this.records[index];
    if (record?.type === "execution") {
      return record.content;
    }
  }

  return "";
}
```

这里从后往前找。因为反思循环里会不断追加记录，最后一个 `execution` 就是当前最好的答案。

如果还没有任何执行记录，就返回空字符串。

## 7. 定义运行事件

Python 风格的脚本经常会在 Agent 内部直接 `print()`：

```text
正在进行初始尝试
正在进行反思
正在进行优化
```

在 SDK 里不建议这样做。

库代码默认打印日志，会影响调用方自己的控制台输出。更好的方式是提供一个可选回调，把内部进度交给调用方决定怎么展示。

所以我们定义事件类型：

```ts
export type ReflectionStepEventType = "initial" | "reflection" | "refine" | "finish";

export interface ReflectionStepEvent {
  iteration: number;
  type: ReflectionStepEventType;
  content: string;
}
```

四类事件分别表示：

- `initial`：初始回答生成完成。
- `reflection`：某一轮反思反馈生成完成。
- `refine`：某一轮优化回答生成完成。
- `finish`：最终结果已经确定并写入历史。

`iteration` 的含义也很简单：

- 初始回答还没有进入迭代，所以是 `0`。
- 第一轮反思和优化是 `1`。
- 第二轮反思和优化是 `2`。
- 以此类推。

## 8. 定义构造参数和运行参数

`ReflectionAgent` 的构造参数继承 `AgentOptions`：

```ts
export interface ReflectionAgentOptions extends AgentOptions {
  maxIterations?: number;
  customPrompts?: ReflectionPrompts;
}
```

新增两个字段：

- `maxIterations`：默认最大反思轮数。
- `customPrompts`：自定义三段 prompt。

运行参数单独定义：

```ts
export interface ReflectionAgentRunOptions extends Record<string, unknown> {
  maxIterations?: number;
  onStep?: (event: ReflectionStepEvent) => void;
}
```

为什么运行参数也允许 `maxIterations`？

因为实际使用时，Agent 可能有一个默认迭代次数，但某一次任务更简单，只想临时跑一轮；或者某一次任务更重要，希望临时多跑两轮。

构造参数是默认值，运行参数是本次覆盖。

`onStep` 是可选进度回调。它不是完成反思逻辑必需的，但对 example 和应用界面很有用。

除了 `maxIterations` 和 `onStep` 之外，剩下的运行参数会继续传给 `llm.invoke()`。例如：

```ts
await agent.run("写一个说明文", {
  temperature: 0.3,
  maxTokens: 4096,
});
```

这里的 `temperature`、`maxTokens` 会进入 LLM 调用。

## 9. 实现 ReflectionAgent 构造函数

现在开始写类：

```ts
export class ReflectionAgent extends Agent {
  private readonly maxIterations: number;
  private readonly prompts: ReflectionPrompts;
  private memory: ReflectionMemory;

  constructor(options: ReflectionAgentOptions) {
    super(options);
    this.maxIterations = options.maxIterations ?? 3;
    this.prompts = options.customPrompts ?? DEFAULT_REFLECTION_PROMPTS;
    this.memory = new ReflectionMemory();
  }
}
```

这里有三个私有字段。

`maxIterations` 保存默认最大迭代次数。如果用户不传，就用 `3`。

`prompts` 保存当前 Agent 使用的 prompt 模板。如果用户传了 `customPrompts`，就使用用户自定义模板；否则使用默认模板。

`memory` 保存单次运行的短期轨迹。虽然构造函数里初始化了一次，但每次 `run()` 开始时还会重置。这样每个任务都有干净的反思轨迹。

## 10. `run()` 的第一步：重置记忆并生成初稿

`run()` 是 `ReflectionAgent` 的核心。

先看开头：

```ts
async run(inputText: string, options: ReflectionAgentRunOptions = {}): Promise<string> {
  const { maxIterations = this.maxIterations, onStep, ...llmOptions } = options;
  this.memory = new ReflectionMemory();

  const initialPrompt = this.renderPrompt(this.prompts.initial, {
    task: inputText,
  });
  const initialResult = await this.getLLMResponse(initialPrompt, llmOptions);
  this.memory.addRecord("execution", initialResult);
  onStep?.({
    iteration: 0,
    type: "initial",
    content: initialResult,
  });
```

第一行解构参数：

- `maxIterations`：本次运行的最大迭代次数。如果调用时没传，就用构造函数里的默认值。
- `onStep`：进度回调。
- `llmOptions`：剩下的参数，全部传给 LLM。

然后重置短期记忆：

```ts
this.memory = new ReflectionMemory();
```

这是必须的。因为同一个 Agent 实例可能连续运行多个任务。每个任务的反思轨迹应该互不影响。

接着用 `initial` 模板渲染初始 prompt：

```ts
const initialPrompt = this.renderPrompt(this.prompts.initial, {
  task: inputText,
});
```

这一步只是把模板里的 `{task}` 替换成用户输入。

然后调用模型：

```ts
const initialResult = await this.getLLMResponse(initialPrompt, llmOptions);
```

返回后，把初稿保存为一条 `execution` 记录：

```ts
this.memory.addRecord("execution", initialResult);
```

如果调用方传了 `onStep`，就把初稿交给调用方：

```ts
onStep?.({
  iteration: 0,
  type: "initial",
  content: initialResult,
});
```

## 11. `run()` 的第二步：进入反思循环

初稿生成后，开始循环。

```ts
let completedIterations = 0;

for (let currentIteration = 1; currentIteration <= maxIterations; currentIteration += 1) {
  completedIterations = currentIteration;

  const lastResult = this.memory.getLastExecution();
  const reflectPrompt = this.renderPrompt(this.prompts.reflect, {
    task: inputText,
    content: lastResult,
  });
  const feedback = await this.getLLMResponse(reflectPrompt, llmOptions);
  this.memory.addRecord("reflection", feedback);
  onStep?.({
    iteration: currentIteration,
    type: "reflection",
    content: feedback,
  });
```

每一轮循环先取最近一次回答：

```ts
const lastResult = this.memory.getLastExecution();
```

第一次循环时，它就是初稿。

第二次循环时，它可能是第一轮优化后的答案。

然后组装反思 prompt：

```ts
const reflectPrompt = this.renderPrompt(this.prompts.reflect, {
  task: inputText,
  content: lastResult,
});
```

反思阶段必须同时给模型两个信息：

1. 原始任务是什么。
2. 当前回答是什么。

如果只给当前回答，模型可能不知道原始要求，评审就会失焦。

反思结果返回后，保存为 `reflection`：

```ts
this.memory.addRecord("reflection", feedback);
```

并触发事件：

```ts
onStep?.({
  iteration: currentIteration,
  type: "reflection",
  content: feedback,
});
```

## 12. 判断是否提前停止

反思反馈生成后，先判断是否需要停止。

```ts
if (this.shouldStop(feedback)) {
  break;
}
```

`shouldStop()` 很简单：

```ts
private shouldStop(feedback: string): boolean {
  return feedback.includes("无需改进") || feedback.toLowerCase().includes("no need for improvement");
}
```

默认 prompt 明确要求模型：

```text
如果回答已经很好，请回答"无需改进"。
```

所以这里用中文 `无需改进` 作为停止信号。

同时也兼容英文：

```text
no need for improvement
```

这是为了避免英文模型或者英文 prompt 场景下无法提前停止。

注意，这里没有做复杂评分，也没有让模型输出 JSON。

原因是本节目标是先实现基础 Reflection 范式。质量评分、阈值判断、结构化反馈都可以作为后续增强，但第一版应该保持流程清晰。

## 13. 如果需要改进，就生成优化稿

如果反思反馈没有触发停止，就进入优化阶段：

```ts
const refinePrompt = this.renderPrompt(this.prompts.refine, {
  task: inputText,
  last_attempt: lastResult,
  feedback,
});
const refinedResult = await this.getLLMResponse(refinePrompt, llmOptions);
this.memory.addRecord("execution", refinedResult);
onStep?.({
  iteration: currentIteration,
  type: "refine",
  content: refinedResult,
});
```

优化 prompt 需要三个输入：

- `task`：原始任务。
- `last_attempt`：上一轮回答。
- `feedback`：刚刚得到的反思反馈。

模型根据这三部分生成新版本回答。

优化结果仍然保存为 `execution`，因为它本质上是一次新的回答。

这样下一轮反思时：

```ts
this.memory.getLastExecution();
```

拿到的就是最新优化稿。

## 14. `run()` 的最后一步：保存最终回答

循环结束后，取最近一次执行结果：

```ts
const finalResult = this.memory.getLastExecution();
this.saveTurn(inputText, finalResult);
onStep?.({
  iteration: completedIterations,
  type: "finish",
  content: finalResult,
});

return finalResult;
```

无论循环是因为达到最大次数结束，还是因为反思反馈说“无需改进”而提前结束，最终答案都应该是最近一次 `execution`。

然后调用 `saveTurn()`：

```ts
private saveTurn(inputText: string, response: string): void {
  this.addMessage(new Message(inputText, "user"));
  this.addMessage(new Message(response, "assistant"));
}
```

这里只写两条长期历史：

1. 用户原始输入。
2. 最终答案。

不会把中间反思反馈写入长期历史。

这点很重要。

下一轮用户继续对话时，他通常关心的是最终答案，而不是内部每一轮草稿。如果应用层需要展示内部轨迹，可以通过 `getMemoryRecords()` 或 `getTrajectory()` 读取。

## 15. LLM 调用为什么只发送一条 user message

`ReflectionAgent` 的 LLM 调用方法是：

```ts
private async getLLMResponse(prompt: string, options: Record<string, unknown>): Promise<string> {
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  return await this.llm.invoke(messages, options);
}
```

这和 `SimpleAgent`、`ReActAgent` 不太一样。

`SimpleAgent` 会组装：

```text
system prompt
历史消息
当前用户输入
```

`ReActAgent` 也会组装：

```text
system prompt
长期历史
当前 ReAct prompt
```

但 `ReflectionAgent` 的每个阶段本身就是完整 prompt。

例如反思阶段的 prompt 已经包含：

- 原始任务。
- 当前回答。
- 反思要求。

优化阶段的 prompt 也已经包含：

- 原始任务。
- 上一轮回答。
- 反馈意见。
- 优化要求。

因此这里每次只发送一条 user message。这样流程更直接，也更容易理解每一次 LLM 调用在做什么。

长期历史仍然会保存最终对话结果，只是不参与单次反思内部的 prompt 拼接。

## 16. Prompt 渲染方法

模板渲染用一个小方法完成：

```ts
private renderPrompt(template: string, values: Record<string, string>): string {
  let rendered = template;

  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }

  return rendered;
}
```

这里不引入模板引擎。

原因是当前占位符非常简单，只需要把 `{task}`、`{content}`、`{last_attempt}`、`{feedback}` 替换成字符串。

如果后续要支持条件块、循环、转义规则，再考虑引入更完整的模板系统。现在直接用 `replaceAll()` 最清楚。

## 17. 暴露内部轨迹读取方法

`ReflectionAgent` 提供两个读取方法：

```ts
getMemoryRecords(): ReflectionRecord[] {
  return this.memory.getRecords();
}

getTrajectory(): string {
  return this.memory.getTrajectory();
}
```

`getMemoryRecords()` 适合程序处理。返回结构化数组：

```ts
[
  { type: "execution", content: "第一版回答..." },
  { type: "reflection", content: "评审反馈..." },
  { type: "execution", content: "优化后的回答..." },
]
```

`getTrajectory()` 适合日志或调试输出。返回格式化后的文本：

```text
--- 上一轮尝试 (代码) ---
第一版回答...

--- 评审员反馈 ---
评审反馈...

--- 上一轮尝试 (代码) ---
优化后的回答...
```

这两个方法都只读取最近一次 `run()` 的短期轨迹。

下一次调用 `run()` 时，短期记忆会重置。

## 18. 导出 SDK API

实现完 `src/agents/reflection-agent.ts` 后，需要在 `src/index.ts` 中导出：

```ts
export { DEFAULT_REFLECTION_PROMPTS, ReflectionAgent, ReflectionMemory } from "./agents/reflection-agent.js";
```

同时导出类型：

```ts
export type {
  ReflectionAgentOptions,
  ReflectionAgentRunOptions,
  ReflectionPrompts,
  ReflectionRecord,
  ReflectionRecordType,
  ReflectionStepEvent,
  ReflectionStepEventType,
} from "./agents/reflection-agent.js";
```

这样用户就可以直接从包入口导入：

```ts
import { ReflectionAgent } from "helloagent-js";
```

而不需要写内部路径：

```ts
import { ReflectionAgent } from "helloagent-js/dist/agents/reflection-agent.js";
```

SDK 的入口文件应该保持薄，但它需要完整导出公共 API。新增 Agent 后不要忘记这个步骤。

## 19. 运行真实示例

本节新增：

```text
examples/04-reflection-agent.mjs
```

这个示例仍然使用真实 LLM，而不是 mock。

先加载 `examples/.env`：

```js
import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });
```

然后从构建后的 SDK 导入：

```js
import { Config, HelloAgentsLLM, ReflectionAgent } from "../dist/index.js";
```

示例使用 `Config` 管理温度、最大 token 和历史长度：

```js
const config = new Config({
  temperature: Number(process.env.TEMPERATURE ?? 0.2),
  maxTokens: Number(process.env.MAX_TOKENS ?? 4096),
  maxHistoryLength: 20,
});
```

初始化真实 LLM：

```js
const llm = new HelloAgentsLLM({
  provider: process.env.LLM_PROVIDER ?? "local",
  temperature: config.temperature,
  maxTokens: config.maxTokens,
});
```

这里默认使用 `local`，和前面 examples 保持一致。你也可以在 `examples/.env` 里设置 `LLM_PROVIDER`，让它走其他 OpenAI 兼容服务。

## 20. 示例一：默认提示词

创建默认 `ReflectionAgent`：

```js
const generalAgent = new ReflectionAgent({
  name: "通用反思助手",
  llm,
  config,
  maxIterations: 1,
});
```

这里示例只跑一轮反思，目的是避免一次运行消耗太多模型调用。

一次 `maxIterations: 1` 的完整流程是：

```text
初始回答 -> 反思 -> 如果需要则优化 -> 最终回答
```

如果反思阶段直接返回“无需改进”，就不会进入优化阶段。

运行任务：

```js
const generalTask = "解释什么是递归算法，并给出一个适合初学者理解的 TypeScript 例子。";

const generalAnswer = await generalAgent.run(generalTask, {
  onStep: printReflectionStep,
});
```

`printReflectionStep` 根据事件类型输出进度：

```js
function printReflectionStep(event) {
  if (event.type === "initial") {
    console.log("  - 已生成初始回答。");
    console.log(`    ${preview(event.content)}`);
    return;
  }

  if (event.type === "reflection") {
    console.log(`  - 第 ${event.iteration} 轮反思反馈：`);
    console.log(`    ${preview(event.content)}`);
    return;
  }

  if (event.type === "refine") {
    console.log(`  - 第 ${event.iteration} 轮优化完成。`);
    console.log(`    ${preview(event.content)}`);
    return;
  }

  if (event.type === "finish") {
    console.log("  - 最终结果已写入 Agent 历史。");
  }
}
```

这样 SDK 核心类不打印日志，但示例仍然能看到内部过程。

## 21. 示例二：自定义代码评审提示词

`ReflectionAgent` 的一个典型用途是代码生成。

默认提示词是通用型的。如果我们希望它更像代码助手，可以传入自定义 prompt：

```js
const codePrompts = {
  initial: `
你是一位资深 TypeScript 程序员。请根据以下要求编写代码：

要求: {task}

请提供完整的 TypeScript 实现，包含必要的类型定义和简洁说明。
`,
  reflect: `
你是一位严格的代码评审专家。请审查以下代码：

# 原始任务:
{task}

# 待审查的代码:
{content}

请分析代码质量，包括类型安全、边界处理、可读性和运行复杂度。
如果代码质量良好，请回答"无需改进"。否则请提出具体的改进建议。
`,
  refine: `
请根据代码评审意见优化你的代码：

# 原始任务:
{task}

# 上一轮代码:
{last_attempt}

# 评审意见:
{feedback}

请提供优化后的 TypeScript 代码，并简要说明关键改动。
`,
};
```

这组三段 prompt 和默认 prompt 的结构一样，只是角色更明确：

- `initial`：资深 TypeScript 程序员。
- `reflect`：严格代码评审专家。
- `refine`：根据评审意见优化代码。

创建 Agent：

```js
const codeAgent = new ReflectionAgent({
  name: "代码反思助手",
  llm,
  config,
  customPrompts: codePrompts,
  maxIterations: 1,
});
```

运行任务：

```js
const codeTask = "实现一个 groupBy 函数，接收数组和 key selector，把数组元素按 key 分组。";

const codeAnswer = await codeAgent.run(codeTask, {
  onStep: printReflectionStep,
});
```

这会让模型先写第一版 `groupBy`，再审查类型安全、边界处理、可读性和复杂度，最后按反馈生成优化版。

## 22. 如何运行

先安装依赖并构建 SDK：

```bash
pnpm install
pnpm build
```

安装 examples 依赖：

```bash
cd examples
pnpm install
cd ..
```

准备环境变量：

```bash
cp examples/.env.example examples/.env
```

如果使用本地 OpenAI 兼容服务，可以在 `examples/.env` 里配置：

```bash
LLM_PROVIDER=local
LLM_API_KEY=local
LLM_BASE_URL=http://localhost:8000/v1
LLM_MODEL_ID=local-model
```

运行示例：

```bash
pnpm build
node examples/04-reflection-agent.mjs
```

如果模型服务正常，控制台会看到类似流程：

```text
========== 默认提示词：通用解释任务 ==========

任务：
解释什么是递归算法，并给出一个适合初学者理解的 TypeScript 例子。

反思进度：
  - 已生成初始回答。
  - 第 1 轮反思反馈：
  - 第 1 轮优化完成。
  - 最终结果已写入 Agent 历史。

最终回答：
...
```

具体内容由你的模型决定。

## 23. 本节小结

到这里，我们完成了第四个 Agent 能力：

- `SimpleAgent`：普通对话和简单工具调用。
- `ReActAgent`：推理、行动、观察、完成。
- `ReflectionAgent`：初始回答、反思反馈、优化回答。

`ReflectionAgent` 的关键不在工具，而在流程设计：

1. 用三段 prompt 明确区分生成、评审、修订。
2. 用短期 `ReflectionMemory` 保存单次任务内部轨迹。
3. 用 `maxIterations` 控制循环次数，避免无限优化。
4. 用“无需改进”作为简单停止条件。
5. 只把最终答案写入长期历史，避免中间草稿污染多轮对话上下文。

下一节适合继续实现 `PlanAndSolveAgent`。

`ReflectionAgent` 是“先做出一个答案，再反思改进”。`PlanAndSolveAgent` 则是“先规划步骤，再逐步执行并汇总”。把它放在 Reflection 后面，读者会更容易理解：同样是多步 Agent，循环状态和 prompt 组织方式可以完全不同。
