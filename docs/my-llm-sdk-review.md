# MyLLM SDK 封装 Review

## 1. auto 检测不读取构造参数

- 解决状态：已解决
- 位置：[src/my-llm.ts:196](../src/my-llm.ts#L196)
- 问题：`provider: "auto"` 只根据 `process.env` 自动检测，不读取构造参数中的 `baseUrl` 或 `apiKey`。
- 影响：例如 `new MyLLM({ baseUrl: "http://localhost:11434/v1" })` 不会被识别为 `ollama`，而是走父类通用逻辑，并要求显式提供 `apiKey`。
- 建议：自动检测时把构造参数纳入判断，且保持构造参数优先级高于环境变量。
- 处理结果：`autoDetectProvider` 已支持读取构造参数中的 `baseUrl` 和 `apiKey`，并优先于环境变量进行 provider 推断。

## 2. 自定义 provider 的 baseUrl 优先级不合理

- 解决状态：已解决
- 位置：[src/my-llm.ts:164](../src/my-llm.ts#L164)
- 问题：自定义 provider 的 `baseUrl` 解析顺序是“显式传入 > provider 默认值 > `LLM_BASE_URL`”。由于 provider 默认值始终存在，`LLM_BASE_URL` 对自定义 provider 实际不会生效。
- 影响：即使通过 `LLM_BASE_URL` 自动检测出了 provider，后续创建客户端时也会换回内置默认地址。
- 建议：调整为“显式传入 > provider 专属环境变量或通用环境变量 > provider 默认值”。
- 处理结果：自定义 provider 的 `baseUrl` 优先级已调整为“显式传入 > `LLM_BASE_URL` > provider 默认值”。

## 3. 自定义 provider 不读取 LLM_TIMEOUT

- 解决状态：已解决
- 位置：[src/my-llm.ts:224](../src/my-llm.ts#L224)
- 问题：自定义 provider 分支使用 `timeout ?? 60`，没有读取 `LLM_TIMEOUT`。
- 影响：父类支持 `LLM_TIMEOUT`，但 `MyLLM` 自动识别为自定义 provider 后会忽略这个环境变量，同一个 SDK 的配置语义不一致。
- 建议：复用父类的 timeout 解析语义，或者提取统一的 timeout 解析逻辑。
- 处理结果：自定义 provider 分支已改为 `timeout ?? Number(process.env.LLM_TIMEOUT || 60)`，与父类 timeout 解析语义保持一致。

## 4. maxTokens 在非自定义 provider 下被静默忽略

- 解决状态：已解决
- 位置：[src/my-llm.ts:249](../src/my-llm.ts#L249)
- 问题：构造器接收 `maxTokens` 和 `max_tokens`，但非自定义 provider 分支直接调用 `super.think(...)`，父类不会把 `max_tokens` 传给 OpenAI SDK。
- 影响：用户传入了参数但请求中不会生效，且没有任何提示。
- 建议：统一在 `MyLLM` 中处理请求参数，或者让父类支持 `max_tokens`。
- 处理结果：`HelloAgentsLLM` 已支持 `maxTokens/max_tokens` 并在请求中传递 `max_tokens`，`MyLLM` 的非自定义 provider 分支会把对应参数传给父类。

## 5. provider 类型过宽，拼写错误不会暴露

- 解决状态：已解决
- 位置：[src/my-llm.ts:10](../src/my-llm.ts#L10)
- 问题：`provider?: string` 允许任意字符串。拼错 provider 时会走非自定义 provider 路径，而不是报错。
- 影响：例如 `"ollmaa"` 会被当作普通 OpenAI 兼容 provider 处理，排查成本较高。
- 建议：把 provider 类型收窄为明确的联合类型，并在运行时对未知 provider 给出清晰错误。
- 处理结果：`provider` 已收窄为 `MyLLMProvider` 联合类型，并在构造器中对未知 provider 抛出明确错误。

## 代码可读性 Review

### 1. `MyLLM` 职责偏重

- 解决状态：已解决
- 位置：[src/my-llm.ts](../src/my-llm.ts)
- 问题：`MyLLM` 同时负责 provider 识别、环境变量解析、默认值策略、客户端创建和流式调用。
- 影响：构造函数承载了太多业务分支，后续新增 provider 或配置项时容易继续膨胀。
- 建议：把配置解析抽成纯函数，例如 `resolveRuntimeConfig(options)`，让类本身只负责初始化运行时状态和调用模型。
- 处理结果：已新增 `resolveRuntimeConfig` 统一解析 provider、凭据、模型、timeout、temperature 和 max tokens；`MyLLM` 构造函数只消费解析后的运行时配置并初始化调用状态。

### 2. provider 配置和检测规则分散

- 解决状态：已解决
- 位置：[src/my-llm.ts](../src/my-llm.ts)
- 问题：`customProviderConfigs` 是 provider 配置中心，但 base URL、端口、API key 前缀等检测规则写在独立分支里。
- 影响：阅读时需要在配置表和检测函数之间来回跳转，新增 provider 时也容易漏改检测逻辑。
- 建议：把 `baseUrlPatterns`、`localPorts`、`apiKeyPrefixes` 等识别规则收敛到 provider 配置中，检测函数只遍历配置。
- 处理结果：已把自定义 provider 的域名、端口和 API key 前缀识别规则放入 `customProviderConfigs`，并新增内置 provider 的轻量检测配置；检测函数改为遍历配置元数据。

### 3. 构造函数分支过深

- 解决状态：待处理
- 位置：[src/my-llm.ts](../src/my-llm.ts)
- 问题：构造函数先做 provider 校验和自动检测，再分别处理内置 provider 与自定义 provider，主路径不够直观。
- 影响：读者需要记住多个中间变量和分支条件，才能确认最终传给父类和 OpenAI SDK 的配置。
- 建议：先统一解析出 `provider`、`model`、`apiKey`、`baseUrl`、`timeout`、`temperature`、`maxTokens` 等运行时配置，再根据配置类型初始化。

### 4. 运行时状态没有用类型表达

- 解决状态：待处理
- 位置：[src/my-llm.ts](../src/my-llm.ts)
- 问题：`providerClient?` 和 `providerModel?` 是否存在依赖 `provider` 是否为自定义 provider，但类型定义没有表达这种关系。
- 影响：`think` 中需要使用非空断言，读者要依赖上下文推理字段一定存在。
- 建议：使用可区分联合类型保存运行时状态，例如 `{ kind: "custom"; client; model } | { kind: "builtin" }`。

### 5. 检测函数存在副作用和语义歧义

- 解决状态：待处理
- 位置：[src/my-llm.ts](../src/my-llm.ts)
- 问题：`detectProviderFromApiKey` 名字像纯检测函数，但函数内部会打印日志，并且 `sk-` 分支只打印、不返回 provider。
- 影响：函数名、返回值和副作用之间不够一致，容易让读者误判检测结果。
- 建议：让检测函数只返回检测结果，把日志放到调用方；或者明确返回 `"auto"` 来表达 OpenAI 兼容格式。

### 6. 注释偏多且有少量失真

- 解决状态：待处理
- 位置：[src/my-llm.ts](../src/my-llm.ts)
- 问题：部分注释复述代码本身，自动检测步骤中还出现了重复编号。
- 影响：注释增加了阅读负担，且一旦实现变化，注释容易变成过期信息。
- 建议：保留解释设计意图和优先级的注释，删除逐行复述型注释，并修正自动检测步骤编号。
