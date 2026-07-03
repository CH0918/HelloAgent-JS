# HelloAgent-JS Example

`examples/01-real-world-usage.mjs` 演示 SDK 被真实业务代码引入后的典型流程：

- 读取 `examples/.env`
- 初始化 `Config`
- 初始化 `HelloAgentsLLM`
- 使用 `Message` 构造 system/user/assistant 对话历史
- 调用 `invoke()` 获取完整回复
- 调用 `streamInvoke()` 逐段输出回复
- 裁剪对话历史
- 捕获 SDK 异常

## 准备环境

先安装根项目依赖并构建 SDK：

```bash
pnpm install
pnpm build
```

再安装 examples 自己的依赖：

```bash
cd examples
pnpm install
cd ..
```

复制环境变量模板：

```bash
cp examples/.env.example examples/.env
```

然后编辑 `examples/.env`。如果使用本地 OpenAI 兼容服务，可以填：

```bash
LLM_API_KEY=local
LLM_BASE_URL=http://localhost:8000/v1
LLM_MODEL_ID=local-model
```

## 运行

```bash
node examples/01-real-world-usage.mjs
```

当前用例里显式使用 `provider: "local"`，默认会连接 `http://localhost:8000/v1`。如果你的本地服务地址不同，请修改 `examples/.env` 或示例中的 provider 配置。

## SimpleAgent 工具调用

`examples/02-simple-agent-with-tools.mjs` 演示一个更接近真实业务的报价助手。它会读取 `examples/.env`，使用 `HelloAgentsLLM` 初始化真实模型，然后通过 `SimpleAgent` 调用自定义的 `quote_calculator` 工具计算报价，并在第二轮基于历史上下文演示 `streamRun()` 流式输出。

```bash
pnpm build
node examples/02-simple-agent-with-tools.mjs
```

## ReActAgent 推理与行动循环

`examples/03-react-agent.mjs` 演示 ReActAgent 的 `Thought -> Action -> Observation -> Finish` 工作流。它同样读取 `examples/.env`，使用真实模型，并注册 `quote_calculator` 工具，让模型先选择工具行动，再基于观察结果给出最终答案。

```bash
pnpm build
node examples/03-react-agent.mjs
```

## ReflectionAgent 自我反思与迭代优化

`examples/04-reflection-agent.mjs` 演示 ReflectionAgent 的 `初始回答 -> 反思 -> 优化 -> 最终回答` 工作流。它读取 `examples/.env`，使用真实模型，分别运行默认提示词和自定义代码评审提示词两个场景，并通过 `onStep` 回调输出每一轮反思进度。

```bash
pnpm build
node examples/04-reflection-agent.mjs
```

## PlanAndSolveAgent 规划与逐步执行

`examples/05-plan-and-solve-agent.mjs` 演示 PlanAndSolveAgent 的 `生成计划 -> 逐步执行 -> 最终答案` 工作流。它读取 `examples/.env`，使用真实模型，为一个 B2B SaaS 团队生成两周 AI 客户跟进助手试点方案，并通过 `onStep` 回调展示计划和每一步执行摘要。

```bash
pnpm build
node examples/05-plan-and-solve-agent.mjs
```

## FunctionCallAgent 原生函数调用

`examples/06-function-call-agent.mjs` 演示 FunctionCallAgent 的 OpenAI-compatible `tools -> tool_calls -> tool result -> final answer` 工作流。它读取 `examples/.env`，使用支持 `tools` 参数的真实模型服务，并注册报价计算、折扣审批、付款计划三个本地工具。

```bash
pnpm build
node examples/06-function-call-agent.mjs
```

## 内置 SearchTool 搜索工具

`examples/07-built-in-search-tool.mjs` 演示 SDK 内置 `SearchTool`。搜索工具仍然通过 `ToolRegistry` 注册，再由 `FunctionCallAgent` 以原生 function calling 方式调用。示例使用 Tavily 作为搜索 provider，需要在 `examples/.env` 中配置 `TAVILY_API_KEY`。

```bash
pnpm build
node examples/07-built-in-search-tool.mjs
```

`SearchTool` 同时支持 `tavily`、`serpapi`、`duckduckgo`、`searxng`、`perplexity`、`hybrid` 和 `advanced` 后端。示例固定使用 Tavily，是为了让验证路径更清楚。
