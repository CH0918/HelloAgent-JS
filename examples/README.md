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

## 工具链与异步工具执行

`examples/08-tool-chain-and-async-tools.mjs` 演示两个高级工具能力：

- `ToolChain`：把多个工具按固定顺序串起来，让后续步骤引用前面步骤的输出。
- `AsyncToolExecutor`：用 Promise 并发执行多个异步工具任务，适合批量查询和互不依赖的外部请求。

示例默认不依赖真实模型，直接使用本地模拟的 CRM、用量、风险评估工具验证工具链和并行执行。如果 `examples/.env` 配好了 LLM 服务，再把注册后的工具链交给 `FunctionCallAgent` 作为一个普通工具调用。

```bash
pnpm build
node examples/08-tool-chain-and-async-tools.mjs
```

## 完整记忆系统

`examples/09-memory-system.mjs` 演示 SDK 内置记忆系统。默认路径只验证 `WorkingMemory` 和 `MemoryTool`，不需要外部数据库；如果设置 `RUN_FULL_MEMORY_DEMO=1`，会继续验证 Python 对齐的 `EpisodicMemory`、`SemanticMemory` 和 `PerceptualMemory`。

`examples/09-1-embedding-demo.mjs` 演示最小业务语义匹配：用户输入一个客服问题，示例读取 `examples/.env` 里的 `EMBED_*`，用 embedding 从 3 条 FAQ 中找出最匹配的答案。

```bash
pnpm build
node examples/09-1-embedding-demo.mjs
```

`examples/09-02-qdrant-business-demo.mjs` 演示 Embedding + Qdrant 的真实业务检索链路：把客服知识库条目转成向量写入 Qdrant，再用一条用户工单召回最相关的处理方案。运行前需要在 `examples/.env` 中配置好 `EMBED_*` 和 `QDRANT_*`。

```bash
pnpm build
node examples/09-02-qdrant-business-demo.mjs
```

`examples/09-03-neo4j-business-demo.mjs` 演示一个更简单的 Neo4j 关系图场景：写入客户、系统、团队和问题 4 个实体，再从客户出发查询直接关系和两跳内相关实体。运行前需要在 `examples/.env` 中配置好 `NEO4J_*`。

```bash
pnpm build
node examples/09-03-neo4j-business-demo.mjs
```

完整后端路径需要安装可选依赖并准备 Qdrant / Neo4j：

```bash
pnpm add -w better-sqlite3 neo4j-driver @xenova/transformers
docker run -p 6333:6333 qdrant/qdrant
docker run -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/hello-agents-password neo4j:5
```

运行：

```bash
pnpm build
node examples/09-memory-system.mjs
```
