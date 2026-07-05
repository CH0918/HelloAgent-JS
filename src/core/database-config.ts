import { currentEnv, readInteger } from "../memory/utils.js";

export interface QdrantConfig {
  url?: string;
  apiKey?: string;
  collectionName: string;
  vectorSize: number;
  distance: "cosine" | "dot" | "euclidean";
  timeout: number;
}

export interface Neo4jConfig {
  uri: string;
  username: string;
  password: string;
  database: string;
  maxConnectionLifetime: number;
  maxConnectionPoolSize: number;
  connectionAcquisitionTimeout: number;
}

export interface DatabaseConfig {
  qdrant: QdrantConfig;
  neo4j: Neo4jConfig;
}

export function loadDatabaseConfig(env = currentEnv()): DatabaseConfig {
  return {
    qdrant: {
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY,
      collectionName: env.QDRANT_COLLECTION ?? "hello_agents_vectors",
      vectorSize: readInteger(
        env.QDRANT_VECTOR_SIZE,
        readInteger(env.EMBED_DIMENSION, defaultEmbeddingDimension(env.EMBED_MODEL_TYPE)),
      ),
      distance: normalizeQdrantDistance(env.QDRANT_DISTANCE),
      timeout: readInteger(env.QDRANT_TIMEOUT, 30),
    },
    neo4j: {
      uri: env.NEO4J_URI ?? "bolt://localhost:7687",
      username: env.NEO4J_USERNAME ?? env.NEO4J_USER ?? "neo4j",
      password: env.NEO4J_PASSWORD ?? "hello-agents-password",
      database: env.NEO4J_DATABASE ?? "neo4j",
      maxConnectionLifetime: readInteger(env.NEO4J_MAX_CONNECTION_LIFETIME, 3600),
      maxConnectionPoolSize: readInteger(env.NEO4J_MAX_CONNECTION_POOL_SIZE, 50),
      connectionAcquisitionTimeout: readInteger(env.NEO4J_CONNECTION_TIMEOUT, 60),
    },
  };
}

function normalizeQdrantDistance(value: string | undefined): QdrantConfig["distance"] {
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

let databaseConfig = loadDatabaseConfig();

export function getDatabaseConfig(): DatabaseConfig {
  return databaseConfig;
}

export function updateDatabaseConfig(next: Partial<DatabaseConfig>): void {
  databaseConfig = {
    qdrant: {
      ...databaseConfig.qdrant,
      ...next.qdrant,
    },
    neo4j: {
      ...databaseConfig.neo4j,
      ...next.neo4j,
    },
  };
}
