import { getDatabaseConfig } from "../../core/database-config.js";
import { BaseMemory, MemoryItem, type MemoryMetadata, type MemoryStats, type RetrieveMemoryOptions } from "../base.js";
import type { MemoryConfig } from "../base.js";
import { getDimension, getTextEmbedder } from "../embedding.js";
import { Neo4jGraphStore, QdrantConnectionManager } from "../storage/index.js";
import type { QdrantVectorStore } from "../storage/index.js";
import { hashString, tokenize } from "../utils.js";

export class Entity {
  readonly entityId: string;
  readonly name: string;
  readonly entityType: string;
  readonly description: string;
  readonly properties: Record<string, unknown>;
  readonly createdAt: Date;
  updatedAt: Date;
  frequency: number;

  constructor(input: {
    entityId: string;
    name: string;
    entityType?: string;
    description?: string;
    properties?: Record<string, unknown>;
  }) {
    this.entityId = input.entityId;
    this.name = input.name;
    this.entityType = input.entityType ?? "MISC";
    this.description = input.description ?? "";
    this.properties = input.properties ?? {};
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.frequency = 1;
  }

  toDict(): Record<string, unknown> {
    return {
      entity_id: this.entityId,
      name: this.name,
      entity_type: this.entityType,
      description: this.description,
      properties: this.properties,
      frequency: this.frequency,
    };
  }
}

export class Relation {
  readonly fromEntity: string;
  readonly toEntity: string;
  readonly relationType: string;
  readonly strength: number;
  readonly evidence: string;
  readonly properties: Record<string, unknown>;
  readonly createdAt: Date;
  frequency: number;

  constructor(input: {
    fromEntity: string;
    toEntity: string;
    relationType?: string;
    strength?: number;
    evidence?: string;
    properties?: Record<string, unknown>;
  }) {
    this.fromEntity = input.fromEntity;
    this.toEntity = input.toEntity;
    this.relationType = input.relationType ?? "CO_OCCURS";
    this.strength = input.strength ?? 1;
    this.evidence = input.evidence ?? "";
    this.properties = input.properties ?? {};
    this.createdAt = new Date();
    this.frequency = 1;
  }

  toDict(): Record<string, unknown> {
    return {
      from_entity: this.fromEntity,
      to_entity: this.toEntity,
      relation_type: this.relationType,
      strength: this.strength,
      evidence: this.evidence,
      properties: this.properties,
      frequency: this.frequency,
    };
  }
}

export class SemanticMemory extends BaseMemory {
  private readonly vectorStorePromise: Promise<QdrantVectorStore>;
  private readonly graphStore: Neo4jGraphStore;
  private readonly semanticMemories: MemoryItem[] = [];
  private readonly memoryEmbeddings = new Map<string, number[]>();
  private readonly entities = new Map<string, Entity>();
  private readonly relations: Relation[] = [];

  constructor(config: MemoryConfig) {
    super(config);
    const dbConfig = getDatabaseConfig();
    this.graphStore = new Neo4jGraphStore({
      uri: dbConfig.neo4j.uri,
      username: dbConfig.neo4j.username,
      password: dbConfig.neo4j.password,
      database: dbConfig.neo4j.database,
      maxConnectionLifetime: dbConfig.neo4j.maxConnectionLifetime,
      maxConnectionPoolSize: dbConfig.neo4j.maxConnectionPoolSize,
      connectionAcquisitionTimeout: dbConfig.neo4j.connectionAcquisitionTimeout,
    });
    this.vectorStorePromise = this.createVectorStore();
  }

  async add(memoryItem: MemoryItem): Promise<string> {
    const embedder = await getTextEmbedder();
    const embedding = (await embedder.encode(memoryItem.content)) as number[];
    this.memoryEmbeddings.set(memoryItem.id, embedding);

    const entities = this.extractEntities(memoryItem.content);
    const relations = this.extractRelations(memoryItem.content, entities);

    for (const entity of entities) {
      await this.addEntityToGraph(entity, memoryItem);
    }
    for (const relation of relations) {
      await this.addRelationToGraph(relation, memoryItem);
    }

    const vectorStore = await this.vectorStorePromise;
    await vectorStore.addVectors({
      vectors: [embedding],
      metadata: [
        {
          memory_id: memoryItem.id,
          user_id: memoryItem.userId,
          content: memoryItem.content,
          memory_type: "semantic",
          timestamp: Math.floor(memoryItem.timestamp.getTime() / 1000),
          importance: memoryItem.importance,
          entities: entities.map((entity) => entity.entityId),
          entity_count: entities.length,
          relation_count: relations.length,
        },
      ],
      ids: [memoryItem.id],
    });

    memoryItem.metadata.entities = entities.map((entity) => entity.entityId);
    memoryItem.metadata.relations = relations.map(
      (relation) => `${relation.fromEntity}-${relation.relationType}-${relation.toEntity}`,
    );
    this.semanticMemories.push(memoryItem);
    return memoryItem.id;
  }

  async retrieve(query: string, limit = 5, options: RetrieveMemoryOptions = {}): Promise<MemoryItem[]> {
    try {
      const vectorResults = await this.vectorSearch(query, limit * 2, options.userId);
      const graphResults = await this.graphSearch(query, limit * 2, options.userId);
      const combined = this.combineAndRankResults(vectorResults, graphResults, limit);
      const probabilities = softmax(combined.map((item) => Number(item.combined_score ?? item.vector_score ?? 0)));

      return combined.slice(0, limit).map((result, index) => {
        const timestamp = normalizeTimestamp(result.timestamp);
        return new MemoryItem({
          id: String(result.memory_id),
          content: String(result.content ?? ""),
          memoryType: "semantic",
          userId: String(result.user_id ?? "default"),
          timestamp,
          importance: Number(result.importance ?? 0.5),
          metadata: {
            ...normalizeRecord(result.metadata),
            combined_score: Number(result.combined_score ?? 0),
            vector_score: Number(result.vector_score ?? 0),
            graph_score: Number(result.graph_score ?? 0),
            probability: probabilities[index] ?? 0,
          },
        });
      });
    } catch {
      return [];
    }
  }

  async update(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: MemoryMetadata,
  ): Promise<boolean> {
    const memory = this.findMemoryById(memoryId);
    if (!memory) {
      return false;
    }

    if (content !== undefined) {
      const embedder = await getTextEmbedder();
      const embedding = (await embedder.encode(content)) as number[];
      this.memoryEmbeddings.set(memoryId, embedding);
      memory.content = content;

      const entities = this.extractEntities(content);
      const relations = this.extractRelations(content, entities);
      memory.metadata.entities = entities.map((entity) => entity.entityId);
      memory.metadata.relations = relations.map(
        (relation) => `${relation.fromEntity}-${relation.relationType}-${relation.toEntity}`,
      );

      for (const entity of entities) {
        this.addOrUpdateEntity(entity);
      }
      for (const relation of relations) {
        this.addOrUpdateRelation(relation);
      }

      const vectorStore = await this.vectorStorePromise;
      await vectorStore.addVectors({
        vectors: [embedding],
        metadata: [
          {
            memory_id: memory.id,
            user_id: memory.userId,
            content: memory.content,
            memory_type: "semantic",
            timestamp: Math.floor(memory.timestamp.getTime() / 1000),
            importance: memory.importance,
            entities: memory.metadata.entities,
          },
        ],
        ids: [memory.id],
      });
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
    return true;
  }

  async remove(memoryId: string): Promise<boolean> {
    const before = this.semanticMemories.length;
    const index = this.semanticMemories.findIndex((memory) => memory.id === memoryId);
    if (index >= 0) {
      this.semanticMemories.splice(index, 1);
    }
    this.memoryEmbeddings.delete(memoryId);
    try {
      const vectorStore = await this.vectorStorePromise;
      await vectorStore.deleteMemories([memoryId]);
    } catch {
      // Best effort.
    }
    return before !== this.semanticMemories.length;
  }

  async hasMemory(memoryId: string): Promise<boolean> {
    return this.semanticMemories.some((memory) => memory.id === memoryId);
  }

  async forget(strategy = "importance_based", threshold = 0.1, maxAgeDays = 30): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const toRemove = this.semanticMemories.filter((memory) => {
      if (strategy === "importance_based") {
        return memory.importance < threshold;
      }
      if (strategy === "time_based") {
        return memory.timestamp.getTime() < cutoff;
      }
      if (strategy === "capacity_based" && this.semanticMemories.length > this.config.maxCapacity) {
        const sorted = [...this.semanticMemories].sort((left, right) => left.importance - right.importance);
        return sorted
          .slice(0, this.semanticMemories.length - this.config.maxCapacity)
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
    const ids = this.semanticMemories.map((memory) => memory.id);
    this.semanticMemories.splice(0, this.semanticMemories.length);
    this.memoryEmbeddings.clear();
    this.entities.clear();
    this.relations.splice(0, this.relations.length);
    try {
      const vectorStore = await this.vectorStorePromise;
      await vectorStore.deleteMemories(ids);
    } catch {
      // Best effort.
    }
  }

  async getAll(): Promise<MemoryItem[]> {
    return [...this.semanticMemories];
  }

  async getStats(): Promise<MemoryStats> {
    let vectorStats: Record<string, unknown> = { store_type: "qdrant" };
    let graphStats: Record<string, unknown> = { store_type: "neo4j" };
    try {
      const vectorStore = await this.vectorStorePromise;
      vectorStats = await vectorStore.getCollectionStats();
    } catch {
      // Best effort.
    }
    try {
      graphStats = await this.graphStore.getStats();
    } catch {
      // Best effort.
    }
    const avgImportance =
      this.semanticMemories.length > 0
        ? this.semanticMemories.reduce((sum, memory) => sum + memory.importance, 0) / this.semanticMemories.length
        : 0;
    return {
      count: this.semanticMemories.length,
      forgottenCount: 0,
      totalCount: this.semanticMemories.length,
      avgImportance,
      avg_importance: avgImportance,
      entities_count: this.entities.size,
      relations_count: this.relations.length,
      memoryType: "semantic",
      memory_type: "semantic",
      vector_store: vectorStats,
      graph_store: graphStats,
    };
  }

  getEntity(entityId: string): Entity | undefined {
    return this.entities.get(entityId);
  }

  searchEntities(query: string, limit = 10): Entity[] {
    const queryLower = query.toLowerCase();
    return [...this.entities.values()]
      .filter((entity) => entity.name.toLowerCase().includes(queryLower))
      .sort((left, right) => right.frequency - left.frequency)
      .slice(0, limit);
  }

  async getRelatedEntities(entityId: string, maxHops = 2, limit = 20): Promise<Array<Record<string, unknown>>> {
    try {
      return await this.graphStore.findRelatedEntities(entityId, { maxDepth: maxHops, limit });
    } catch {
      return [];
    }
  }

  exportKnowledgeGraph(): Record<string, unknown> {
    return {
      entities: [...this.entities.values()].map((entity) => entity.toDict()),
      relations: this.relations.map((relation) => relation.toDict()),
    };
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

  private async vectorSearch(query: string, limit: number, userId?: string): Promise<Array<Record<string, unknown>>> {
    try {
      const embedder = await getTextEmbedder();
      const queryEmbedding = (await embedder.encode(query)) as number[];
      const vectorStore = await this.vectorStorePromise;
      const hits = await vectorStore.searchSimilar({
        queryVector: queryEmbedding,
        limit,
        where: {
          memory_type: "semantic",
          ...(userId ? { user_id: userId } : {}),
        },
      });
      return hits.map((hit) => ({
        id: hit.id,
        score: hit.score,
        ...hit.metadata,
      }));
    } catch {
      return [];
    }
  }

  private async graphSearch(query: string, limit: number, userId?: string): Promise<Array<Record<string, unknown>>> {
    try {
      let queryEntities = this.extractEntities(query);
      if (queryEntities.length === 0) {
        const entitiesByName = await this.graphStore.searchEntitiesByName(query, { limit: 10 });
        queryEntities = entitiesByName.slice(0, 3).map(
          (entity) =>
            new Entity({
              entityId: String(entity.id ?? entity.entity_id ?? ""),
              name: String(entity.name ?? ""),
              entityType: String(entity.type ?? entity.entity_type ?? "MISC"),
            }),
        );
      }
      if (queryEntities.length === 0) {
        return [];
      }

      const relatedMemoryIds = new Set<string>();
      for (const entity of queryEntities) {
        const relatedEntities = await this.graphStore.findRelatedEntities(entity.entityId, { maxDepth: 2, limit: 20 });
        for (const related of relatedEntities) {
          if (typeof related.memory_id === "string") {
            relatedMemoryIds.add(related.memory_id);
          }
        }
        const relationships = await this.graphStore.getEntityRelationships(entity.entityId);
        for (const relationship of relationships) {
          const rel = normalizeRecord(relationship.relationship);
          if (typeof rel.memory_id === "string") {
            relatedMemoryIds.add(rel.memory_id);
          }
        }
      }

      const results: Array<Record<string, unknown>> = [];
      for (const memoryId of [...relatedMemoryIds].slice(0, limit * 2)) {
        const memory = this.findMemoryById(memoryId);
        if (!memory || (userId && memory.userId !== userId)) {
          continue;
        }
        const metadata = {
          content: memory.content,
          user_id: memory.userId,
          memory_type: memory.memoryType,
          importance: memory.importance,
          timestamp: Math.floor(memory.timestamp.getTime() / 1000),
          entities: memory.metadata.entities,
        };
        results.push({
          id: memoryId,
          memory_id: memoryId,
          content: memory.content,
          similarity: this.calculateGraphRelevance(metadata, queryEntities),
          user_id: memory.userId,
          memory_type: memory.memoryType,
          importance: memory.importance,
          timestamp: metadata.timestamp,
          entities: memory.metadata.entities,
        });
      }
      return results.sort((left, right) => Number(right.similarity ?? 0) - Number(left.similarity ?? 0)).slice(0, limit);
    } catch {
      return [];
    }
  }

  private combineAndRankResults(
    vectorResults: Array<Record<string, unknown>>,
    graphResults: Array<Record<string, unknown>>,
    limit: number,
  ): Array<Record<string, unknown>> {
    const combined = new Map<string, Record<string, unknown>>();
    const contentSeen = new Set<number>();

    for (const result of vectorResults) {
      const memoryId = String(result.memory_id ?? "");
      const content = String(result.content ?? "");
      const contentHash = hashString(content.trim());
      if (!memoryId || contentSeen.has(contentHash)) {
        continue;
      }
      contentSeen.add(contentHash);
      combined.set(memoryId, {
        ...result,
        vector_score: Number(result.score ?? 0),
        graph_score: 0,
        content_hash: contentHash,
      });
    }

    for (const result of graphResults) {
      const memoryId = String(result.memory_id ?? "");
      const content = String(result.content ?? "");
      const contentHash = hashString(content.trim());
      if (!memoryId) {
        continue;
      }
      if (combined.has(memoryId)) {
        combined.get(memoryId)!.graph_score = Number(result.similarity ?? 0);
      } else if (!contentSeen.has(contentHash)) {
        contentSeen.add(contentHash);
        combined.set(memoryId, {
          ...result,
          vector_score: 0,
          graph_score: Number(result.similarity ?? 0),
          content_hash: contentHash,
        });
      }
    }

    const ranked = [...combined.values()].map((result) => {
      const vectorScore = Number(result.vector_score ?? 0);
      const graphScore = Number(result.graph_score ?? 0);
      const importance = Number(result.importance ?? 0.5);
      const baseRelevance = vectorScore * 0.7 + graphScore * 0.3;
      const importanceWeight = 0.8 + importance * 0.4;
      return {
        ...result,
        combined_score: baseRelevance * importanceWeight,
      };
    });

    return ranked
      .filter((result) => Number(result.combined_score ?? 0) >= 0.1)
      .sort((left, right) => Number(right.combined_score ?? 0) - Number(left.combined_score ?? 0))
      .slice(0, limit);
  }

  private extractEntities(text: string): Entity[] {
    const rawTokens = tokenize(text);
    const candidates = new Set<string>();
    for (const token of rawTokens) {
      if (/[\u3400-\u9fff]/.test(token) || token.length > 2) {
        candidates.add(token);
      }
    }
    return [...candidates].slice(0, 20).map(
      (name) =>
        new Entity({
          entityId: `entity_${hashString(name)}`,
          name,
          entityType: detectEntityType(name),
          description: `从文本中识别的实体: ${name}`,
        }),
    );
  }

  private extractRelations(text: string, entities: Entity[]): Relation[] {
    const relations: Relation[] = [];
    for (let index = 0; index < entities.length; index += 1) {
      for (let next = index + 1; next < entities.length; next += 1) {
        relations.push(
          new Relation({
            fromEntity: entities[index]!.entityId,
            toEntity: entities[next]!.entityId,
            relationType: "CO_OCCURS",
            strength: 0.5,
            evidence: text.slice(0, 100),
          }),
        );
      }
    }
    return relations;
  }

  private async addEntityToGraph(entity: Entity, memoryItem: MemoryItem): Promise<boolean> {
    this.addOrUpdateEntity(entity);
    try {
      return await this.graphStore.addEntity(entity.entityId, entity.name, entity.entityType, {
        name: entity.name,
        description: entity.description,
        frequency: entity.frequency,
        memory_id: memoryItem.id,
        user_id: memoryItem.userId,
        importance: memoryItem.importance,
        ...entity.properties,
      });
    } catch {
      return false;
    }
  }

  private async addRelationToGraph(relation: Relation, memoryItem: MemoryItem): Promise<boolean> {
    this.addOrUpdateRelation(relation);
    try {
      return await this.graphStore.addRelationship(relation.fromEntity, relation.toEntity, relation.relationType, {
        strength: relation.strength,
        memory_id: memoryItem.id,
        user_id: memoryItem.userId,
        importance: memoryItem.importance,
        evidence: relation.evidence,
      });
    } catch {
      return false;
    }
  }

  private calculateGraphRelevance(memoryMetadata: Record<string, unknown>, queryEntities: Entity[]): number {
    const memoryEntities = Array.isArray(memoryMetadata.entities) ? memoryMetadata.entities.map(String) : [];
    if (memoryEntities.length === 0 || queryEntities.length === 0) {
      return 0;
    }
    const queryIds = new Set(queryEntities.map((entity) => entity.entityId));
    const matching = memoryEntities.filter((entityId) => queryIds.has(entityId)).length;
    const entityScore = queryIds.size > 0 ? matching / queryIds.size : 0;
    const entityDensity = Math.min(memoryEntities.length / 10, 1);
    const relationCount = Number(memoryMetadata.relation_count ?? 0);
    const relationDensity = Math.min(relationCount / 5, 1);
    return Math.min(entityScore * 0.6 + entityDensity * 0.2 + relationDensity * 0.2, 1);
  }

  private addOrUpdateEntity(entity: Entity): void {
    const existing = this.entities.get(entity.entityId);
    if (existing) {
      existing.frequency += 1;
      existing.updatedAt = new Date();
    } else {
      this.entities.set(entity.entityId, entity);
    }
  }

  private addOrUpdateRelation(relation: Relation): void {
    const existing = this.relations.find(
      (item) =>
        item.fromEntity === relation.fromEntity &&
        item.toEntity === relation.toEntity &&
        item.relationType === relation.relationType,
    );
    if (existing) {
      existing.frequency += 1;
    } else {
      this.relations.push(relation);
    }
  }

  private findMemoryById(memoryId: string): MemoryItem | undefined {
    return this.semanticMemories.find((memory) => memory.id === memoryId);
  }
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeTimestamp(value: unknown): Date {
  if (typeof value === "number") {
    return new Date(value * 1000);
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }
  return new Date();
}

function softmax(scores: number[]): number[] {
  if (scores.length === 0) {
    return [];
  }
  const max = Math.max(...scores);
  const exps = scores.map((score) => Math.exp(score - max));
  const denom = exps.reduce((sum, value) => sum + value, 0) || 1;
  return exps.map((value) => value / denom);
}

function detectEntityType(name: string): string {
  if (/^[A-Z][a-z]+/.test(name)) {
    return "PROPN";
  }
  if (/[\u3400-\u9fff]/.test(name)) {
    return "CONCEPT";
  }
  return "MISC";
}
