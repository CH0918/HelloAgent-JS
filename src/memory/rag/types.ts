import type { HelloAgentsLLM } from "../../core/llm.js";

export type RAGVectorBackend = "memory" | "qdrant";

export interface RAGDocument {
  content: string;
  metadata: Record<string, unknown>;
  docId: string;
}

export interface RAGChunk {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  docId: string;
  chunkIndex: number;
  start: number;
  end: number;
  headingPath?: string;
}

export interface RAGDocumentProcessorOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  minChunkLength?: number;
}

export interface LoadAndChunkOptions extends RAGDocumentProcessorOptions {
  namespace?: string;
  sourceLabel?: string;
}

export interface RAGPipelineOptions {
  backend?: RAGVectorBackend;
  qdrantUrl?: string;
  qdrantApiKey?: string;
  collectionName?: string;
  ragNamespace?: string;
  vectorSize?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  batchSize?: number;
  llm?: HelloAgentsLLM;
}

export interface RAGAddDocumentsOptions extends RAGDocumentProcessorOptions {
  namespace?: string;
  sourceLabel?: string;
}

export interface RAGAddTextOptions extends RAGDocumentProcessorOptions {
  documentId?: string;
  namespace?: string;
  sourceLabel?: string;
  metadata?: Record<string, unknown>;
}

export interface RAGSearchOptions {
  query: string;
  topK?: number;
  scoreThreshold?: number;
  namespace?: string;
  onlyRagData?: boolean;
}

export interface RAGAdvancedSearchOptions extends RAGSearchOptions {
  enableMqe?: boolean;
  mqeExpansions?: number;
  enableHyde?: boolean;
  candidatePoolMultiplier?: number;
}

export interface RAGSearchResult {
  memoryId: string;
  score: number;
  vectorScore: number;
  graphScore: number;
  content: string;
  metadata: Record<string, unknown>;
}

export interface RAGPipelineStats {
  store_type: RAGVectorBackend;
  namespace: string;
  collection_name?: string;
  chunks_count?: number;
  points_count?: unknown;
  vectors_count?: unknown;
  indexed_vectors_count?: unknown;
  config?: Record<string, unknown>;
}
