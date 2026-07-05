import { getDatabaseConfig } from "../../core/database-config.js";
import { BaseMemory, MemoryItem, type MemoryMetadata, type MemoryStats, type RetrieveMemoryOptions } from "../base.js";
import type { MemoryConfig } from "../base.js";
import { getDimension, getTextEmbedder } from "../embedding.js";
import { SQLiteDocumentStore, QdrantConnectionManager } from "../storage/index.js";
import type { QdrantVectorStore, StoredMemory } from "../storage/index.js";
import { dirname, tokenize } from "../utils.js";

export interface Episode {
  episodeId: string;
  userId: string;
  sessionId: string;
  timestamp: Date;
  content: string;
  context: Record<string, unknown>;
  outcome?: string;
  importance: number;
  metadata: MemoryMetadata;
}

export class EpisodicMemory extends BaseMemory {
  private readonly episodes: Episode[] = [];
  private readonly sessions = new Map<string, string[]>();
  private readonly patternsCache = new Map<string, Array<Record<string, unknown>>>();
  private lastPatternAnalysis?: Date;
  private readonly docStore: SQLiteDocumentStore;
  private readonly vectorStorePromise: Promise<QdrantVectorStore>;

  constructor(config: MemoryConfig) {
    super(config);
    this.docStore = SQLiteDocumentStore.getInstance(`${dirname(config.storagePath) === "." ? config.storagePath : config.storagePath}/memory.db`);
    this.vectorStorePromise = this.createVectorStore();
  }

  async add(memoryItem: MemoryItem): Promise<string> {
    const sessionId = typeof memoryItem.metadata.session_id === "string" ? memoryItem.metadata.session_id : "default_session";
    const context = normalizeRecord(memoryItem.metadata.context);
    const outcome = typeof memoryItem.metadata.outcome === "string" ? memoryItem.metadata.outcome : undefined;
    const participants = Array.isArray(memoryItem.metadata.participants) ? memoryItem.metadata.participants : [];
    const tags = Array.isArray(memoryItem.metadata.tags) ? memoryItem.metadata.tags : [];

    const episode: Episode = {
      episodeId: memoryItem.id,
      userId: memoryItem.userId,
      sessionId,
      timestamp: memoryItem.timestamp,
      content: memoryItem.content,
      context,
      outcome,
      importance: memoryItem.importance,
      metadata: memoryItem.metadata,
    };
    this.episodes.push(episode);
    this.sessions.set(sessionId, [...(this.sessions.get(sessionId) ?? []), episode.episodeId]);

    const timestamp = Math.floor(memoryItem.timestamp.getTime() / 1000);
    await this.docStore.addMemory({
      memoryId: memoryItem.id,
      userId: memoryItem.userId,
      content: memoryItem.content,
      memoryType: "episodic",
      timestamp,
      importance: memoryItem.importance,
      properties: {
        session_id: sessionId,
        context,
        outcome,
        participants,
        tags,
      },
    });

    try {
      const embedder = await getTextEmbedder();
      const vector = (await embedder.encode(memoryItem.content)) as number[];
      const vectorStore = await this.vectorStorePromise;
      await vectorStore.addVectors({
        vectors: [vector],
        metadata: [
          {
            memory_id: memoryItem.id,
            user_id: memoryItem.userId,
            memory_type: "episodic",
            importance: memoryItem.importance,
            session_id: sessionId,
            content: memoryItem.content,
          },
        ],
        ids: [memoryItem.id],
      });
    } catch {
      // Python treats Qdrant indexing as secondary to SQLite authority here.
    }

    return memoryItem.id;
  }

  async retrieve(query: string, limit = 5, options: RetrieveMemoryOptions = {}): Promise<MemoryItem[]> {
    const candidateIds = await this.getStructuredCandidateIds(options);
    let hits: Array<{ score: number; metadata: Record<string, unknown> }> = [];

    try {
      const embedder = await getTextEmbedder();
      const vector = (await embedder.encode(query)) as number[];
      const vectorStore = await this.vectorStorePromise;
      hits = (
        await vectorStore.searchSimilar({
          queryVector: vector,
          limit: Math.max(limit * 5, 20),
          where: {
            memory_type: "episodic",
            ...(options.userId ? { user_id: options.userId } : {}),
          },
        })
      ).map((hit) => ({
        score: hit.score,
        metadata: hit.metadata,
      }));
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
      if (candidateIds && !candidateIds.has(memoryId)) {
        continue;
      }
      if (options.sessionId && hit.metadata.session_id !== options.sessionId) {
        continue;
      }
      const episode = this.episodes.find((item) => item.episodeId === memoryId);
      if (episode?.context.forgotten === true) {
        continue;
      }
      const doc = await this.docStore.getMemory(memoryId);
      if (!doc) {
        continue;
      }
      const item = this.docToMemoryItem(doc, hit.score, now);
      results.push({
        score: Number(item.metadata.relevance_score ?? 0),
        item,
      });
      seen.add(memoryId);
    }

    if (results.length === 0) {
      results.push(...this.keywordFallback(query, now, options));
    }

    return results.sort((left, right) => right.score - left.score).slice(0, limit).map((result) => result.item);
  }

  async update(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: MemoryMetadata,
  ): Promise<boolean> {
    const episode = this.episodes.find((item) => item.episodeId === memoryId);
    if (episode) {
      if (content !== undefined) {
        episode.content = content;
      }
      if (importance !== undefined) {
        episode.importance = importance;
      }
      if (metadata !== undefined) {
        episode.context = {
          ...episode.context,
          ...normalizeRecord(metadata.context),
        };
        episode.metadata = {
          ...episode.metadata,
          ...metadata,
        };
        if (typeof metadata.outcome === "string") {
          episode.outcome = metadata.outcome;
        }
      }
    }

    const docUpdated = await this.docStore.updateMemory(memoryId, {
      content,
      importance,
      properties: metadata,
    });

    if (content !== undefined) {
      try {
        const embedder = await getTextEmbedder();
        const vector = (await embedder.encode(content)) as number[];
        const doc = await this.docStore.getMemory(memoryId);
        const vectorStore = await this.vectorStorePromise;
        await vectorStore.addVectors({
          vectors: [vector],
          metadata: [
            {
              memory_id: memoryId,
              user_id: doc?.userId ?? "",
              memory_type: "episodic",
              importance: doc?.importance ?? importance ?? 0.5,
              session_id: doc?.properties.session_id,
              content,
            },
          ],
          ids: [memoryId],
        });
      } catch {
        // Keep SQLite update authoritative.
      }
    }

    return Boolean(episode) || docUpdated;
  }

  async remove(memoryId: string): Promise<boolean> {
    const before = this.episodes.length;
    const episode = this.episodes.find((item) => item.episodeId === memoryId);
    if (episode) {
      const sessionEpisodes = this.sessions.get(episode.sessionId) ?? [];
      const remaining = sessionEpisodes.filter((id) => id !== memoryId);
      if (remaining.length > 0) {
        this.sessions.set(episode.sessionId, remaining);
      } else {
        this.sessions.delete(episode.sessionId);
      }
    }
    const remainingEpisodes = this.episodes.filter((item) => item.episodeId !== memoryId);
    this.episodes.splice(0, this.episodes.length, ...remainingEpisodes);
    const deleted = await this.docStore.deleteMemory(memoryId);
    try {
      const vectorStore = await this.vectorStorePromise;
      await vectorStore.deleteMemories([memoryId]);
    } catch {
      // Deleting SQLite is enough for authority.
    }
    return before !== this.episodes.length || deleted;
  }

  async hasMemory(memoryId: string): Promise<boolean> {
    return this.episodes.some((episode) => episode.episodeId === memoryId);
  }

  async clear(): Promise<void> {
    const docs = await this.docStore.searchMemories({ memoryType: "episodic", limit: 10000 });
    const ids = docs.map((doc) => doc.memoryId);
    for (const id of ids) {
      await this.docStore.deleteMemory(id);
    }
    try {
      const vectorStore = await this.vectorStorePromise;
      await vectorStore.deleteMemories(ids);
    } catch {
      // Best effort.
    }
    this.episodes.splice(0, this.episodes.length);
    this.sessions.clear();
    this.patternsCache.clear();
  }

  async forget(strategy = "importance_based", threshold = 0.1, maxAgeDays = 30): Promise<number> {
    const current = [...this.episodes];
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const toRemove = current.filter((episode) => {
      if (strategy === "importance_based") {
        return episode.importance < threshold;
      }
      if (strategy === "time_based") {
        return episode.timestamp.getTime() < cutoff;
      }
      if (strategy === "capacity_based" && current.length > this.config.maxCapacity) {
        const sorted = [...current].sort((left, right) => left.importance - right.importance);
        return sorted.slice(0, current.length - this.config.maxCapacity).some((item) => item.episodeId === episode.episodeId);
      }
      return false;
    });

    let forgotten = 0;
    for (const episode of toRemove) {
      if (await this.remove(episode.episodeId)) {
        forgotten += 1;
      }
    }
    return forgotten;
  }

  async getAll(): Promise<MemoryItem[]> {
    return this.episodes.map(
      (episode) =>
        new MemoryItem({
          id: episode.episodeId,
          content: episode.content,
          memoryType: "episodic",
          userId: episode.userId,
          timestamp: episode.timestamp,
          importance: episode.importance,
          metadata: {
            ...episode.metadata,
            session_id: episode.sessionId,
            context: episode.context,
            outcome: episode.outcome,
          },
        }),
    );
  }

  async getStats(): Promise<MemoryStats> {
    const dbStats = await this.docStore.getDatabaseStats();
    let vectorStats: Record<string, unknown> = { store_type: "qdrant" };
    try {
      const vectorStore = await this.vectorStorePromise;
      vectorStats = await vectorStore.getCollectionStats();
    } catch {
      // Leave best-effort stats.
    }
    const avgImportance =
      this.episodes.length > 0 ? this.episodes.reduce((sum, episode) => sum + episode.importance, 0) / this.episodes.length : 0;
    return {
      count: this.episodes.length,
      forgottenCount: 0,
      totalCount: this.episodes.length,
      sessions_count: this.sessions.size,
      avgImportance,
      avg_importance: avgImportance,
      time_span_days: this.calculateTimeSpanDays(),
      memoryType: "episodic",
      memory_type: "episodic",
      vector_store: vectorStats,
      document_store: filterStoreStats(dbStats),
    };
  }

  getSessionEpisodes(sessionId: string): Episode[] {
    const ids = this.sessions.get(sessionId) ?? [];
    return this.episodes.filter((episode) => ids.includes(episode.episodeId));
  }

  findPatterns(userId?: string, minFrequency = 2): Array<Record<string, unknown>> {
    const cacheKey = `${userId ?? "all"}:${minFrequency}`;
    if (
      this.patternsCache.has(cacheKey) &&
      this.lastPatternAnalysis &&
      Date.now() - this.lastPatternAnalysis.getTime() < 3600000
    ) {
      return this.patternsCache.get(cacheKey) ?? [];
    }

    const episodes = this.episodes.filter((episode) => !userId || episode.userId === userId);
    const counts = new Map<string, number>();
    for (const episode of episodes) {
      for (const token of tokenize(episode.content)) {
        if (token.length > 1) {
          counts.set(token, (counts.get(token) ?? 0) + 1);
        }
      }
      for (const [key, value] of Object.entries(episode.context)) {
        const pattern = `${key}:${String(value)}`;
        counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
      }
    }

    const patterns = [...counts.entries()]
      .filter(([, frequency]) => frequency >= minFrequency)
      .map(([pattern, frequency]) => ({
        type: pattern.includes(":") ? "context" : "keyword",
        pattern,
        frequency,
        confidence: episodes.length > 0 ? frequency / episodes.length : 0,
      }))
      .sort((left, right) => right.frequency - left.frequency);
    this.patternsCache.set(cacheKey, patterns);
    this.lastPatternAnalysis = new Date();
    return patterns;
  }

  getTimeline(userId?: string, limit = 50): Array<Record<string, unknown>> {
    return this.episodes
      .filter((episode) => !userId || episode.userId === userId)
      .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime())
      .slice(0, limit)
      .map((episode) => ({
        episode_id: episode.episodeId,
        timestamp: episode.timestamp.toISOString(),
        content: episode.content.length > 100 ? `${episode.content.slice(0, 100)}...` : episode.content,
        session_id: episode.sessionId,
        importance: episode.importance,
        outcome: episode.outcome,
      }));
  }

  private async createVectorStore(): Promise<QdrantVectorStore> {
    const config = getDatabaseConfig().qdrant;
    return QdrantConnectionManager.getInstance({
      url: config.url,
      apiKey: config.apiKey,
      collectionName: config.collectionName,
      vectorSize: await getDimension(config.vectorSize),
      distance: config.distance,
      timeout: config.timeout,
    });
  }

  private async getStructuredCandidateIds(options: RetrieveMemoryOptions): Promise<Set<string> | undefined> {
    if (!options.timeRange && options.importanceThreshold === undefined) {
      return undefined;
    }
    const docs = await this.docStore.searchMemories({
      userId: options.userId,
      memoryType: "episodic",
      startTime: options.timeRange ? Math.floor(options.timeRange[0].getTime() / 1000) : undefined,
      endTime: options.timeRange ? Math.floor(options.timeRange[1].getTime() / 1000) : undefined,
      importanceThreshold: options.importanceThreshold,
      limit: 1000,
    });
    return new Set(docs.map((doc) => doc.memoryId));
  }

  private docToMemoryItem(doc: StoredMemory, vectorScore: number, now: number): MemoryItem {
    const ageDays = Math.max(0, (now - doc.timestamp) / 86400);
    const recencyScore = 1 / (1 + ageDays);
    const base = vectorScore * 0.8 + recencyScore * 0.2;
    const importanceWeight = 0.8 + doc.importance * 0.4;
    const combined = base * importanceWeight;
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

  private keywordFallback(query: string, now: number, options: RetrieveMemoryOptions): Array<{ score: number; item: MemoryItem }> {
    const queryLower = query.toLowerCase();
    return this.filterEpisodes(options)
      .filter((episode) => query.trim().length === 0 || episode.content.toLowerCase().includes(queryLower))
      .map((episode) => {
        const recencyScore = 1 / (1 + Math.max(0, (now - Math.floor(episode.timestamp.getTime() / 1000)) / 86400));
        const base = 0.5 * 0.8 + recencyScore * 0.2;
        const score = base * (0.8 + episode.importance * 0.4);
        return {
          score,
          item: new MemoryItem({
            id: episode.episodeId,
            content: episode.content,
            memoryType: "episodic",
            userId: episode.userId,
            timestamp: episode.timestamp,
            importance: episode.importance,
            metadata: {
              ...episode.metadata,
              session_id: episode.sessionId,
              context: episode.context,
              outcome: episode.outcome,
              relevance_score: score,
            },
          }),
        };
      });
  }

  private filterEpisodes(options: RetrieveMemoryOptions): Episode[] {
    return this.episodes.filter((episode) => {
      if (options.userId && episode.userId !== options.userId) {
        return false;
      }
      if (options.sessionId && episode.sessionId !== options.sessionId) {
        return false;
      }
      if (options.timeRange && (episode.timestamp < options.timeRange[0] || episode.timestamp > options.timeRange[1])) {
        return false;
      }
      return true;
    });
  }

  private calculateTimeSpanDays(): number {
    if (this.episodes.length === 0) {
      return 0;
    }
    const times = this.episodes.map((episode) => episode.timestamp.getTime());
    return (Math.max(...times) - Math.min(...times)) / 86400000;
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
