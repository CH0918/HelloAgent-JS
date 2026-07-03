# 从0构建SDK第8节：实现工具链和异步工具执行

前面几章我们已经逐步实现了工具系统的几种用法：

1. `SimpleAgent`：把工具说明写进提示词，让模型输出 `[TOOL_CALL:name:params]`。
2. `ReActAgent`：让模型按 `Thought -> Action -> Observation` 的方式一步一步行动。
3. `FunctionCallAgent`：使用 OpenAI-compatible `tools` 参数，让模型返回结构化的 `tool_calls`。
4. `SearchTool`：把真实的外部搜索服务封装成 SDK 内置工具。

这些能力已经能覆盖“模型决定什么时候调用哪个工具”的场景。但真实业务里还会遇到另一类需求：有些流程不是让模型自由决定，而是开发者已经知道必须按固定顺序执行。

例如客户成功团队要生成续约风险简报，流程可能是固定的：

```text
客户编号
  -> 查询客户画像
  -> 查询最近30天产品用量
  -> 结合客户画像和用量做风险分析
  -> 输出续约简报
```

这种流程不适合每次都让模型重新规划。因为步骤是确定的，输入输出也是确定的。我们更希望把它封装成一条“工具链”，让它像一个普通工具一样被调用。

另一方面，很多工具天然是异步的。例如搜索、数据库查询、HTTP API、文件上传、任务轮询。TypeScript 里这类操作通常返回 `Promise`。我们的 `Tool.run()` 在第2章就已经设计成：

```ts
export type ToolResult = string | Promise<string>;
```

这意味着普通同步工具和异步工具可以共用同一个接口。本章要做的不是重写工具接口，而是在现有基础上补两个高级能力：

1. `ToolChain`：多个工具按顺序执行，后续步骤能引用前面步骤结果。
2. `AsyncToolExecutor`：多个互不依赖的工具任务并发执行，适合批量查询。

这章完成后，工具系统会多出两种组织方式：

```text
单个工具
  Tool.run(parameters)

顺序工具链
  ToolChain.execute(registry, input)

并行工具任务
  AsyncToolExecutor.executeToolsParallel(tasks)
```

## 1. 本章最终效果

写完本章后，我们可以这样定义一条续约风险工具链：

```js
import { ToolChain, ToolChainManager, ToolRegistry } from "helloagent-js";

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

const result = await chainManager.executeChain("renewal_brief_builder", "C-2048");
console.log(result.result);
```

这条链有三个步骤：

1. `customer_profile` 用客户编号查客户画像，输出保存到 `profile`。
2. `usage_summary` 用客户编号查产品用量，输出保存到 `usage`。
3. `renewal_risk_analyzer` 把 `{profile}` 和 `{usage}` 注入 JSON 参数，生成风险简报。

它也可以被注册成一个普通工具：

```js
chainManager.registerChainAsTool("renewal_brief_builder", {
  inputParameterName: "customerId",
  inputParameterDescription: "需要生成续约简报的客户编号，例如 C-2048",
});
```

注册以后，`FunctionCallAgent` 会把 `renewal_brief_builder` 当成普通工具暴露给模型。模型只需要调用一次工具链，链内部会自动完成三个工具步骤。

并行工具执行也很直接：

```js
import { AsyncToolExecutor } from "helloagent-js";

const executor = new AsyncToolExecutor(registry, { concurrency: 2 });

const results = await executor.executeToolsParallel([
  {
    toolName: "customer_profile",
    input: "customerId=C-4096",
  },
  {
    toolName: "usage_summary",
    input: "customerId=C-4096",
  },
]);

for (const result of results) {
  console.log(result.toolName, result.status, result.durationMs);
}
```

`customer_profile` 和 `usage_summary` 互不依赖，所以它们可以并发执行。这样比一个一个顺序等待更适合真实网络请求场景。

## 2. 两种“工具链”不要混淆

在进入代码前，需要先把两个概念分清楚。

第一种是模型驱动的动态工具链。

`FunctionCallAgent` 已经支持这种能力。模型可以先调用 `quote_calculator`，拿到报价结果后，再决定调用 `discount_approval_checker`，最后调用 `payment_schedule_builder`。这个链路不是开发者提前写死的，而是模型根据对话动态决定的。

流程是：

```text
用户问题
  -> 模型返回 tool_calls
  -> Agent 执行工具
  -> Agent 追加 role: "tool" 消息
  -> 模型继续决定下一步
```

第二种是开发者定义的确定性工具链。

这就是本章新增的 `ToolChain`。它不需要模型参与每一步选择，开发者直接写清楚步骤顺序：

```text
输入
  -> 第1个工具
  -> 第2个工具
  -> 第3个工具
  -> 最终结果
```

这两种方式适合的场景不同：

| 类型 | 谁决定下一步 | 适合场景 |
| --- | --- | --- |
| `FunctionCallAgent` 动态链 | 模型 | 任务开放、步骤不固定、需要模型判断 |
| `ToolChain` 确定性链 | 开发者 | 业务流程固定、步骤稳定、需要可控执行 |

本章实现的是第二种，但它可以和第一种组合：把 `ToolChain` 注册成普通工具后，模型可以选择是否调用整条链。

## 3. 本章修改哪些文件

本章新增和修改这些文件：

```text
src/
  tools/
    chain.ts                  # 新增：顺序工具链和工具链管理器
    async-executor.ts         # 新增：Promise 并发工具执行器
  index.ts                    # 导出新增 API 和类型

examples/
  08-tool-chain-and-async-tools.mjs
                              # 新增：本地可跑的工具链和异步执行示例
  README.md                   # 增加第8个 example 的运行说明

teach-doc/
  08-tool-chain-and-async-tools.md
                              # 本章教程
```

注意，本章不需要修改 `Tool.run()` 的基础定义。第2章留下的 `ToolResult = string | Promise<string>` 已经能表达异步工具。

本章也不需要修改 `FunctionCallAgent` 的主循环。它执行工具时已经走：

```ts
const result = await executeRegisteredToolWithParameters(this.toolRegistry, toolName, parsedArguments);
```

只要工具返回 `Promise<string>`，这里就会正常等待。

## 4. 实现顺序工具链

先新建文件：

```text
src/tools/chain.ts
```

这个文件负责四件事：

1. 描述工具链每一步的类型。
2. 实现 `ToolChain`，按顺序执行工具。
3. 实现 `ToolChainManager`，集中注册和执行多条工具链。
4. 把一条工具链包装成普通 `Tool`，让 Agent 也能调用。

### 4.1 定义工具链上下文

工具链执行时需要保存中间结果。

例如：

```text
input = "C-2048"
profile = customer_profile 的输出
usage = usage_summary 的输出
renewal_brief = renewal_risk_analyzer 的输出
```

这些数据会放进一个普通对象里：

```ts
export type ToolChainContext = Record<string, unknown>;
```

工具链步骤用 `ToolChainStep` 表示：

```ts
export interface ToolChainStep {
  toolName: string;
  inputTemplate: string;
  outputKey?: string;
}
```

三个字段分别表示：

| 字段 | 作用 |
| --- | --- |
| `toolName` | 要调用哪个工具 |
| `inputTemplate` | 传给工具的输入模板 |
| `outputKey` | 把工具输出保存到上下文里的哪个键 |

例如：

```ts
{
  toolName: "customer_profile",
  inputTemplate: "customerId={input}",
  outputKey: "profile",
}
```

如果工具链的原始输入是 `C-2048`，那么 `{input}` 会被替换成 `C-2048`，最终传给工具的参数字符串就是：

```text
customerId=C-2048
```

`executeRegisteredTool()` 已经支持 `key=value` 参数解析，所以工具会收到：

```ts
{
  customerId: "C-2048",
}
```

### 4.2 记录每一步的执行结果

为了让调用方能观察工具链执行过程，我们定义 `ToolChainStepResult`：

```ts
export interface ToolChainStepResult {
  index: number;
  toolName: string;
  input: string;
  outputKey: string;
  result: string;
}
```

它记录：

1. 第几步。
2. 调用了哪个工具。
3. 模板渲染后的真实输入。
4. 输出保存到了哪个上下文键。
5. 工具返回了什么。

整条链执行完成后，返回 `ToolChainRunResult`：

```ts
export interface ToolChainRunResult {
  chainName: string;
  input: string;
  result: string;
  context: ToolChainContext;
  steps: ToolChainStepResult[];
}
```

这里的 `result` 是最后一个步骤的结果。`context` 保留所有中间结果，`steps` 保留执行轨迹。

### 4.3 实现 ToolChain.addStep()

`ToolChain` 的构造函数只保存名称、描述和步骤：

```ts
export class ToolChain {
  readonly name: string;
  readonly description: string;

  private readonly steps: Required<ToolChainStep>[];

  constructor(name: string, description: string, steps: ToolChainStep[] = []) {
    this.name = name;
    this.description = description;
    this.steps = [];

    for (const step of steps) {
      this.addStep(step.toolName, step.inputTemplate, step.outputKey);
    }
  }
}
```

我们把步骤保存成 `Required<ToolChainStep>[]`，因为真正执行时 `outputKey` 必须有值。如果用户没有传 `outputKey`，就自动生成：

```ts
addStep(toolName: string, inputTemplate: string, outputKey?: string): this {
  if (!toolName.trim()) {
    throw new Error("toolName 不能为空");
  }
  if (!inputTemplate.trim()) {
    throw new Error("inputTemplate 不能为空");
  }

  this.steps.push({
    toolName: toolName.trim(),
    inputTemplate,
    outputKey: outputKey?.trim() || `step_${this.steps.length + 1}_result`,
  });
  return this;
}
```

这里返回 `this`，是为了支持链式写法：

```ts
const chain = new ToolChain("renewal_brief_builder", "生成续约简报")
  .addStep("customer_profile", "customerId={input}", "profile")
  .addStep("usage_summary", "customerId={input}", "usage");
```

### 4.4 渲染输入模板

工具链的关键是模板替换。

例如第三步：

```ts
'{"profile": {profile}, "usage": {usage}}'
```

如果上下文里有：

```ts
{
  profile: '{"customerId":"C-2048","companyName":"北辰制造"}',
  usage: '{"activeSeats":71,"supportTickets":7}'
}
```

模板渲染后会变成：

```json
{"profile": {"customerId":"C-2048","companyName":"北辰制造"}, "usage": {"activeSeats":71,"supportTickets":7}}
```

这正好是 `executeRegisteredTool()` 支持的 JSON 参数格式。

模板渲染函数写成：

```ts
function renderTemplate(template: string, context: ToolChainContext): string {
  return template.replace(/\{([A-Za-z_][\w.-]*)\}/g, (match, key: string) => {
    if (!Object.hasOwn(context, key)) {
      throw new Error(`模板变量 '${key}' 不存在`);
    }

    return stringifyTemplateValue(context[key]);
  });
}
```

这里有一个重要设计：如果模板引用了不存在的变量，直接抛错。

例如：

```text
{profile}
```

但前面步骤没有保存 `profile`，这说明工具链定义写错了，应该尽早失败，而不是把 `{profile}` 原样传给下一个工具。

`stringifyTemplateValue()` 负责把上下文值转成字符串：

```ts
function stringifyTemplateValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  return JSON.stringify(value);
}
```

工具返回值本来就是字符串，所以大多数情况下会直接返回。保留对象处理，是为了以后开发者手动传入结构化 `context` 时也能正常渲染。

### 4.5 执行整条工具链

`ToolChain.execute()` 是本模块最核心的方法：

```ts
async execute(
  registry: ToolRegistry,
  input: string,
  context: ToolChainContext = {},
): Promise<ToolChainRunResult> {
  if (this.steps.length === 0) {
    throw new Error(`工具链 '${this.name}' 没有任何执行步骤`);
  }

  const workingContext: ToolChainContext = {
    ...context,
    input,
  };
  const stepResults: ToolChainStepResult[] = [];
  let finalResult = input;

  for (const [index, step] of this.steps.entries()) {
    const renderedInput = renderTemplate(step.inputTemplate, workingContext);
    const result = await executeRegisteredTool(registry, step.toolName, renderedInput);

    workingContext[step.outputKey] = result;
    workingContext[`step_${index + 1}_result`] = result;
    finalResult = result;
    stepResults.push({
      index: index + 1,
      toolName: step.toolName,
      input: renderedInput,
      outputKey: step.outputKey,
      result,
    });
  }

  return {
    chainName: this.name,
    input,
    result: finalResult,
    context: workingContext,
    steps: stepResults,
  };
}
```

执行过程可以拆成五步：

1. 初始化上下文，把原始输入保存成 `input`。
2. 遍历每一个步骤。
3. 用当前上下文渲染 `inputTemplate`。
4. 调用 `executeRegisteredTool()` 执行工具。
5. 把结果写回上下文，供后续步骤引用。

注意这里使用了 `await executeRegisteredTool(...)`。这意味着链里的每个工具都可以是同步工具，也可以是异步工具。只要它符合 `Tool.run()` 接口，工具链不需要关心内部细节。

## 5. 实现 ToolChainManager

如果项目里只有一条工具链，直接使用 `ToolChain.execute()` 就够了。但 SDK 需要支持多条链，例如：

```text
renewal_brief_builder
sales_quote_builder
incident_report_builder
```

所以我们加一个 `ToolChainManager`：

```ts
export class ToolChainManager {
  readonly registry: ToolRegistry;

  private readonly chains: Map<string, ToolChain>;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
    this.chains = new Map();
  }
}
```

它持有同一个 `ToolRegistry`，因为工具链执行时要从注册表里找到真实工具。

注册工具链：

```ts
registerChain(chain: ToolChain): void {
  this.chains.set(chain.name, chain);
}
```

执行工具链：

```ts
async executeChain(
  name: string,
  input: string,
  context: ToolChainContext = {},
): Promise<ToolChainRunResult> {
  const chain = this.chains.get(name);
  if (!chain) {
    throw new Error(`工具链 '${name}' 不存在`);
  }

  return chain.execute(this.registry, input, context);
}
```

列出工具链：

```ts
listChains(): string[] {
  return [...this.chains.keys()];
}
```

查看工具链信息：

```ts
getChainInfo(name: string): ToolChainInfo | undefined {
  return this.chains.get(name)?.getInfo();
}
```

这些方法不复杂，但它们让工具链从“一段临时代码”变成了 SDK 的正式能力。

## 6. 把工具链包装成普通工具

前面讲过，`ToolChain` 是开发者定义的确定性流程。但我们也希望模型能调用整条链。

例如用户说：

```text
请为客户 C-2048 生成续约风险简报。
```

模型不需要分别知道 `customer_profile`、`usage_summary`、`renewal_risk_analyzer` 三个工具。它只要调用：

```text
renewal_brief_builder
```

工具链内部会完成剩下步骤。

为了实现这个能力，我们给 `ToolChain` 增加：

```ts
toTool(registry: ToolRegistry, options: ToolChainToolOptions = {}): Tool {
  return new ToolChainTool(this, registry, options);
}
```

`ToolChainTool` 继承自 `Tool`：

```ts
class ToolChainTool extends Tool {
  private readonly chain: ToolChain;
  private readonly registry: ToolRegistry;
  private readonly inputParameterName: string;
  private readonly inputParameterDescription: string;
}
```

它的 `run()` 方法会读取参数，然后执行整条链：

```ts
async run(parameters: ToolParameters): Promise<string> {
  const rawInput = parameters[this.inputParameterName] ?? parameters.input ?? "";
  const result = await this.chain.execute(this.registry, String(rawInput));
  return JSON.stringify(
    {
      chainName: result.chainName,
      result: result.result,
      steps: result.steps,
    },
    null,
    2,
  );
}
```

返回 JSON 字符串，是为了让 Agent 和模型都能看到：

1. 调用的是哪条工具链。
2. 最终结果是什么。
3. 中间每一步发生了什么。

`getParameters()` 暴露一个输入参数：

```ts
getParameters(): ToolParameter[] {
  return [
    {
      name: this.inputParameterName,
      type: "string",
      description: this.inputParameterDescription,
      required: true,
    },
  ];
}
```

默认参数名是 `input`。但业务里最好改成更具体的名字，例如：

```ts
chainManager.registerChainAsTool("renewal_brief_builder", {
  inputParameterName: "customerId",
  inputParameterDescription: "需要生成续约简报的客户编号，例如 C-2048",
});
```

这样 `FunctionCallAgent` 生成 OpenAI-compatible tool schema 时，模型会看到更清晰的参数说明。

## 7. 实现异步工具执行器

现在新建：

```text
src/tools/async-executor.ts
```

这个文件负责并发执行工具任务。

为什么要单独做这个模块？

因为工具链强调“顺序依赖”。第2步可能要用第1步结果，第3步可能要用第2步结果，所以必须按顺序执行。

异步执行器强调“互不依赖”。例如同时查询三个客户画像，或者同时请求客户画像和用量摘要。这些任务之间没有先后关系，可以一起发出去等待结果。

### 7.1 定义任务类型

一个异步工具任务用 `AsyncToolTask` 表示：

```ts
export interface AsyncToolTask {
  toolName: string;
  input?: string;
  parameters?: ToolParameters;
}
```

这里同时支持两种输入：

1. `input`：字符串输入，走 `executeRegisteredTool()`。
2. `parameters`：对象参数，走 `executeRegisteredToolWithParameters()`。

为什么两种都支持？

因为前面几个 Agent 已经有两套工具调用入口：

| 调用方式 | 参数形式 | 使用场景 |
| --- | --- | --- |
| `executeRegisteredTool()` | 字符串 | `SimpleAgent`、`ReActAgent` 文本协议 |
| `executeRegisteredToolWithParameters()` | 对象 | `FunctionCallAgent` 原生 function calling |

异步执行器复用这两套入口，不重新发明参数解析规则。

### 7.2 定义结果类型

每个任务返回 `AsyncToolTaskResult`：

```ts
export interface AsyncToolTaskResult {
  taskId: number;
  toolName: string;
  input?: string;
  parameters?: ToolParameters;
  result: string;
  status: "success" | "error";
  error?: string;
  durationMs: number;
}
```

这里记录 `durationMs`，是为了让用户能观察异步工具到底花了多久。真实业务里也可以用它做日志和性能分析。

### 7.3 单个工具异步执行

`AsyncToolExecutor` 持有一个 `ToolRegistry`：

```ts
export class AsyncToolExecutor {
  readonly registry: ToolRegistry;
  readonly concurrency: number;

  constructor(registry: ToolRegistry, options: AsyncToolExecutorOptions = {}) {
    this.registry = registry;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  }
}
```

`concurrency` 是并发上限。默认最多同时执行4个任务。

单个字符串输入工具执行：

```ts
async executeToolAsync(toolName: string, input: string): Promise<string> {
  return executeRegisteredTool(this.registry, toolName, input);
}
```

单个对象参数工具执行：

```ts
async executeToolWithParametersAsync(toolName: string, parameters: ToolParameters): Promise<string> {
  return executeRegisteredToolWithParameters(this.registry, toolName, parameters);
}
```

这两个方法看起来很薄，但它们统一了调用风格：无论工具内部同步还是异步，对外都是 `Promise<string>`。

### 7.4 并发执行多个工具任务

核心方法是：

```ts
async executeToolsParallel(
  tasks: AsyncToolTask[],
  options: AsyncToolExecutorOptions = {},
): Promise<AsyncToolTaskResult[]> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? this.concurrency));
  const results: AsyncToolTaskResult[] = new Array(tasks.length);
  let nextIndex = 0;

  const workerCount = Math.min(concurrency, tasks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < tasks.length) {
      const taskId = nextIndex;
      nextIndex += 1;
      results[taskId] = await this.executeTask(taskId, tasks[taskId]);
    }
  });

  await Promise.all(workers);
  return results;
}
```

这段代码实现了一个很小的 Promise worker pool。

假设有5个任务，并发上限是2：

```text
worker 1 -> 任务0 -> 任务2 -> 任务4
worker 2 -> 任务1 -> 任务3
```

它不会一次性把所有任务都发出去，而是最多同时跑2个。这样可以避免真实业务里同时打爆数据库或外部 API。

结果数组用 `taskId` 放回原位置，所以返回顺序和输入顺序一致。

### 7.5 批量执行同一个工具

很多场景是“同一个工具跑多组输入”。

例如同时查询3个客户画像：

```ts
const results = await executor.executeBatchTool(
  "customer_profile",
  ["customerId=C-2048", "customerId=C-1031", "customerId=C-4096"],
  { concurrency: 3 },
);
```

它内部只是把输入列表转换成任务列表：

```ts
async executeBatchTool(
  toolName: string,
  inputs: string[],
  options: AsyncToolExecutorOptions = {},
): Promise<AsyncToolTaskResult[]> {
  return this.executeToolsParallel(
    inputs.map((input) => ({
      toolName,
      input,
    })),
    options,
  );
}
```

这样 API 更贴近常见批量执行需求。

### 7.6 便捷函数

为了不用每次都手动 new executor，我们还导出两个 helper：

```ts
export async function runParallelTools(
  registry: ToolRegistry,
  tasks: AsyncToolTask[],
  options: AsyncToolExecutorOptions = {},
): Promise<AsyncToolTaskResult[]> {
  return new AsyncToolExecutor(registry, options).executeToolsParallel(tasks, options);
}
```

以及：

```ts
export async function runBatchTool(
  registry: ToolRegistry,
  toolName: string,
  inputs: string[],
  options: AsyncToolExecutorOptions = {},
): Promise<AsyncToolTaskResult[]> {
  return new AsyncToolExecutor(registry, options).executeBatchTool(toolName, inputs, options);
}
```

这两个函数适合脚本和 example。复杂应用里更推荐长期持有一个 `AsyncToolExecutor` 实例，因为可以统一配置并发上限。

## 8. 更新包入口导出

新增模块后，需要在：

```text
src/index.ts
```

导出运行时 API：

```ts
export { ToolChain, ToolChainManager } from "./tools/chain.js";
export {
  AsyncToolExecutor,
  runBatchTool,
  runParallelTools,
} from "./tools/async-executor.js";
```

再导出类型：

```ts
export type {
  ToolChainContext,
  ToolChainInfo,
  ToolChainRunResult,
  ToolChainStep,
  ToolChainStepResult,
  ToolChainToolOptions,
} from "./tools/chain.js";
```

以及：

```ts
export type {
  AsyncToolExecutorOptions,
  AsyncToolTask,
  AsyncToolTaskResult,
  AsyncToolTaskStatus,
} from "./tools/async-executor.js";
```

这样用户才能从包入口直接写：

```ts
import { ToolChain, AsyncToolExecutor } from "helloagent-js";
```

而不是去导入内部路径。

## 9. 编写第8个 example

本章新增：

```text
examples/08-tool-chain-and-async-tools.mjs
```

这个示例默认不依赖真实 LLM，原因是工具链和异步执行器本身属于工具层能力。我们应该先用稳定的本地工具证明它们能跑，再可选接入 `FunctionCallAgent`。

示例里定义三个工具。

第一个是 `CustomerProfileTool`：

```js
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
    // 返回客户画像 JSON
  }
}
```

它用 `await delay(120)` 模拟数据库查询或 HTTP 请求。

第二个是 `UsageSummaryTool`：

```js
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
    // 返回用量 JSON
  }
}
```

第三个是 `RenewalRiskAnalyzerTool`：

```js
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
    // 返回风险分析 JSON
  }
}
```

然后注册工具：

```js
const registry = new ToolRegistry();
registry.registerTool(new CustomerProfileTool());
registry.registerTool(new UsageSummaryTool());
registry.registerTool(new RenewalRiskAnalyzerTool());
```

定义工具链：

```js
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
```

执行工具链：

```js
const chainManager = new ToolChainManager(registry);
chainManager.registerChain(chain);

const chainResult = await chainManager.executeChain("renewal_brief_builder", "C-2048");
console.log(chainResult.result);
```

注册成 Agent 可调用工具：

```js
chainManager.registerChainAsTool("renewal_brief_builder", {
  inputParameterName: "customerId",
  inputParameterDescription: "需要生成续约简报的客户编号，例如 C-2048",
});
```

并行执行两个互不依赖的任务：

```js
const executor = new AsyncToolExecutor(registry, { concurrency: 2 });
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
```

批量执行同一个工具：

```js
const batchResults = await executor.executeBatchTool(
  "customer_profile",
  ["customerId=C-2048", "customerId=C-1031", "customerId=C-4096"],
  { concurrency: 3 },
);
```

最后，示例保留了可选的真实 LLM 验证路径。

只有在 `examples/.env` 里设置：

```text
RUN_LLM_TOOL_CHAIN_DEMO=1
```

才会运行 `FunctionCallAgent`：

```js
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
```

这样设计是为了让 example 有两层验证：

1. 默认离线验证工具层，不需要任何密钥。
2. 显式打开后验证真实模型是否能调用工具链。

## 10. 工具链如何接入 FunctionCallAgent

`FunctionCallAgent` 并不知道什么是 `ToolChain`。它只认识 `ToolRegistry` 里的工具。

所以关键动作是：

```js
chainManager.registerChainAsTool("renewal_brief_builder", {
  inputParameterName: "customerId",
  inputParameterDescription: "需要生成续约简报的客户编号，例如 C-2048",
});
```

这行代码内部会做三件事：

1. 从 `ToolChainManager` 找到名为 `renewal_brief_builder` 的链。
2. 调用 `chain.toTool(...)` 把链包装成 `Tool`。
3. 调用 `registry.registerTool(...)` 注册到工具表。

之后 `FunctionCallAgent` 调用：

```ts
this.toolRegistry.getOpenAIToolSchemas()
```

就会看到这条工具链对应的 schema：

```json
{
  "type": "function",
  "function": {
    "name": "renewal_brief_builder",
    "description": "按客户编号依次查询客户画像、产品用量，并生成续约风险简报。",
    "parameters": {
      "type": "object",
      "properties": {
        "customerId": {
          "type": "string",
          "description": "需要生成续约简报的客户编号，例如 C-2048"
        }
      },
      "required": ["customerId"]
    }
  }
}
```

模型调用这个工具时，`FunctionCallAgent` 仍然走原来的执行路径：

```ts
const result = await executeRegisteredToolWithParameters(
  this.toolRegistry,
  toolName,
  parsedArguments,
);
```

因为工具链已经被包装成普通 `Tool`，所以不需要给 `FunctionCallAgent` 增加任何特殊分支。

这也是本章设计里最重要的边界：高级能力放在工具层，Agent 只依赖稳定的 `Tool` 接口。

## 11. 运行验证

先构建 SDK：

```bash
pnpm build
```

然后运行第8个示例：

```bash
node examples/08-tool-chain-and-async-tools.mjs
```

你会看到三段输出。

第一段是工具链顺序执行：

```text
========== ToolChain 顺序工具链 ==========

步骤 1: customer_profile
输入: customerId=C-2048
输出预览: { "customerId": "C-2048", "companyName": "北辰制造", ... }

步骤 2: usage_summary
输入: customerId=C-2048
输出预览: { "customerId": "C-2048", "activeSeats": 71, ... }

步骤 3: renewal_risk_analyzer
输入: {"profile": {...}, "usage": {...}}
输出预览: { "customerId": "C-2048", "companyName": "北辰制造", ... }
```

第二段是并行工具执行：

```text
========== AsyncToolExecutor 并行工具执行 ==========

两个互不依赖的工具任务总耗时：161ms
任务 0: customer_profile -> success (121ms)
任务 1: usage_summary -> success (160ms)
```

这里总耗时接近较慢的那个工具，而不是两个工具耗时相加。这说明它们确实并行等待。

第三段是批量查询：

```text
批量查询客户画像：
- C-2048 北辰制造：Enterprise，健康分 74
- C-1031 云杉零售：Business，健康分 91
- C-4096 远航物流：Enterprise，健康分 62
```

如果你想验证真实模型调用工具链，先在 `examples/.env` 配置 LLM 服务，然后加：

```text
RUN_LLM_TOOL_CHAIN_DEMO=1
```

再运行：

```bash
node examples/08-tool-chain-and-async-tools.mjs
```

这时示例会多跑一段 `FunctionCallAgent`，让模型调用 `renewal_brief_builder` 工具链。

## 12. 本章小结

本章没有改变基础工具接口，而是在工具层补了两个组织能力：

1. `ToolChain` 负责顺序执行，适合固定业务流程。
2. `ToolChainManager` 负责管理多条链，并能把链注册成普通工具。
3. `AsyncToolExecutor` 负责并发执行，适合互不依赖的异步工具任务。
4. `FunctionCallAgent` 不需要特殊适配，因为工具链最终仍然是一个 `Tool`。

到这里，工具系统已经有了三层能力：

```text
基础层：Tool + ToolRegistry
Agent层：SimpleAgent / ReActAgent / FunctionCallAgent 调用工具
编排层：ToolChain / AsyncToolExecutor 组织多个工具
```

后续如果继续扩展，可以在这个基础上增加重试、超时、条件分支、DAG 工作流或工具调用日志。但当前版本先保持简单：顺序链和并行批量执行已经能覆盖很多真实 SDK 使用场景。
