import OpenAI from "openai";

import { HelloAgentsException } from "./exceptions.js";
import type { MessageRole, OpenAIMessage } from "./message.js";

export type SupportedProvider =
  | "openai"
  | "deepseek"
  | "qwen"
  | "modelscope"
  | "kimi"
  | "zhipu"
  | "ollama"
  | "vllm"
  | "local"
  | "auto"
  | "custom";

export type ChatMessage = OpenAIMessage & {
  role: MessageRole;
};

export interface HelloAgentsLLMOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  provider?: SupportedProvider;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  env?: Record<string, string | undefined>;
  client?: OpenAICompatibleClient;
  extraOptions?: Record<string, unknown>;
}

interface ChatCompletionChoice {
  message?: {
    content?: string | null;
  };
  delta?: {
    content?: string | null;
  };
}

interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
}

interface ChatCompletionChunk {
  choices: ChatCompletionChoice[];
}

interface ChatCompletionCreateParams {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface OpenAICompatibleClient {
  chat: {
    completions: {
      create(
        params: ChatCompletionCreateParams,
      ):
        | Promise<ChatCompletionResponse>
        | Promise<AsyncIterable<ChatCompletionChunk>>
        | AsyncIterable<ChatCompletionChunk>;
    };
  };
}

type Env = Record<string, string | undefined>;

function currentEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

function hasValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function readTimeout(env: Env, timeout: number | undefined): number {
  if (timeout !== undefined) {
    return timeout;
  }

  const parsed = Number(env.LLM_TIMEOUT);
  return Number.isFinite(parsed) ? parsed : 60;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ChatCompletionChunk> {
  return typeof (value as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator] === "function";
}

export class HelloAgentsLLM {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly provider: SupportedProvider;
  readonly temperature: number;
  readonly maxTokens?: number;
  readonly timeout: number;

  private readonly client: OpenAICompatibleClient;
  private readonly env: Env;
  private readonly extraOptions: Record<string, unknown>;

  constructor(options: HelloAgentsLLMOptions = {}) {
    this.env = options.env ?? currentEnv();
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens;
    this.timeout = readTimeout(this.env, options.timeout);
    this.extraOptions = options.extraOptions ?? {};

    const requestedProvider = options.provider?.toLowerCase() as SupportedProvider | undefined;
    this.provider = requestedProvider ?? this.autoDetectProvider(options.apiKey, options.baseUrl);

    const credentials =
      requestedProvider === "custom"
        ? {
            apiKey: options.apiKey ?? this.env.LLM_API_KEY,
            baseUrl: options.baseUrl ?? this.env.LLM_BASE_URL,
          }
        : this.resolveCredentials(options.apiKey, options.baseUrl);

    this.apiKey = credentials.apiKey ?? "";
    this.baseUrl = credentials.baseUrl ?? "";
    this.model = options.model ?? this.env.LLM_MODEL_ID ?? this.getDefaultModel();

    if (!hasValue(this.apiKey) || !hasValue(this.baseUrl)) {
      throw new HelloAgentsException("API密钥和服务地址必须被提供或在.env文件中定义。");
    }

    this.client = options.client ?? this.createClient();
  }

  private autoDetectProvider(apiKey?: string, baseUrl?: string): SupportedProvider {
    if (hasValue(this.env.OPENAI_API_KEY)) {
      return "openai";
    }
    if (hasValue(this.env.DEEPSEEK_API_KEY)) {
      return "deepseek";
    }
    if (hasValue(this.env.DASHSCOPE_API_KEY)) {
      return "qwen";
    }
    if (hasValue(this.env.MODELSCOPE_API_KEY)) {
      return "modelscope";
    }
    if (hasValue(this.env.KIMI_API_KEY) || hasValue(this.env.MOONSHOT_API_KEY)) {
      return "kimi";
    }
    if (hasValue(this.env.ZHIPU_API_KEY) || hasValue(this.env.GLM_API_KEY)) {
      return "zhipu";
    }
    if (hasValue(this.env.OLLAMA_API_KEY) || hasValue(this.env.OLLAMA_HOST)) {
      return "ollama";
    }
    if (hasValue(this.env.VLLM_API_KEY) || hasValue(this.env.VLLM_HOST)) {
      return "vllm";
    }

    const actualApiKey = apiKey ?? this.env.LLM_API_KEY;
    if (hasValue(actualApiKey)) {
      const keyLower = actualApiKey.toLowerCase();
      if (actualApiKey.startsWith("ms-")) {
        return "modelscope";
      }
      if (keyLower === "ollama") {
        return "ollama";
      }
      if (keyLower === "vllm") {
        return "vllm";
      }
      if (keyLower === "local") {
        return "local";
      }
      if (actualApiKey.endsWith(".") || actualApiKey.slice(-20).includes(".")) {
        return "zhipu";
      }
    }

    const actualBaseUrl = baseUrl ?? this.env.LLM_BASE_URL;
    if (hasValue(actualBaseUrl)) {
      const baseUrlLower = actualBaseUrl.toLowerCase();
      if (baseUrlLower.includes("api.openai.com")) {
        return "openai";
      }
      if (baseUrlLower.includes("api.deepseek.com")) {
        return "deepseek";
      }
      if (baseUrlLower.includes("dashscope.aliyuncs.com")) {
        return "qwen";
      }
      if (baseUrlLower.includes("api-inference.modelscope.cn")) {
        return "modelscope";
      }
      if (baseUrlLower.includes("api.moonshot.cn")) {
        return "kimi";
      }
      if (baseUrlLower.includes("open.bigmodel.cn")) {
        return "zhipu";
      }
      if (baseUrlLower.includes("localhost") || baseUrlLower.includes("127.0.0.1")) {
        if (baseUrlLower.includes(":11434") || baseUrlLower.includes("ollama")) {
          return "ollama";
        }
        if (baseUrlLower.includes(":8000") && baseUrlLower.includes("vllm")) {
          return "vllm";
        }
        if (baseUrlLower.includes(":8080") || baseUrlLower.includes(":7860")) {
          return "local";
        }
        if (actualApiKey?.toLowerCase() === "ollama") {
          return "ollama";
        }
        if (actualApiKey?.toLowerCase() === "vllm") {
          return "vllm";
        }
        return "local";
      }
      if ([":8080", ":7860", ":5000"].some((port) => baseUrlLower.includes(port))) {
        return "local";
      }
    }

    return "auto";
  }

  private resolveCredentials(apiKey?: string, baseUrl?: string): {
    apiKey?: string;
    baseUrl?: string;
  } {
    switch (this.provider) {
      case "openai":
        return {
          apiKey: apiKey ?? this.env.OPENAI_API_KEY ?? this.env.LLM_API_KEY,
          baseUrl: baseUrl ?? this.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
        };
      case "deepseek":
        return {
          apiKey: apiKey ?? this.env.DEEPSEEK_API_KEY ?? this.env.LLM_API_KEY,
          baseUrl: baseUrl ?? this.env.LLM_BASE_URL ?? "https://api.deepseek.com",
        };
      case "qwen":
        return {
          apiKey: apiKey ?? this.env.DASHSCOPE_API_KEY ?? this.env.LLM_API_KEY,
          baseUrl: baseUrl ?? this.env.LLM_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
        };
      case "modelscope":
        return {
          apiKey: apiKey ?? this.env.MODELSCOPE_API_KEY ?? this.env.LLM_API_KEY,
          baseUrl: baseUrl ?? this.env.LLM_BASE_URL ?? "https://api-inference.modelscope.cn/v1/",
        };
      case "kimi":
        return {
          apiKey: apiKey ?? this.env.KIMI_API_KEY ?? this.env.MOONSHOT_API_KEY ?? this.env.LLM_API_KEY,
          baseUrl: baseUrl ?? this.env.LLM_BASE_URL ?? "https://api.moonshot.cn/v1",
        };
      case "zhipu":
        return {
          apiKey: apiKey ?? this.env.ZHIPU_API_KEY ?? this.env.GLM_API_KEY ?? this.env.LLM_API_KEY,
          baseUrl: baseUrl ?? this.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
        };
      case "ollama":
        return {
          apiKey: apiKey ?? this.env.OLLAMA_API_KEY ?? this.env.LLM_API_KEY ?? "ollama",
          baseUrl: baseUrl ?? this.env.OLLAMA_HOST ?? this.env.LLM_BASE_URL ?? "http://localhost:11434/v1",
        };
      case "vllm":
        return {
          apiKey: apiKey ?? this.env.VLLM_API_KEY ?? this.env.LLM_API_KEY ?? "vllm",
          baseUrl: baseUrl ?? this.env.VLLM_HOST ?? this.env.LLM_BASE_URL ?? "http://localhost:8000/v1",
        };
      case "local":
        return {
          apiKey: apiKey ?? this.env.LLM_API_KEY ?? "local",
          baseUrl: baseUrl ?? this.env.LLM_BASE_URL ?? "http://localhost:8000/v1",
        };
      case "custom":
        return {
          apiKey: apiKey ?? this.env.LLM_API_KEY,
          baseUrl: baseUrl ?? this.env.LLM_BASE_URL,
        };
      case "auto":
        return {
          apiKey: apiKey ?? this.env.LLM_API_KEY,
          baseUrl: baseUrl ?? this.env.LLM_BASE_URL,
        };
    }
  }

  private createClient(): OpenAICompatibleClient {
    return new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      timeout: this.timeout * 1000,
    }) as unknown as OpenAICompatibleClient;
  }

  private getDefaultModel(): string {
    switch (this.provider) {
      case "openai":
        return "gpt-3.5-turbo";
      case "deepseek":
        return "deepseek-chat";
      case "qwen":
        return "qwen-plus";
      case "modelscope":
        return "Qwen/Qwen2.5-72B-Instruct";
      case "kimi":
        return "moonshot-v1-8k";
      case "zhipu":
        return "glm-4";
      case "ollama":
        return "llama3.2";
      case "vllm":
        return "meta-llama/Llama-2-7b-chat-hf";
      case "local":
        return "local-model";
      case "custom":
        return this.model || "gpt-3.5-turbo";
      case "auto": {
        const baseUrlLower = (this.env.LLM_BASE_URL ?? "").toLowerCase();
        if (baseUrlLower.includes("modelscope")) {
          return "Qwen/Qwen2.5-72B-Instruct";
        }
        if (baseUrlLower.includes("deepseek")) {
          return "deepseek-chat";
        }
        if (baseUrlLower.includes("dashscope")) {
          return "qwen-plus";
        }
        if (baseUrlLower.includes("moonshot")) {
          return "moonshot-v1-8k";
        }
        if (baseUrlLower.includes("bigmodel")) {
          return "glm-4";
        }
        if (baseUrlLower.includes("ollama") || baseUrlLower.includes(":11434")) {
          return "llama3.2";
        }
        if (baseUrlLower.includes(":8000") || baseUrlLower.includes("vllm")) {
          return "meta-llama/Llama-2-7b-chat-hf";
        }
        if (baseUrlLower.includes("localhost") || baseUrlLower.includes("127.0.0.1")) {
          return "local-model";
        }
        return "gpt-3.5-turbo";
      }
    }
  }

  async *think(messages: ChatMessage[], temperature?: number): AsyncGenerator<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: temperature ?? this.temperature,
        max_tokens: this.maxTokens,
        stream: true,
        ...this.extraOptions,
      });

      if (!isAsyncIterable(response)) {
        throw new HelloAgentsException("LLM流式调用没有返回可迭代响应。");
      }

      for await (const chunk of response) {
        const content = chunk.choices[0]?.delta?.content ?? "";
        if (content) {
          yield content;
        }
      }
    } catch (error) {
      throw new HelloAgentsException(`LLM调用失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async invoke(messages: ChatMessage[], options: Record<string, unknown> = {}): Promise<string> {
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

      return response.choices[0]?.message?.content ?? "";
    } catch (error) {
      throw new HelloAgentsException(`LLM调用失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  streamInvoke(messages: ChatMessage[], options: Record<string, unknown> = {}): AsyncGenerator<string> {
    const temperature = typeof options.temperature === "number" ? options.temperature : undefined;
    return this.think(messages, temperature);
  }
}
