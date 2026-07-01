/**
 * 配置管理。
 */
interface ConfigOptions {
  defaultModel?: string;
  defaultProvider?: string;
  temperature?: number;
  maxTokens?: number;
  debug?: boolean;
  logLevel?: string;
  maxHistoryLength?: number;
}

class Config {
  readonly defaultModel: string;
  readonly defaultProvider: string;
  readonly temperature: number;
  readonly maxTokens?: number;
  readonly debug: boolean;
  readonly logLevel: string;
  readonly maxHistoryLength: number;

  constructor(options: ConfigOptions = {}) {
    this.defaultModel = options.defaultModel ?? "gpt-3.5-turbo";
    this.defaultProvider = options.defaultProvider ?? "openai";
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens;
    this.debug = options.debug ?? false;
    this.logLevel = options.logLevel ?? "INFO";
    this.maxHistoryLength = options.maxHistoryLength ?? 100;
  }

  /**
   * 从环境变量创建配置。
   */
  static fromEnv(): Config {
    return new Config({
      defaultModel: process.env.LLM_MODEL_ID,
      defaultProvider: process.env.LLM_PROVIDER,
      debug: process.env.DEBUG?.toLowerCase() === "true",
      logLevel: process.env.LOG_LEVEL,
      temperature: Number(process.env.TEMPERATURE ?? "0.7"),
      maxTokens: process.env.MAX_TOKENS
        ? Number(process.env.MAX_TOKENS)
        : undefined,
      maxHistoryLength: process.env.MAX_HISTORY_LENGTH
        ? Number(process.env.MAX_HISTORY_LENGTH)
        : undefined,
    });
  }

  /**
   * 转换为普通对象。
   */
  toDict(): Required<Omit<ConfigOptions, "maxTokens">> & { maxTokens?: number } {
    return {
      defaultModel: this.defaultModel,
      defaultProvider: this.defaultProvider,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      debug: this.debug,
      logLevel: this.logLevel,
      maxHistoryLength: this.maxHistoryLength,
    };
  }
}

export { Config };
export type { ConfigOptions };
