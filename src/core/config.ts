export interface ConfigOptions {
  defaultModel?: string;
  defaultProvider?: string;
  temperature?: number;
  maxTokens?: number;
  debug?: boolean;
  logLevel?: string;
  maxHistoryLength?: number;
}

export interface ConfigDict {
  defaultModel: string;
  defaultProvider: string;
  temperature: number;
  maxTokens?: number;
  debug: boolean;
  logLevel: string;
  maxHistoryLength: number;
}

type Env = Record<string, string | undefined>;

function currentEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

function readNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class Config {
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

  static fromEnv(env: Env = currentEnv()): Config {
    return new Config({
      debug: env.DEBUG?.toLowerCase() === "true",
      logLevel: env.LOG_LEVEL ?? "INFO",
      temperature: readNumber(env.TEMPERATURE) ?? 0.7,
      maxTokens: readNumber(env.MAX_TOKENS),
    });
  }

  toDict(): ConfigDict {
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
