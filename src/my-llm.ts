import OpenAI from "openai";

import {
  HelloAgentsLLM,
  type ChatMessage,
  type HelloAgentsLLMOptions,
} from "./hello-agents-llm.js";

interface MyLLMOptions extends HelloAgentsLLMOptions {
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  max_tokens?: number;
}

const customProviderConfigs = {
  modelscope: {
    displayName: "ModelScope",
    apiKeyEnvName: "MODELSCOPE_API_KEY",
    getApiKey: () => process.env.MODELSCOPE_API_KEY,
    baseUrl: "https://api-inference.modelscope.cn/v1/",
    defaultModel: "Qwen/Qwen2.5-VL-72B-Instruct",
    requiresApiKey: true,
  },
  evolink: {
    displayName: "Evolink",
    apiKeyEnvName: "EVOLINK_API_KEY",
    getApiKey: () => process.env.EVOLINK_API_KEY,
    baseUrl: "https://direct.evolink.ai/v1",
    defaultModel: "gemini-2.5-flash-lite",
    requiresApiKey: true,
  },
  ollama: {
    displayName: "Ollama",
    apiKeyEnvName: "OLLAMA_API_KEY",
    getApiKey: () => process.env.OLLAMA_API_KEY || "ollama",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen3:8b",
    requiresApiKey: false,
  },
} as const;

type CustomProvider = keyof typeof customProviderConfigs;

function isCustomProvider(provider: string): provider is CustomProvider {
  return provider in customProviderConfigs;
}

class MyLLM extends HelloAgentsLLM {
  private readonly provider: string;
  private readonly providerModel?: string;
  private readonly providerClient?: OpenAI;
  private readonly temperature: number;
  private readonly maxTokens?: number;

  constructor({
    model,
    apiKey,
    baseUrl,
    provider = "auto",
    temperature,
    maxTokens,
    max_tokens,
    timeout,
  }: MyLLMOptions = {}) {
    if (!isCustomProvider(provider)) {
      super({ model, apiKey, baseUrl, timeout });
      this.provider = provider;
      this.temperature = temperature ?? 0;
      this.maxTokens = maxTokens ?? max_tokens;
      return;
    }

    const providerConfig = customProviderConfigs[provider];

    console.log(`正在使用自定义的 ${providerConfig.displayName} Provider`);

    const resolvedApiKey = apiKey || providerConfig.getApiKey();

    if (providerConfig.requiresApiKey && !resolvedApiKey) {
      throw new Error(
        `${providerConfig.displayName} API key not found. Please set ${providerConfig.apiKeyEnvName} environment variable.`,
      );
    }

    const resolvedModel = model || process.env.LLM_MODEL_ID || providerConfig.defaultModel;
    const resolvedBaseUrl = baseUrl || providerConfig.baseUrl;
    const resolvedTimeout = timeout ?? 60;

    super({
      model: resolvedModel,
      apiKey: resolvedApiKey,
      baseUrl: resolvedBaseUrl,
      timeout: resolvedTimeout,
    });

    this.provider = provider;
    this.providerModel = resolvedModel;
    this.temperature = temperature ?? 0.7;
    this.maxTokens = maxTokens ?? max_tokens;
    this.providerClient = new OpenAI({
      apiKey: resolvedApiKey,
      baseURL: resolvedBaseUrl,
      timeout: resolvedTimeout * 1000,
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
export type { MyLLMOptions };
