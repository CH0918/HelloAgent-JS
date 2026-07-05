import { HelloAgentsLLM } from "../../core/llm.js";
import { getDimension, getTextEmbedder } from "../embedding.js";
import { QdrantConnectionManager } from "../storage/index.js";
import type { QdrantSearchHit, QdrantVectorStore } from "../storage/index.js";
import { cosineSimilarity, currentEnv, hashToVector, readInteger } from "../utils.js";
import { createDocument, DocumentProcessor, loadAndChunkTexts, preprocessMarkdownForEmbedding } from "./document.js";
import { computeGraphSignalsFromHits, rankVectorHits } from "./ranking.js";
import type {
  RAGAddDocumentsOptions,
  RAGAddTextOptions,
  RAGAdvancedSearchOptions,
  RAGChunk,
  RAGPipelineOptions,
  RAGPipelineStats,
  RAGSearchOptions,
  RAGSearchResult,
  RAGVectorBackend,
} from "./types.js";

interface LocalVectorRecord {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

export class RAGPipeline {
  readonly backend: RAGVectorBackend;
  readonly collectionName: string;
  readonly ragNamespace: string;
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  readonly batchSize: number;

  private readonly options: RAGPipelineOptions;
  private readonly localRecords = new Map<string, LocalVectorRecord>();
  private vectorStorePromise?: Promise<QdrantVectorStore>;
  private llm?: HelloAgentsLLM;

  constructor(options: RAGPipelineOptions = {}) {
    const env = currentEnv();
    this.options = options;
    this.backend = normalizeBackend(options.backend ?? env.RAG_BACKEND);
    this.collectionName = options.collectionName ?? env.RAG_COLLECTION ?? "hello_agents_rag_vectors";
    this.ragNamespace = options.ragNamespace ?? "default";
    this.chunkSize = options.chunkSize ?? readInteger(env.RAG_CHUNK_SIZE, 800);
    this.chunkOverlap = options.chunkOverlap ?? readInteger(env.RAG_CHUNK_OVERLAP, 100);
    this.batchSize = options.batchSize ?? readInteger(env.RAG_BATCH_SIZE, 64);
    this.llm = options.llm;
  }

  async addDocuments(filePaths: string[], options: RAGAddDocumentsOptions = {}): Promise<number> {
    const chunks = await loadAndChunkTexts(filePaths, {
      chunkSize: options.chunkSize ?? this.chunkSize,
      chunkOverlap: options.chunkOverlap ?? this.chunkOverlap,
      namespace: options.namespace ?? this.ragNamespace,
      sourceLabel: options.sourceLabel ?? "rag",
    });
    return this.indexChunks(chunks, options.namespace ?? this.ragNamespace);
  }

  async addText(text: string, options: RAGAddTextOptions = {}): Promise<number> {
    const content = text.trim();
    if (!content) {
      return 0;
    }

    const namespace = options.namespace ?? this.ragNamespace;
    const documentId = options.documentId ?? `text_${hashContent(content)}`;
    const document = createDocument(
      content,
      {
        source: options.sourceLabel ?? "rag_text",
        source_path: documentId,
        external: true,
        namespace,
        format: "text",
        ...(options.metadata ?? {}),
      },
      documentId,
    );
    const processor = new DocumentProcessor({
      chunkSize: options.chunkSize ?? this.chunkSize,
      chunkOverlap: options.chunkOverlap ?? this.chunkOverlap,
    });
    const chunks = processor.processDocument(document);
    return this.indexChunks(chunks, namespace);
  }

  async search(options: RAGSearchOptions): Promise<RAGSearchResult[]> {
    if (!options.query.trim()) {
      return [];
    }

    const topK = options.topK ?? 8;
    const queryVector = await this.embedQuery(options.query);
    const hits = await this.searchRaw(queryVector, {
      ...options,
      topK: Math.max(topK * 2, topK),
    });
    const graphSignals = computeGraphSignalsFromHits(hits);
    return rankVectorHits(hits, graphSignals).slice(0, topK);
  }

  async searchAdvanced(options: RAGAdvancedSearchOptions): Promise<RAGSearchResult[]> {
    if (!options.query.trim()) {
      return [];
    }

    const topK = options.topK ?? 8;
    const expansions = await this.expandQuery(options);
    const pool = Math.max(topK * (options.candidatePoolMultiplier ?? 4), 20);
    const perQuery = Math.max(1, Math.floor(pool / Math.max(1, expansions.length)));
    const aggregated = new Map<string, QdrantSearchHit>();

    for (const query of expansions) {
      const queryVector = await this.embedQuery(query);
      const hits = await this.searchRaw(queryVector, {
        ...options,
        query,
        topK: perQuery,
      });

      for (const hit of hits) {
        const memoryId = getMemoryId(hit);
        const existing = aggregated.get(memoryId);
        if (!existing || hit.score > existing.score) {
          aggregated.set(memoryId, hit);
        }
      }
    }

    const hits = [...aggregated.values()].sort((left, right) => right.score - left.score);
    const graphSignals = computeGraphSignalsFromHits(hits);
    return rankVectorHits(hits, graphSignals).slice(0, topK);
  }

  async getRelevantContext(
    query: string,
    options: {
      limit?: number;
      maxChars?: number;
      namespace?: string;
    } = {},
  ): Promise<string> {
    const results = await this.search({
      query,
      topK: options.limit ?? 3,
      namespace: options.namespace,
    });
    const maxChars = options.maxChars ?? 1200;
    const merged = results.map((item) => item.content).join("\n\n");
    return merged.length > maxChars ? `${merged.slice(0, Math.max(0, maxChars - 3))}...` : merged;
  }

  async clearNamespace(namespace = this.ragNamespace): Promise<boolean> {
    if (this.backend === "memory") {
      for (const [id, record] of this.localRecords.entries()) {
        if (record.metadata.rag_namespace === namespace) {
          this.localRecords.delete(id);
        }
      }
      return true;
    }

    const store = await this.getVectorStore();
    await store.deleteByFilter(this.buildWhere(namespace, true));
    return true;
  }

  async getStats(): Promise<RAGPipelineStats> {
    if (this.backend === "memory") {
      const namespaceCount = [...this.localRecords.values()].filter(
        (record) => record.metadata.rag_namespace === this.ragNamespace,
      ).length;
      return {
        store_type: "memory",
        namespace: this.ragNamespace,
        chunks_count: namespaceCount,
        config: {
          chunk_size: this.chunkSize,
          chunk_overlap: this.chunkOverlap,
        },
      };
    }

    const store = await this.getVectorStore();
    const stats = await store.getCollectionStats();
    return {
      store_type: "qdrant",
      namespace: this.ragNamespace,
      collection_name: this.collectionName,
      points_count: stats.points_count,
      vectors_count: stats.vectors_count,
      indexed_vectors_count: stats.indexed_vectors_count,
      config: typeof stats.config === "object" && stats.config !== null ? (stats.config as Record<string, unknown>) : {},
    };
  }

  private async indexChunks(chunks: RAGChunk[], namespace: string): Promise<number> {
    if (chunks.length === 0) {
      return 0;
    }

    const texts = chunks.map((chunk) => preprocessMarkdownForEmbedding(chunk.content));
    const vectors = await this.embedTexts(texts);
    const metadata = chunks.map((chunk) => this.buildChunkMetadata(chunk, namespace));

    if (this.backend === "memory") {
      let indexed = 0;
      for (const [index, chunk] of chunks.entries()) {
        const vector = vectors[index];
        if (!vector || vector.length === 0) {
          continue;
        }
        this.localRecords.set(chunk.id, {
          id: chunk.id,
          vector,
          metadata: metadata[index] ?? {},
        });
        indexed += 1;
      }
      return indexed;
    }

    const store = await this.getVectorStore();
    const validVectors: number[][] = [];
    const validMetadata: Record<string, unknown>[] = [];
    const validIds: string[] = [];

    for (const [index, chunk] of chunks.entries()) {
      const vector = vectors[index];
      if (!vector || vector.length !== store.vectorSize) {
        continue;
      }
      validVectors.push(vector);
      validMetadata.push(metadata[index] ?? {});
      validIds.push(chunk.id);
    }

    if (validVectors.length === 0) {
      return 0;
    }

    await store.addVectors({
      vectors: validVectors,
      metadata: validMetadata,
      ids: validIds,
    });
    return validVectors.length;
  }

  private buildChunkMetadata(chunk: RAGChunk, namespace: string): Record<string, unknown> {
    return {
      ...chunk.metadata,
      memory_id: chunk.id,
      user_id: "rag_user",
      memory_type: "rag_chunk",
      content: chunk.content,
      data_source: "rag_pipeline",
      rag_namespace: namespace,
      is_rag_data: true,
      doc_id: chunk.docId,
      chunk_index: chunk.chunkIndex,
      start: chunk.start,
      end: chunk.end,
      heading_path: chunk.headingPath,
    };
  }

  private async searchRaw(queryVector: number[], options: RAGSearchOptions): Promise<QdrantSearchHit[]> {
    const namespace = options.namespace ?? this.ragNamespace;
    const where = this.buildWhere(namespace, options.onlyRagData ?? true);
    const limit = options.topK ?? 8;

    if (this.backend === "memory") {
      return [...this.localRecords.values()]
        .filter((record) => matchesWhere(record.metadata, where))
        .map((record) => ({
          id: record.id,
          score: cosineSimilarity(queryVector, record.vector),
          metadata: record.metadata,
        }))
        .filter((hit) => options.scoreThreshold === undefined || hit.score >= options.scoreThreshold)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    }

    const store = await this.getVectorStore();
    return store.searchSimilar({
      queryVector,
      limit,
      scoreThreshold: options.scoreThreshold,
      where,
    });
  }

  private buildWhere(namespace: string, onlyRagData: boolean): Record<string, unknown> {
    return {
      memory_type: "rag_chunk",
      rag_namespace: namespace,
      ...(onlyRagData
        ? {
            is_rag_data: true,
            data_source: "rag_pipeline",
          }
        : {}),
    };
  }

  private async expandQuery(options: RAGAdvancedSearchOptions): Promise<string[]> {
    const expansions = [options.query];

    if (options.enableMqe) {
      expansions.push(...(await this.promptMqe(options.query, options.mqeExpansions ?? 2)));
    }
    if (options.enableHyde) {
      const hyde = await this.promptHyde(options.query);
      if (hyde) {
        expansions.push(hyde);
      }
    }

    const seen = new Set<string>();
    return expansions
      .map((item) => item.trim())
      .filter((item) => {
        if (!item || seen.has(item)) {
          return false;
        }
        seen.add(item);
        return true;
      });
  }

  private async promptMqe(query: string, count: number): Promise<string[]> {
    const llm = this.getOptionalLLM();
    if (!llm) {
      return [];
    }

    try {
      const text = await llm.invoke([
        {
          role: "system",
          content: "你是检索查询扩展助手。生成语义等价或互补的多样化查询。使用中文，简短，避免标点。",
        },
        {
          role: "user",
          content: `原始查询：${query}\n请给出${Math.max(1, count)}个不同表述的查询，每行一个。`,
        },
      ]);
      return text
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^[-*]\s*/, ""))
        .filter(Boolean)
        .slice(0, count);
    } catch {
      return [];
    }
  }

  private async promptHyde(query: string): Promise<string | undefined> {
    const llm = this.getOptionalLLM();
    if (!llm) {
      return undefined;
    }

    try {
      const text = await llm.invoke([
        {
          role: "system",
          content: "根据用户问题，先写一段可能的答案性段落，用于向量检索的查询文档。不要解释过程。",
        },
        {
          role: "user",
          content: `问题：${query}\n请直接写一段中等长度、客观、包含关键术语的段落。`,
        },
      ]);
      return text.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private getOptionalLLM(): HelloAgentsLLM | undefined {
    if (this.llm) {
      return this.llm;
    }

    try {
      this.llm = new HelloAgentsLLM();
      return this.llm;
    } catch {
      return undefined;
    }
  }

  private async embedTexts(texts: string[]): Promise<number[][]> {
    const embedder = await getTextEmbedder();
    const vectors: number[][] = [];

    for (let index = 0; index < texts.length; index += this.batchSize) {
      const batch = texts.slice(index, index + this.batchSize);
      try {
        const encoded = await embedder.encode(batch);
        vectors.push(...normalizeVectorList(encoded, batch, embedder.dimension));
      } catch {
        vectors.push(...batch.map((text) => hashToVector(text, embedder.dimension || 384)));
      }
    }

    return vectors;
  }

  private async embedQuery(query: string): Promise<number[]> {
    const embedder = await getTextEmbedder();
    try {
      const encoded = await embedder.encode(query);
      return normalizeSingleVector(encoded, query, embedder.dimension);
    } catch {
      return hashToVector(query, embedder.dimension || 384);
    }
  }

  private async getVectorStore(): Promise<QdrantVectorStore> {
    this.vectorStorePromise ??= this.createVectorStore();
    return this.vectorStorePromise;
  }

  private async createVectorStore(): Promise<QdrantVectorStore> {
    const vectorSize = this.options.vectorSize ?? (await getDimension(384));
    return QdrantConnectionManager.getInstance({
      url: this.options.qdrantUrl,
      apiKey: this.options.qdrantApiKey,
      collectionName: this.collectionName,
      vectorSize,
      distance: "cosine",
    });
  }
}

export function createRAGPipeline(options: RAGPipelineOptions = {}): RAGPipeline {
  return new RAGPipeline(options);
}

function normalizeVectorList(encoded: number[] | number[][], sourceTexts: string[], dimension: number): number[][] {
  if (isNumberArray(encoded)) {
    return [encoded];
  }

  const result = encoded.map((item, index) => normalizeSingleVector(item, sourceTexts[index] ?? "", dimension));
  while (result.length < sourceTexts.length) {
    result.push(hashToVector(sourceTexts[result.length] ?? "", dimension || 384));
  }
  return result.slice(0, sourceTexts.length);
}

function normalizeSingleVector(encoded: number[] | number[][], fallbackText: string, dimension: number): number[] {
  const candidate = Array.isArray(encoded) && Array.isArray(encoded[0]) ? encoded[0] : encoded;
  if (isNumberArray(candidate)) {
    return candidate.map((value) => Number(value) || 0);
  }
  return hashToVector(fallbackText, dimension || 384);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function matchesWhere(metadata: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => metadata[key] === value);
}

function getMemoryId(hit: QdrantSearchHit): string {
  return typeof hit.metadata.memory_id === "string" ? hit.metadata.memory_id : String(hit.id);
}

function hashContent(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeBackend(value: string | undefined): RAGVectorBackend {
  return value?.toLowerCase() === "qdrant" ? "qdrant" : "memory";
}
