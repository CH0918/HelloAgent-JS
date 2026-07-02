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
