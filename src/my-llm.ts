import OpenAI from "openai";

import {
  HelloAgentsLLM,
  type ChatMessage,
  type HelloAgentsLLMOptions,
} from "./hello-agents-llm.js";

interface ProviderDetectionConfig {
  baseUrlPatterns?: readonly string[];
  localPorts?: readonly string[];
  apiKeyPrefixes?: readonly string[];
}

interface CustomProviderConfig extends ProviderDetectionConfig {
  displayName: string;
  apiKeyEnvName: string;
  getApiKey: () => string | undefined;
  baseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
}

type BuiltInProvider = "auto" | "openai" | "vllm" | "local";

/**
 * 自定义 Provider 配置。
 * 每个 provider 定义了展示名称、环境变量名、获取 API key 的方法、
 * 默认 base URL、默认模型、以及是否需要 API key。
 */
const customProviderConfigs = {
  modelscope: {
    displayName: "ModelScope",
    apiKeyEnvName: "MODELSCOPE_API_KEY",
    getApiKey: () => process.env.MODELSCOPE_API_KEY,
    baseUrl: "https://api-inference.modelscope.cn/v1/",
    baseUrlPatterns: ["api-inference.modelscope.cn"],
    apiKeyPrefixes: ["ms-"],
    defaultModel: "Qwen/Qwen2.5-VL-72B-Instruct",
    requiresApiKey: true,
  },
  evolink: {
    displayName: "Evolink",
    apiKeyEnvName: "EVOLINK_API_KEY",
    getApiKey: () => process.env.EVOLINK_API_KEY,
    baseUrl: "https://direct.evolink.ai/v1",
    baseUrlPatterns: ["direct.evolink.ai"],
    defaultModel: "gemini-2.5-flash-lite",
    requiresApiKey: true,
  },
  ollama: {
    displayName: "Ollama",
    apiKeyEnvName: "OLLAMA_API_KEY",
    getApiKey: () => process.env.OLLAMA_API_KEY || "ollama",
    baseUrl: "http://localhost:11434/v1",
    localPorts: ["11434"],
    defaultModel: "qwen3:8b",
    requiresApiKey: false,
  },
  omlx: {
    displayName: "OMLX",
    apiKeyEnvName: "OMLX_API_KEY",
    getApiKey: () => process.env.OMLX_API_KEY || "omlx",
    baseUrl: "http://127.0.0.1:8888/v1",
    localPorts: ["8888"],
    defaultModel: "Qwen3.5-4B-MLX-4bit",
    requiresApiKey: false,
  },
} as const satisfies Record<string, CustomProviderConfig>;

const builtInProviderDetectionConfigs = {
  openai: {
    baseUrlPatterns: ["api.openai.com"],
  },
  vllm: {
    localPorts: ["8000"],
  },
} as const satisfies Partial<Record<BuiltInProvider, ProviderDetectionConfig>>;

type CustomProvider = keyof typeof customProviderConfigs;
type MyLLMProvider = CustomProvider | BuiltInProvider;

interface MyLLMOptions extends HelloAgentsLLMOptions {
  provider?: MyLLMProvider;
  temperature?: number;
  maxTokens?: number;
  max_tokens?: number;
}

function isCustomProvider(provider: string): provider is CustomProvider {
  return provider in customProviderConfigs;
}

function isKnownProvider(provider: string): provider is MyLLMProvider {
  return (
    provider === "auto" ||
    provider === "openai" ||
    provider === "vllm" ||
    provider === "local" ||
    isCustomProvider(provider)
  );
}

// ---- 7.2.3 自动检测机制 ----

interface AutoDetectProviderOptions {
  apiKey?: string;
  baseUrl?: string;
}

function customProviderEntries(): [CustomProvider, CustomProviderConfig][] {
  return Object.entries(customProviderConfigs) as [CustomProvider, CustomProviderConfig][];
}

function builtInProviderDetectionEntries(): [
  BuiltInProvider,
  ProviderDetectionConfig,
][] {
  return Object.entries(builtInProviderDetectionConfigs) as [
    BuiltInProvider,
    ProviderDetectionConfig,
  ][];
}

function includesAny(value: string, patterns?: readonly string[]): boolean {
  return patterns?.some((pattern) => value.includes(pattern)) ?? false;
}

function usesLocalHost(baseUrl: string): boolean {
  return baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
}

function usesAnyPort(baseUrl: string, ports?: readonly string[]): boolean {
  return ports?.some((port) => baseUrl.includes(`:${port}`)) ?? false;
}

function detectProviderFromBaseUrl(
  baseUrl: string,
  sourceName: string,
): MyLLMProvider | undefined {
  const baseUrlLower = baseUrl.toLowerCase();

  for (const [provider, config] of customProviderEntries()) {
    if (includesAny(baseUrlLower, config.baseUrlPatterns)) {
      console.log(`🔍 自动检测: 根据 ${sourceName} 域名推断 provider 为 "${provider}"`);
      return provider;
    }
  }

  for (const [provider, config] of builtInProviderDetectionEntries()) {
    if (includesAny(baseUrlLower, config.baseUrlPatterns)) {
      console.log(`🔍 自动检测: 根据 ${sourceName} 域名推断 provider 为 "${provider}"`);
      return provider;
    }
  }

  if (usesLocalHost(baseUrlLower)) {
    for (const [provider, config] of customProviderEntries()) {
      if (usesAnyPort(baseUrlLower, config.localPorts)) {
        console.log(`🔍 自动检测: 根据 ${sourceName} 端口推断 provider 为 "${provider}"`);
        return provider;
      }
    }

    for (const [provider, config] of builtInProviderDetectionEntries()) {
      if (usesAnyPort(baseUrlLower, config.localPorts)) {
        console.log(`🔍 自动检测: 根据 ${sourceName} 端口推断 provider 为 "${provider}"`);
        return provider;
      }
    }

    console.log(`🔍 自动检测: 检测到本地 ${sourceName}，推断 provider 为 "local"`);
    return "local";
  }

  return undefined;
}

function detectProviderFromApiKey(
  apiKey: string,
  sourceName: string,
): MyLLMProvider | undefined {
  for (const [provider, config] of customProviderEntries()) {
    const matchedPrefix = config.apiKeyPrefixes?.some((prefix) =>
      apiKey.startsWith(prefix),
    );

    if (matchedPrefix) {
      console.log(`🔍 自动检测: 根据 ${sourceName} 前缀推断 provider 为 "${provider}"`);
      return provider;
    }
  }

  if (apiKey.startsWith("sk-")) {
    console.log(
      `🔍 自动检测: 根据 ${sourceName} 前缀推断为 OpenAI 兼容格式，保持 provider 为 "auto"`,
    );
  }

  return undefined;
}

/**
 * 自动检测 LLM 提供商。
 *
 * 遵循四级优先级：
 * 1. 最高优先级 — 根据显式传入的 baseUrl/apiKey 判断
 * 2. 第二优先级 — 检查特定提供商的环境变量（如 MODELSCOPE_API_KEY）
 * 3. 第三优先级 — 根据 LLM_BASE_URL 的域名/端口模式匹配
 * 4. 辅助判断 — 根据 LLM_API_KEY 格式分析（前缀匹配）
 *
 * @returns 检测到的 provider 名称，无法确定时返回 "auto"
 */
function autoDetectProvider({
  apiKey,
  baseUrl,
}: AutoDetectProviderOptions = {}): MyLLMProvider {
  // 1. 显式构造参数（最高优先级）
  if (baseUrl) {
    const detectedProvider = detectProviderFromBaseUrl(baseUrl, "构造参数 baseUrl");
    if (detectedProvider) {
      return detectedProvider;
    }
  }
  if (apiKey) {
    const detectedProvider = detectProviderFromApiKey(apiKey, "构造参数 apiKey");
    if (detectedProvider) {
      return detectedProvider;
    }
  }

  // 2. 检查特定提供商的环境变量
  //    直接检查 process.env 中的值，排除兜底值（如 ollama 的 "ollama"、omlx 的 "omlx"）
  for (const providerName of Object.keys(customProviderConfigs) as CustomProvider[]) {
    const config = customProviderConfigs[providerName];
    const envValue = process.env[config.apiKeyEnvName];
    if (envValue) {
      console.log(
        `🔍 自动检测: 发现 ${config.apiKeyEnvName} 环境变量，推断 provider 为 "${providerName}"`,
      );
      return providerName;
    }
  }

  // 3. 根据 LLM_BASE_URL 判断
  const envBaseUrl = process.env.LLM_BASE_URL;
  if (envBaseUrl) {
    const detectedProvider = detectProviderFromBaseUrl(envBaseUrl, "LLM_BASE_URL");
    if (detectedProvider) {
      return detectedProvider;
    }
  }

  // 4. 根据 LLM_API_KEY 格式辅助判断（最低优先级）
  const envApiKey = process.env.LLM_API_KEY;
  if (envApiKey) {
    const detectedProvider = detectProviderFromApiKey(envApiKey, "LLM_API_KEY");
    if (detectedProvider) {
      return detectedProvider;
    }
  }

  // 4. 默认返回 'auto'，使用通用配置
  console.log("🔍 自动检测: 未匹配到特定 provider，使用通用配置");
  return "auto";
}

/**
 * 根据检测到的 provider 解析 API 密钥和 base URL。
 *
 * @param provider - 检测到的 provider 名称
 * @param explicitApiKey - 用户显式传入的 API key
 * @param explicitBaseUrl - 用户显式传入的 base URL
 * @returns 解析后的 { apiKey, baseUrl }
 */
function resolveCredentials(
  provider: string,
  explicitApiKey?: string,
  explicitBaseUrl?: string,
): { apiKey?: string; baseUrl?: string } {
  if (isCustomProvider(provider)) {
    const config = customProviderConfigs[provider];

    // 优先级：显式传入 > 提供商专用环境变量 > 通用 LLM_API_KEY
    const resolvedApiKey =
      explicitApiKey || config.getApiKey() || process.env.LLM_API_KEY;

    // 优先级：显式传入 > 通用 LLM_BASE_URL > 提供商默认 base URL
    const resolvedBaseUrl =
      explicitBaseUrl || process.env.LLM_BASE_URL || config.baseUrl;

    return { apiKey: resolvedApiKey, baseUrl: resolvedBaseUrl };
  }

  // 非自定义 provider（'auto', 'openai', 'vllm', 'local' 等），使用通用环境变量
  return {
    apiKey: explicitApiKey || process.env.LLM_API_KEY,
    baseUrl: explicitBaseUrl || process.env.LLM_BASE_URL,
  };
}

interface BaseRuntimeConfig {
  provider: MyLLMProvider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  temperature: number;
  maxTokens?: number;
  max_tokens?: number;
  completionMaxTokens?: number;
}

interface BuiltInRuntimeConfig extends BaseRuntimeConfig {
  kind: "builtin";
}

interface CustomRuntimeConfig extends BaseRuntimeConfig {
  kind: "custom";
  provider: CustomProvider;
  model: string;
  apiKey: string | undefined;
  baseUrl: string;
  timeout: number;
  displayName: string;
}

type RuntimeConfig = BuiltInRuntimeConfig | CustomRuntimeConfig;

function resolveRuntimeConfig({
  model,
  apiKey,
  baseUrl,
  provider = "auto",
  temperature,
  maxTokens,
  max_tokens,
  timeout,
}: MyLLMOptions = {}): RuntimeConfig {
  if (!isKnownProvider(provider)) {
    throw new Error(
      `Unknown LLM provider "${provider}". Supported providers: auto, openai, vllm, local, ${Object.keys(customProviderConfigs).join(", ")}.`,
    );
  }

  const resolvedProvider =
    provider === "auto" ? autoDetectProvider({ apiKey, baseUrl }) : provider;
  const completionMaxTokens = maxTokens ?? max_tokens;

  if (!isCustomProvider(resolvedProvider)) {
    const creds = resolveCredentials(resolvedProvider, apiKey, baseUrl);

    return {
      kind: "builtin",
      provider: resolvedProvider,
      model,
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
      timeout,
      temperature: temperature ?? 0,
      maxTokens,
      max_tokens,
      completionMaxTokens,
    };
  }

  const providerConfig = customProviderConfigs[resolvedProvider];
  const creds = resolveCredentials(resolvedProvider, apiKey, baseUrl);

  if (providerConfig.requiresApiKey && !creds.apiKey) {
    throw new Error(
      `${providerConfig.displayName} API key not found. Please set ${providerConfig.apiKeyEnvName} environment variable.`,
    );
  }

  return {
    kind: "custom",
    provider: resolvedProvider,
    displayName: providerConfig.displayName,
    model: model || process.env.LLM_MODEL_ID || providerConfig.defaultModel,
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl!,
    timeout: timeout ?? Number(process.env.LLM_TIMEOUT || 60),
    temperature: temperature ?? 0.7,
    maxTokens,
    max_tokens,
    completionMaxTokens,
  };
}

class MyLLM extends HelloAgentsLLM {
  private readonly provider: string;
  private readonly providerModel?: string;
  private readonly providerClient?: OpenAI;
  private readonly temperature: number;
  private readonly maxTokens?: number;

  constructor(options: MyLLMOptions = {}) {
    const config = resolveRuntimeConfig(options);

    super({
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      maxTokens: config.maxTokens,
      max_tokens: config.max_tokens,
      timeout: config.timeout,
    });

    this.provider = config.provider;
    this.temperature = config.temperature;
    this.maxTokens = config.completionMaxTokens;

    if (config.kind === "builtin") {
      return;
    }

    console.log(`正在使用自定义的 ${config.displayName} Provider`);
    this.providerModel = config.model;
    this.providerClient = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeout * 1000,
    });
  }

  override async think(
    messages: ChatMessage[],
    temperature?: number,
  ): Promise<string | null> {
    if (!isCustomProvider(this.provider)) {
      return super.think(messages, temperature ?? this.temperature);
    }

    console.log(`🧠 正在调用 ${this.providerModel} 模型...`);

    try {
      const stream = await this.providerClient!.chat.completions.create({
        model: this.providerModel!,
        messages,
        temperature: temperature ?? this.temperature,
        stream: true,
        ...(this.maxTokens === undefined ? {} : { max_tokens: this.maxTokens }),
      });

      console.log("✅ 大语言模型响应成功:");
      const collectedContent: string[] = [];

      for await (const chunk of stream) {
        if (!chunk.choices?.length) {
          continue;
        }

        const content = chunk.choices[0]?.delta?.content || "";
        process.stdout.write(content);
        collectedContent.push(content);
      }

      console.log();
      return collectedContent.join("");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(`❌ 调用LLM API时发生错误: ${message}`);
      return null;
    }
  }
}

export { MyLLM };
export type { MyLLMOptions, MyLLMProvider };
