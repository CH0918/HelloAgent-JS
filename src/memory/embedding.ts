import { currentEnv, hashToVector, normalizeVector, readInteger, tokenize } from "./utils.js";
import type { Env } from "./utils.js";

export type EmbeddingInput = string | string[];

export interface EmbeddingModel {
  readonly dimension: number;
  encode(texts: EmbeddingInput): Promise<number[] | number[][]>;
}

export interface EmbeddingModelOptions {
  modelName?: string;
  apiKey?: string;
  baseUrl?: string;
  dimension?: number;
  env?: Env;
}

export class OpenAICompatibleEmbedding implements EmbeddingModel {
  readonly modelName: string;
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly dimension: number;

  constructor(options: EmbeddingModelOptions = {}) {
    this.modelName = options.modelName ?? "text-embedding-3-small";
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.dimension = options.dimension ?? 1536;

    if (!this.apiKey) {
      throw new Error("OpenAI-compatible embedding 需要 EMBED_API_KEY。");
    }
    if (!this.modelName) {
      throw new Error("OpenAI-compatible embedding 需要 EMBED_MODEL_NAME。");
    }
  }

  async encode(texts: EmbeddingInput): Promise<number[] | number[][]> {
    const inputs = Array.isArray(texts) ? texts : [texts];
    const fetcher = getRequiredFetch();
    const response = await fetcher(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelName,
        input: inputs,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding REST 调用失败: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const vectors = (data.data ?? []).map((item) => normalizeVector(item.embedding ?? [], this.dimension));
    return Array.isArray(texts) ? vectors : vectors[0] ?? new Array<number>(this.dimension).fill(0);
  }
}

export class DashScopeEmbedding extends OpenAICompatibleEmbedding {
  constructor(options: EmbeddingModelOptions = {}) {
    super({
      ...options,
      modelName: options.modelName ?? "text-embedding-v3",
      baseUrl: options.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
      dimension: options.dimension ?? 1024,
    });
  }
}

export class LocalTransformerEmbedding implements EmbeddingModel {
  readonly modelName: string;
  readonly dimension: number;
  private extractorPromise?: Promise<(input: string | string[], options?: Record<string, unknown>) => Promise<unknown>>;

  constructor(options: EmbeddingModelOptions = {}) {
    this.modelName = options.modelName ?? "Xenova/all-MiniLM-L6-v2";
    this.dimension = options.dimension ?? 384;
  }

  async encode(texts: EmbeddingInput): Promise<number[] | number[][]> {
    const extractor = await this.getExtractor();
    const inputs = Array.isArray(texts) ? texts : [texts];
    const output = await extractor(inputs, { pooling: "mean", normalize: true });
    const vectors = this.normalizeTransformerOutput(output, inputs.length);
    return Array.isArray(texts) ? vectors : vectors[0] ?? new Array<number>(this.dimension).fill(0);
  }

  private async getExtractor(): Promise<(input: string | string[], options?: Record<string, unknown>) => Promise<unknown>> {
    this.extractorPromise ??= this.loadExtractor();
    return this.extractorPromise;
  }

  private async loadExtractor(): Promise<(input: string | string[], options?: Record<string, unknown>) => Promise<unknown>> {
    const module = await importOptional<Record<string, unknown>>("@xenova/transformers");
    const pipeline = module.pipeline;
    if (typeof pipeline !== "function") {
      throw new Error("@xenova/transformers 未提供 pipeline 方法。");
    }
    return (await pipeline("feature-extraction", this.modelName)) as (
      input: string | string[],
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
  }

  private normalizeTransformerOutput(output: unknown, count: number): number[][] {
    if (Array.isArray(output)) {
      const nested = output as unknown[];
      if (nested.length > 0 && Array.isArray(nested[0])) {
        return nested.map((item) => normalizeVector(item as number[], this.dimension)).slice(0, count);
      }
    }

    if (isTensorLike(output)) {
      const data = Array.from(output.data as Iterable<number>);
      if (count <= 1) {
        return [normalizeVector(data, this.dimension)];
      }
      const perItem = Math.max(1, Math.floor(data.length / count));
      return new Array(count)
        .fill(0)
        .map((_, index) => normalizeVector(data.slice(index * perItem, (index + 1) * perItem), this.dimension));
    }

    return new Array(count).fill(0).map((_, index) => hashToVector(`local-fallback:${index}`, this.dimension));
  }
}

export class TFIDFEmbedding implements EmbeddingModel {
  readonly dimension: number;

  constructor(options: EmbeddingModelOptions = {}) {
    this.dimension = options.dimension ?? 384;
  }

  async encode(texts: EmbeddingInput): Promise<number[] | number[][]> {
    const inputs = Array.isArray(texts) ? texts : [texts];
    const vectors = inputs.map((text) => this.vectorize(text));
    return Array.isArray(texts) ? vectors : vectors[0] ?? new Array<number>(this.dimension).fill(0);
  }

  private vectorize(text: string): number[] {
    const vector = new Array<number>(this.dimension).fill(0);
    const tokens = tokenize(text);

    for (const token of tokens) {
      const index = Math.abs(hashToken(token)) % this.dimension;
      vector[index] += 1;
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? vector.map((value) => value / norm) : hashToVector(text, this.dimension);
  }
}

export function createEmbeddingModel(modelType = "local", options: EmbeddingModelOptions = {}): EmbeddingModel {
  const normalizedType = normalizeEmbeddingModelType(modelType);
  const resolvedOptions = withEmbeddingDefaults(normalizedType, options);
  if (normalizedType === "dashscope") {
    return new DashScopeEmbedding(resolvedOptions);
  }
  if (normalizedType === "openai_compatible" || normalizedType === "openrouter") {
    return new OpenAICompatibleEmbedding(resolvedOptions);
  }
  if (normalizedType === "local") {
    return new LocalTransformerEmbedding(resolvedOptions);
  }
  if (normalizedType === "tfidf") {
    return new TFIDFEmbedding(resolvedOptions);
  }
  throw new Error(`不支持的嵌入模型类型: ${modelType}`);
}

export async function createEmbeddingModelWithFallback(
  preferredType = "openai_compatible",
  options: EmbeddingModelOptions = {},
): Promise<EmbeddingModel> {
  const normalizedPreferred = normalizeEmbeddingModelType(preferredType);
  const order =
    normalizedPreferred === "openrouter"
      ? ["openrouter", "local", "tfidf"]
      : normalizedPreferred === "dashscope"
        ? ["dashscope", "openai_compatible", "local", "tfidf"]
        : ["openai_compatible", "dashscope", "local", "tfidf"];
  const fallback = order.includes(normalizedPreferred)
    ? [normalizedPreferred, ...order.filter((item) => item !== normalizedPreferred)]
    : order;

  let lastError: unknown;
  for (const type of fallback) {
    try {
      const model = createEmbeddingModel(type, options);
      if (type !== "tfidf") {
        await model.encode("health_check");
      }
      return model;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`所有嵌入模型都不可用: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

let embedderPromise: Promise<EmbeddingModel> | undefined;

export async function getTextEmbedder(): Promise<EmbeddingModel> {
  embedderPromise ??= buildEmbedder();
  return embedderPromise;
}

export async function getDimension(defaultDimension = 384): Promise<number> {
  try {
    const embedder = await getTextEmbedder();
    return embedder.dimension || defaultDimension;
  } catch {
    return defaultDimension;
  }
}

export async function refreshEmbedder(): Promise<EmbeddingModel> {
  embedderPromise = buildEmbedder();
  return embedderPromise;
}

async function buildEmbedder(): Promise<EmbeddingModel> {
  const env = currentEnv();
  const preferred = normalizeEmbeddingModelType(env.EMBED_MODEL_TYPE?.trim() || "openai_compatible");
  const defaults = getEmbeddingDefaults(preferred);
  const dimension = readInteger(env.EMBED_DIMENSION, defaults.dimension);
  return createEmbeddingModelWithFallback(preferred, {
    modelName: env.EMBED_MODEL_NAME?.trim() || undefined,
    apiKey: env.EMBED_API_KEY,
    baseUrl: env.EMBED_BASE_URL,
    dimension,
    env,
  });
}

function withEmbeddingDefaults(modelType: string, options: EmbeddingModelOptions): EmbeddingModelOptions {
  const defaults = getEmbeddingDefaults(modelType);
  return {
    ...options,
    modelName: options.modelName ?? defaults.modelName,
    baseUrl: options.baseUrl ?? defaults.baseUrl,
    dimension: options.dimension ?? defaults.dimension,
  };
}

function normalizeEmbeddingModelType(modelType: string): string {
  const normalized = modelType.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "sentence_transformer" || normalized === "sentence_transformers" || normalized === "huggingface") {
    return "local";
  }
  if (normalized === "openai" || normalized === "openai_compatible" || normalized === "openai_compat" || normalized === "remote") {
    return "openai_compatible";
  }
  if (normalized === "openrouter") {
    return "openrouter";
  }
  return normalized;
}

function getEmbeddingDefaults(modelType: string): { modelName: string; baseUrl?: string; dimension: number } {
  if (modelType === "dashscope") {
    return {
      modelName: "text-embedding-v3",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      dimension: 1024,
    };
  }
  if (modelType === "openrouter") {
    return {
      modelName: "",
      baseUrl: "https://openrouter.ai/api/v1",
      dimension: 1536,
    };
  }
  if (modelType === "openai_compatible") {
    return {
      modelName: "text-embedding-3-small",
      baseUrl: "https://api.openai.com/v1",
      dimension: 1536,
    };
  }
  return {
    modelName: "Xenova/all-MiniLM-L6-v2",
    dimension: 384,
  };
}

async function importOptional<T>(specifier: string): Promise<T> {
  const importer = new Function("specifier", "return import(specifier)") as (value: string) => Promise<T>;
  return importer(specifier);
}

function hashToken(token: string): number {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = Math.imul(31, hash) + token.charCodeAt(index);
  }
  return hash;
}

function isTensorLike(value: unknown): value is { data: Iterable<number> } {
  return typeof value === "object" && value !== null && "data" in value;
}

interface EmbeddingFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

type EmbeddingFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<EmbeddingFetchResponse>;

function getRequiredFetch(): EmbeddingFetch {
  const fetcher = (globalThis as { fetch?: EmbeddingFetch }).fetch;
  if (!fetcher) {
    throw new Error("当前运行环境不支持 fetch，无法调用远程 embedding 服务。");
  }
  return fetcher;
}
