import { getDatabaseConfig } from "../../core/database-config.js";
import { BaseMemory, MemoryItem, type MemoryMetadata, type MemoryStats, type RetrieveMemoryOptions } from "../base.js";
import type { MemoryConfig } from "../base.js";
import { getDimension, getTextEmbedder } from "../embedding.js";
import { QdrantConnectionManager, SQLiteDocumentStore } from "../storage/index.js";
import type { QdrantVectorStore, StoredMemory } from "../storage/index.js";
import { dirname, hashString, hashToVector, readBinaryLike } from "../utils.js";

export class Perception {
  readonly perceptionId: string;
  readonly data: unknown;
  readonly modality: string;
  readonly encoding: number[];
  readonly metadata: Record<string, unknown>;
  readonly timestamp: Date;
  readonly dataHash: string;

  constructor(input: {
    perceptionId: string;
    data: unknown;
    modality: string;
    encoding?: number[];
    metadata?: Record<string, unknown>;
  }) {
    this.perceptionId = input.perceptionId;
    this.data = input.data;
    this.modality = input.modality;
    this.encoding = input.encoding ?? [];
    this.metadata = input.metadata ?? {};
    this.timestamp = new Date();
    this.dataHash = String(hashString(typeof input.data === "string" ? input.data : JSON.stringify(input.data)));
  }
}

export class PerceptualMemory extends BaseMemory {
  private readonly perceptions = new Map<string, Perception>();
  private readonly perceptualMemories: MemoryItem[] = [];
  private readonly modalityIndex = new Map<string, string[]>();
  private readonly supportedModalities: Set<string>;
  private readonly docStore: SQLiteDocumentStore;
  private readonly vectorStoresPromise: Promise<Map<string, QdrantVectorStore>>;
  private readonly vectorDimensionsPromise: Promise<Map<string, number>>;

  constructor(config: MemoryConfig) {
    super(config);
    this.supportedModalities = new Set(config.perceptualMemoryModalities);
    this.docStore = SQLiteDocumentStore.getInstance(`${dirname(config.storagePath) === "." ? config.storagePath : config.storagePath}/memory.db`);
    this.vectorDimensionsPromise = this.createVectorDimensions();
    this.vectorStoresPromise = this.createVectorStores();
  }

  async add(memoryItem: MemoryItem): Promise<string> {
    const modality = String(memoryItem.metadata.modality ?? "text");
    const rawData = memoryItem.metadata.raw_data ?? memoryItem.content;
    if (!this.supportedModalities.has(modality)) {
      throw new Error(`不支持的模态类型: ${modality}`);
    }

    const perception = await this.encodePerception(rawData, modality, memoryItem.id);
    this.perceptions.set(perception.perceptionId, perception);
    this.modalityIndex.set(modality, [...(this.modalityIndex.get(modality) ?? []), perception.perceptionId]);
    memoryItem.metadata.perception_id = perception.perceptionId;
    memoryItem.metadata.modality = modality;
    this.perceptualMemories.push(memoryItem);

    await this.docStore.addMemory({
      memoryId: memoryItem.id,
      userId: memoryItem.userId,
      content: memoryItem.content,
      memoryType: "perceptual",
      timestamp: Math.floor(memoryItem.timestamp.getTime() / 1000),
      importance: memoryItem.importance,
      properties: {
        perception_id: perception.perceptionId,
        modality,
        context: normalizeRecord(memoryItem.metadata.context),
        tags: Array.isArray(memoryItem.metadata.tags) ? memoryItem.metadata.tags : [],
      },
    });

    try {
      const store = await this.getVectorStoreForModality(modality);
      await store.addVectors({
        vectors: [perception.encoding],
        metadata: [
          {
            memory_id: memoryItem.id,
            user_id: memoryItem.userId,
            memory_type: "perceptual",
            modality,
            importance: memoryItem.importance,
            content: memoryItem.content,
          },
        ],
        ids: [memoryItem.id],
      });
    } catch {
      // SQLite remains the authority.
    }

    return memoryItem.id;
  }

  async retrieve(query: string, limit = 5, options: RetrieveMemoryOptions = {}): Promise<MemoryItem[]> {
    const queryModality = options.queryModality ?? options.targetModality ?? "text";
    const targetModality = options.targetModality;
    let hits: Array<{ score: number; metadata: Record<string, unknown> }> = [];

    try {
      const queryVector = await this.encodeData(query, queryModality);
      const store = await this.getVectorStoreForModality(targetModality ?? queryModality);
      hits = (
        await store.searchSimilar({
          queryVector,
          limit: Math.max(limit * 5, 20),
          where: {
            memory_type: "perceptual",
            ...(options.userId ? { user_id: options.userId } : {}),
            ...(targetModality ? { modality: targetModality } : {}),
          },
        })
      ).map((hit) => ({ score: hit.score, metadata: hit.metadata }));
    } catch {
      hits = [];
    }

    const now = Math.floor(Date.now() / 1000);
    const results: Array<{ score: number; item: MemoryItem }> = [];
    const seen = new Set<string>();

    for (const hit of hits) {
      const memoryId = typeof hit.metadata.memory_id === "string" ? hit.metadata.memory_id : undefined;
      if (!memoryId || seen.has(memoryId)) {
        continue;
      }
      if (targetModality && hit.metadata.modality !== targetModality) {
        continue;
      }
      const doc = await this.docStore.getMemory(memoryId);
      if (!doc) {
        continue;
      }
      const item = this.docToMemoryItem(doc, hit.score, now);
      results.push({ score: Number(item.metadata.relevance_score ?? 0), item });
      seen.add(memoryId);
    }

    if (results.length === 0) {
      results.push(...this.keywordFallback(query, now, targetModality));
    }

    return results.sort((left, right) => right.score - left.score).slice(0, limit).map((result) => result.item);
  }

  async update(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: MemoryMetadata,
  ): Promise<boolean> {
    const memory = this.perceptualMemories.find((item) => item.id === memoryId);
    if (memory) {
      if (content !== undefined) {
        memory.content = content;
      }
      if (importance !== undefined) {
        memory.importance = importance;
      }
      if (metadata !== undefined) {
        memory.metadata = {
          ...memory.metadata,
          ...metadata,
        };
      }
    }

    const updated = await this.docStore.updateMemory(memoryId, { content, importance, properties: metadata });
    if (content !== undefined || metadata?.raw_data !== undefined) {
      const modality = String(metadata?.modality ?? memory?.metadata.modality ?? "text");
      const rawData = metadata?.raw_data ?? content ?? "";
      try {
        const perception = await this.encodePerception(rawData, modality, memoryId);
        const doc = await this.docStore.getMemory(memoryId);
        const store = await this.getVectorStoreForModality(modality);
        await store.addVectors({
          vectors: [perception.encoding],
          metadata: [
            {
              memory_id: memoryId,
              user_id: doc?.userId ?? "",
              memory_type: "perceptual",
              modality,
              importance: doc?.importance ?? importance ?? 0.5,
              content: content ?? doc?.content ?? "",
            },
          ],
          ids: [memoryId],
        });
      } catch {
        // Best effort.
      }
    }

    return Boolean(memory) || updated;
  }

  async remove(memoryId: string): Promise<boolean> {
    const before = this.perceptualMemories.length;
    const removed = this.perceptualMemories.find((memory) => memory.id === memoryId);
    const perceptionId = typeof removed?.metadata.perception_id === "string" ? removed.metadata.perception_id : undefined;
    if (perceptionId) {
      this.perceptions.delete(perceptionId);
    }
    this.perceptualMemories.splice(
      0,
      this.perceptualMemories.length,
      ...this.perceptualMemories.filter((memory) => memory.id !== memoryId),
    );
    const deleted = await this.docStore.deleteMemory(memoryId);
    const stores = await this.vectorStoresPromise;
    for (const store of stores.values()) {
      try {
        await store.deleteMemories([memoryId]);
      } catch {
        // Best effort.
      }
    }
    return before !== this.perceptualMemories.length || deleted;
  }

  async hasMemory(memoryId: string): Promise<boolean> {
    return this.perceptualMemories.some((memory) => memory.id === memoryId);
  }

  async forget(strategy = "importance_based", threshold = 0.1, maxAgeDays = 30): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const toRemove = this.perceptualMemories.filter((memory) => {
      if (strategy === "importance_based") {
        return memory.importance < threshold;
      }
      if (strategy === "time_based") {
        return memory.timestamp.getTime() < cutoff;
      }
      if (strategy === "capacity_based" && this.perceptualMemories.length > this.config.maxCapacity) {
        const sorted = [...this.perceptualMemories].sort((left, right) => left.importance - right.importance);
        return sorted
          .slice(0, this.perceptualMemories.length - this.config.maxCapacity)
          .some((item) => item.id === memory.id);
      }
      return false;
    });
    let count = 0;
    for (const memory of toRemove) {
      if (await this.remove(memory.id)) {
        count += 1;
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    const docs = await this.docStore.searchMemories({ memoryType: "perceptual", limit: 10000 });
    const ids = docs.map((doc) => doc.memoryId);
    for (const id of ids) {
      await this.docStore.deleteMemory(id);
    }
    const stores = await this.vectorStoresPromise;
    for (const store of stores.values()) {
      try {
        await store.deleteMemories(ids);
      } catch {
        // Best effort.
      }
    }
    this.perceptions.clear();
    this.perceptualMemories.splice(0, this.perceptualMemories.length);
    this.modalityIndex.clear();
  }

  async getAll(): Promise<MemoryItem[]> {
    return [...this.perceptualMemories];
  }

  async getStats(): Promise<MemoryStats> {
    const dbStats = await this.docStore.getDatabaseStats();
    const stores = await this.vectorStoresPromise;
    const vectorStats: Record<string, unknown> = {};
    for (const [modality, store] of stores.entries()) {
      vectorStats[modality] = await store.getCollectionStats();
    }
    const avgImportance =
      this.perceptualMemories.length > 0
        ? this.perceptualMemories.reduce((sum, memory) => sum + memory.importance, 0) / this.perceptualMemories.length
        : 0;
    return {
      count: this.perceptualMemories.length,
      forgottenCount: 0,
      totalCount: this.perceptualMemories.length,
      perceptions_count: this.perceptions.size,
      modalities: Object.fromEntries([...this.modalityIndex.entries()].map(([key, value]) => [key, value.length])),
      avgImportance,
      avg_importance: avgImportance,
      memoryType: "perceptual",
      memory_type: "perceptual",
      vector_stores: vectorStats,
      document_store: filterStoreStats(dbStats),
    };
  }

  async crossModalSearch(query: string, targetModality: string, limit = 5): Promise<MemoryItem[]> {
    return this.retrieve(query, limit, { targetModality, queryModality: "text" });
  }

  getByModality(modality: string, limit = 10): MemoryItem[] {
    return this.perceptualMemories.filter((memory) => memory.metadata.modality === modality).slice(0, limit);
  }

  async generateContent(prompt: string, targetModality: string): Promise<string | undefined> {
    const relevant = await this.retrieve(prompt, 3, { targetModality });
    if (relevant.length === 0) {
      return undefined;
    }
    return relevant.map((memory) => memory.content).join("\n");
  }

  private async createVectorDimensions(): Promise<Map<string, number>> {
    const base = await getDimension(384);
    return new Map([
      ["text", base],
      ["image", base],
      ["audio", base],
      ["video", base],
    ]);
  }

  private async createVectorStores(): Promise<Map<string, QdrantVectorStore>> {
    const dbConfig = getDatabaseConfig().qdrant;
    const dimensions = await this.vectorDimensionsPromise;
    const stores = new Map<string, QdrantVectorStore>();
    for (const modality of ["text", "image", "audio"]) {
      stores.set(
        modality,
        QdrantConnectionManager.getInstance({
          url: dbConfig.url,
          apiKey: dbConfig.apiKey,
          collectionName: `${dbConfig.collectionName}_perceptual_${modality}`,
          vectorSize: dimensions.get(modality) ?? dbConfig.vectorSize,
          distance: dbConfig.distance,
          timeout: dbConfig.timeout,
        }),
      );
    }
    return stores;
  }

  private async encodePerception(data: unknown, modality: string, memoryId: string): Promise<Perception> {
    return new Perception({
      perceptionId: `perception_${memoryId}`,
      data,
      modality,
      encoding: await this.encodeData(data, modality),
      metadata: { source: "memory_system" },
    });
  }

  private async encodeData(data: unknown, modality: string): Promise<number[]> {
    if (modality === "text") {
      const embedder = await getTextEmbedder();
      return (await embedder.encode(String(data))) as number[];
    }

    const dimensions = await this.vectorDimensionsPromise;
    const dimension = dimensions.get(modality) ?? dimensions.get("text") ?? 384;
    const source = await readBinaryLike(data);
    return hashToVector(`${modality}:${source}`, dimension);
  }

  private async getVectorStoreForModality(modality: string): Promise<QdrantVectorStore> {
    const stores = await this.vectorStoresPromise;
    return stores.get(modality) ?? stores.get("text")!;
  }

  private docToMemoryItem(doc: StoredMemory, vectorScore: number, now: number): MemoryItem {
    const ageDays = Math.max(0, (now - doc.timestamp) / 86400);
    const recencyScore = 1 / (1 + ageDays);
    const base = vectorScore * 0.8 + recencyScore * 0.2;
    const combined = base * (0.8 + doc.importance * 0.4);
    return new MemoryItem({
      id: doc.memoryId,
      content: doc.content,
      memoryType: doc.memoryType,
      userId: doc.userId,
      timestamp: new Date(doc.timestamp * 1000),
      importance: doc.importance,
      metadata: {
        ...doc.properties,
        relevance_score: combined,
        vector_score: vectorScore,
        recency_score: recencyScore,
      },
    });
  }

  private keywordFallback(query: string, now: number, targetModality: string | undefined): Array<{ score: number; item: MemoryItem }> {
    const queryLower = query.toLowerCase();
    return this.perceptualMemories
      .filter((memory) => !targetModality || memory.metadata.modality === targetModality)
      .filter((memory) => query.trim().length === 0 || memory.content.toLowerCase().includes(queryLower))
      .map((memory) => {
        const recencyScore = 1 / (1 + Math.max(0, (now - Math.floor(memory.timestamp.getTime() / 1000)) / 86400));
        const score = (0.5 * 0.8 + recencyScore * 0.2) * (0.8 + memory.importance * 0.4);
        return {
          score,
          item: memory.clone({
            metadata: {
              ...memory.metadata,
              relevance_score: score,
            },
          }),
        };
      });
  }
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function filterStoreStats(stats: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(stats).filter(([key]) => key.endsWith("_count") || key === "store_type" || key === "db_path"),
  );
}
