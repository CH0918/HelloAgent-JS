import { currentEnv, isUuid, readBoolean, readInteger } from "../utils.js";

export interface QdrantVectorStoreOptions {
  url?: string;
  apiKey?: string;
  collectionName?: string;
  vectorSize?: number;
  distance?: "cosine" | "dot" | "euclidean";
  timeout?: number;
}

export interface QdrantSearchHit {
  id: string | number;
  score: number;
  metadata: Record<string, unknown>;
}

interface QdrantFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

type QdrantFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<QdrantFetchResponse>;

export class QdrantConnectionManager {
  private static readonly instances = new Map<string, QdrantVectorStore>();

  static getInstance(options: QdrantVectorStoreOptions = {}): QdrantVectorStore {
    const key = `${options.url ?? "local"}:${options.collectionName ?? "hello_agents_vectors"}`;
    const existing = QdrantConnectionManager.instances.get(key);
    if (existing) {
      return existing;
    }
    const store = new QdrantVectorStore(options);
    QdrantConnectionManager.instances.set(key, store);
    return store;
  }
}

export class QdrantVectorStore {
  readonly url: string;
  readonly apiKey?: string;
  readonly collectionName: string;
  readonly vectorSize: number;
  readonly distance: "cosine" | "dot" | "euclidean";
  readonly timeout: number;
  readonly searchEf: number;
  readonly searchExact: boolean;

  private initialization?: Promise<void>;

  constructor(options: QdrantVectorStoreOptions = {}) {
    const env = currentEnv();
    this.url = (options.url ?? env.QDRANT_URL ?? "http://localhost:6333").replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? env.QDRANT_API_KEY;
    this.collectionName = options.collectionName ?? env.QDRANT_COLLECTION ?? "hello_agents_vectors";
    this.vectorSize =
      options.vectorSize ??
      readInteger(env.QDRANT_VECTOR_SIZE, readInteger(env.EMBED_DIMENSION, defaultEmbeddingDimension(env.EMBED_MODEL_TYPE)));
    this.distance = options.distance ?? normalizeDistance(env.QDRANT_DISTANCE);
    this.timeout = options.timeout ?? readInteger(env.QDRANT_TIMEOUT, 30);
    this.searchEf = readInteger(env.QDRANT_SEARCH_EF, 128);
    this.searchExact = readBoolean(env.QDRANT_SEARCH_EXACT, false);
  }

  async addVectors(input: {
    vectors: number[][];
    metadata: Record<string, unknown>[];
    ids?: string[];
  }): Promise<boolean> {
    await this.ensureCollection();
    const points = input.vectors.flatMap((vector, index) => {
      if (vector.length !== this.vectorSize) {
        return [];
      }
      return [
        {
          id: normalizePointId(input.ids?.[index]),
          vector,
          payload: {
            ...(input.metadata[index] ?? {}),
            timestamp: Math.floor(Date.now() / 1000),
            added_at: Math.floor(Date.now() / 1000),
          },
        },
      ];
    });

    if (points.length === 0) {
      return false;
    }

    await this.request(`/collections/${encodeURIComponent(this.collectionName)}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ points }),
    });
    return true;
  }

  async searchSimilar(input: {
    queryVector: number[];
    limit?: number;
    scoreThreshold?: number;
    where?: Record<string, unknown>;
  }): Promise<QdrantSearchHit[]> {
    await this.ensureCollection();
    if (input.queryVector.length !== this.vectorSize) {
      return [];
    }
    const body: Record<string, unknown> = {
      vector: input.queryVector,
      limit: input.limit ?? 10,
      with_payload: true,
      with_vector: false,
      params: {
        hnsw_ef: this.searchEf,
        exact: this.searchExact,
      },
    };

    if (input.scoreThreshold !== undefined) {
      body.score_threshold = input.scoreThreshold;
    }
    const filter = buildFilter(input.where);
    if (filter) {
      body.filter = filter;
    }

    const data = await this.request(`/collections/${encodeURIComponent(this.collectionName)}/points/search`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const result = (data as { result?: unknown[] }).result ?? [];
    return result.map((hit) => {
      const item = hit as Record<string, unknown>;
      return {
        id: (item.id as string | number | undefined) ?? "",
        score: Number(item.score ?? 0),
        metadata:
          typeof item.payload === "object" && item.payload !== null && !Array.isArray(item.payload)
            ? (item.payload as Record<string, unknown>)
            : {},
      };
    });
  }

  async deleteMemories(memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) {
      return;
    }
    await this.ensureCollection();
    await this.request(`/collections/${encodeURIComponent(this.collectionName)}/points/delete?wait=true`, {
      method: "POST",
      body: JSON.stringify({
        filter: {
          should: memoryIds.map((memoryId) => ({
            key: "memory_id",
            match: { value: memoryId },
          })),
        },
      }),
    });
  }

  async deleteByFilter(where: Record<string, unknown>): Promise<void> {
    const filter = buildFilter(where);
    if (!filter) {
      return;
    }
    await this.ensureCollection();
    await this.request(`/collections/${encodeURIComponent(this.collectionName)}/points/delete?wait=true`, {
      method: "POST",
      body: JSON.stringify({ filter }),
    });
  }

  async clearCollection(): Promise<boolean> {
    try {
      await this.request(`/collections/${encodeURIComponent(this.collectionName)}`, { method: "DELETE" });
    } catch {
      // Recreate even if deletion fails because the collection may not exist.
    }
    this.initialization = undefined;
    await this.ensureCollection();
    return true;
  }

  async getCollectionStats(): Promise<Record<string, unknown>> {
    try {
      const data = await this.request(`/collections/${encodeURIComponent(this.collectionName)}`);
      const result = (data as { result?: Record<string, unknown> }).result ?? {};
      return {
        store_type: "qdrant",
        name: this.collectionName,
        points_count: result.points_count,
        vectors_count: result.vectors_count,
        indexed_vectors_count: result.indexed_vectors_count,
        config: {
          vector_size: this.vectorSize,
          distance: this.distance,
        },
      };
    } catch {
      return {
        store_type: "qdrant",
        name: this.collectionName,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request("/collections");
      return true;
    } catch {
      return false;
    }
  }

  private async ensureCollection(): Promise<void> {
    this.initialization ??= this.initializeCollection();
    return this.initialization;
  }

  private async initializeCollection(): Promise<void> {
    const collectionName = encodeURIComponent(this.collectionName);
    const collections = await this.request("/collections");
    const existing = ((collections as { result?: { collections?: Array<{ name?: string }> } }).result?.collections ?? []).some(
      (collection) => collection.name === this.collectionName,
    );

    if (!existing) {
      await this.request(`/collections/${collectionName}`, {
        method: "PUT",
        body: JSON.stringify({
          vectors: {
            size: this.vectorSize,
            distance: mapDistance(this.distance),
          },
        }),
      });
    }

    await this.ensurePayloadIndexes();
  }

  private async ensurePayloadIndexes(): Promise<void> {
    const fields = [
      "memory_type",
      "user_id",
      "memory_id",
      "timestamp",
      "modality",
      "source",
      "external",
      "namespace",
      "is_rag_data",
      "rag_namespace",
      "data_source",
    ];
    for (const fieldName of fields) {
      try {
        await this.request(`/collections/${encodeURIComponent(this.collectionName)}/index`, {
          method: "PUT",
          body: JSON.stringify({
            field_name: fieldName,
            field_schema: fieldName === "timestamp" ? "integer" : fieldName === "external" || fieldName === "is_rag_data" ? "bool" : "keyword",
          }),
        });
      } catch {
        // Qdrant returns an error if the index exists; Python skips these too.
      }
    }
  }

  private async request(path: string, init: { method?: string; body?: string } = {}): Promise<unknown> {
    const fetcher = getRequiredFetch();
    const response = await fetcher(`${this.url}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(this.apiKey ? { "api-key": this.apiKey } : {}),
        "Content-Type": "application/json",
      },
      body: init.body,
    });
    if (!response.ok) {
      throw new Error(`Qdrant 请求失败: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }
}

function normalizeDistance(value: string | undefined): QdrantVectorStore["distance"] {
  const candidate = value?.toLowerCase();
  if (candidate === "dot" || candidate === "euclidean") {
    return candidate;
  }
  return "cosine";
}

function defaultEmbeddingDimension(modelType: string | undefined): number {
  const normalized = modelType?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "dashscope") {
    return 1024;
  }
  if (
    normalized === "openai" ||
    normalized === "openai_compatible" ||
    normalized === "openai_compat" ||
    normalized === "openrouter" ||
    normalized === "remote"
  ) {
    return 1536;
  }
  return 384;
}

function mapDistance(distance: QdrantVectorStore["distance"]): string {
  if (distance === "dot") {
    return "Dot";
  }
  if (distance === "euclidean") {
    return "Euclid";
  }
  return "Cosine";
}

function normalizePointId(value: string | undefined): string {
  if (value && isUuid(value)) {
    return value;
  }
  return generateUuidV4();
}

function generateUuidV4(): string {
  const bytes = new Array<number>(16).fill(0).map(() => Math.floor(Math.random() * 256));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function buildFilter(where: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!where) {
    return undefined;
  }
  const must = Object.entries(where)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => ({
      key,
      match: { value },
    }));
  return must.length > 0 ? { must } : undefined;
}

function getRequiredFetch(): QdrantFetch {
  const fetcher = (globalThis as { fetch?: QdrantFetch }).fetch;
  if (!fetcher) {
    throw new Error("当前运行环境不支持 fetch，无法连接 Qdrant。请使用 Node.js 18+。");
  }
  return fetcher;
}
