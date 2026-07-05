import { dynamicImport } from "../utils.js";

export interface Neo4jGraphStoreOptions {
  uri?: string;
  username?: string;
  password?: string;
  database?: string;
  maxConnectionLifetime?: number;
  maxConnectionPoolSize?: number;
  connectionAcquisitionTimeout?: number;
}

interface Neo4jModule {
  default?: Neo4jDriverFactory;
  auth?: {
    basic(username: string, password: string): unknown;
  };
  driver?: (uri: string, authToken: unknown, config?: Record<string, unknown>) => Neo4jDriver;
}

interface Neo4jDriverFactory {
  auth?: {
    basic(username: string, password: string): unknown;
  };
  driver(uri: string, authToken: unknown, config?: Record<string, unknown>): Neo4jDriver;
}

interface Neo4jDriver {
  verifyConnectivity(): Promise<void>;
  session(options?: { database?: string }): Neo4jSession;
  close(): Promise<void>;
}

interface Neo4jSession {
  run(query: string, params?: Record<string, unknown>): Promise<Neo4jResult>;
  close(): Promise<void>;
}

interface Neo4jResult {
  records: Neo4jRecord[];
  summary?: {
    counters?: {
      updates?: () => Record<string, number>;
    };
  };
}

interface Neo4jRecord {
  get(key: string): unknown;
}

export class Neo4jGraphStore {
  readonly uri: string;
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly maxConnectionLifetime: number;
  readonly maxConnectionPoolSize: number;
  readonly connectionAcquisitionTimeout: number;

  private driverPromise?: Promise<Neo4jDriver>;

  constructor(options: Neo4jGraphStoreOptions = {}) {
    this.uri = options.uri ?? "bolt://localhost:7687";
    this.username = options.username ?? "neo4j";
    this.password = options.password ?? "hello-agents-password";
    this.database = options.database ?? "neo4j";
    this.maxConnectionLifetime = options.maxConnectionLifetime ?? 3600;
    this.maxConnectionPoolSize = options.maxConnectionPoolSize ?? 50;
    this.connectionAcquisitionTimeout = options.connectionAcquisitionTimeout ?? 60;
  }

  async addEntity(
    entityId: string,
    name: string,
    entityType: string,
    properties: Record<string, unknown> = {},
  ): Promise<boolean> {
    const props = {
      ...properties,
      id: entityId,
      name,
      type: entityType,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const result = await this.run(
      `
      MERGE (e:Entity {id: $entityId})
      SET e += $properties
      RETURN e
      `,
      { entityId, properties: props },
    );
    return result.records.length > 0;
  }

  async addRelationship(
    fromEntityId: string,
    toEntityId: string,
    relationshipType: string,
    properties: Record<string, unknown> = {},
  ): Promise<boolean> {
    const safeType = sanitizeRelationshipType(relationshipType);
    const props = {
      ...properties,
      type: safeType,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const result = await this.run(
      `
      MATCH (from:Entity {id: $fromId})
      MATCH (to:Entity {id: $toId})
      MERGE (from)-[r:${safeType}]->(to)
      SET r += $properties
      RETURN r
      `,
      { fromId: fromEntityId, toId: toEntityId, properties: props },
    );
    return result.records.length > 0;
  }

  async findRelatedEntities(
    entityId: string,
    options: { relationshipTypes?: string[]; maxDepth?: number; limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const relationshipTypes = options.relationshipTypes?.map(sanitizeRelationshipType).join("|");
    const relFilter = relationshipTypes ? `:${relationshipTypes}` : "";
    const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 2, 5));
    const limit = sanitizeLimit(options.limit ?? 50);
    const result = await this.run(
      `
      MATCH path = (start:Entity {id: $entityId})-[r${relFilter}*1..${maxDepth}]-(related:Entity)
      WHERE start.id <> related.id
      RETURN DISTINCT related,
        length(path) as distance,
        [rel in relationships(path) | type(rel)] as relationship_path
      ORDER BY distance, related.name
      LIMIT ${limit}
      `,
      { entityId },
    );
    return result.records.map((record) => ({
      ...nodeToObject(record.get("related")),
      distance: numericValue(record.get("distance")),
      relationship_path: record.get("relationship_path"),
    }));
  }

  async searchEntitiesByName(
    namePattern: string,
    options: { entityTypes?: string[]; limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const typeFilter = options.entityTypes && options.entityTypes.length > 0 ? "AND e.type IN $types" : "";
    const limit = sanitizeLimit(options.limit ?? 20);
    const result = await this.run(
      `
      MATCH (e:Entity)
      WHERE e.name =~ $pattern ${typeFilter}
      RETURN e
      ORDER BY e.name
      LIMIT ${limit}
      `,
      {
        pattern: `.*${escapeRegex(namePattern)}.*`,
        types: options.entityTypes ?? [],
      },
    );
    return result.records.map((record) => nodeToObject(record.get("e")));
  }

  async getEntityRelationships(entityId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.run(
      `
      MATCH (e:Entity {id: $entityId})-[r]-(other:Entity)
      RETURN r, other,
        CASE WHEN startNode(r).id = $entityId THEN 'outgoing' ELSE 'incoming' END as direction
      `,
      { entityId },
    );
    return result.records.map((record) => ({
      relationship: nodeToObject(record.get("r")),
      other_entity: nodeToObject(record.get("other")),
      direction: record.get("direction"),
    }));
  }

  async deleteEntity(entityId: string): Promise<boolean> {
    const result = await this.run(
      `
      MATCH (e:Entity {id: $entityId})
      DETACH DELETE e
      `,
      { entityId },
    );
    return counters(result).nodesDeleted > 0;
  }

  async clearAll(): Promise<boolean> {
    await this.run("MATCH (n) DETACH DELETE n");
    return true;
  }

  async getStats(): Promise<Record<string, unknown>> {
    const queries: Record<string, string> = {
      total_nodes: "MATCH (n) RETURN count(n) as count",
      total_relationships: "MATCH ()-[r]->() RETURN count(r) as count",
      entity_nodes: "MATCH (n:Entity) RETURN count(n) as count",
      memory_nodes: "MATCH (n:Memory) RETURN count(n) as count",
    };
    const stats: Record<string, unknown> = {};
    for (const [key, query] of Object.entries(queries)) {
      const result = await this.run(query);
      stats[key] = numericValue(result.records[0]?.get("count"));
    }
    return stats;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.run("RETURN 1 as health");
      return numericValue(result.records[0]?.get("health")) === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    const driver = await this.driverPromise;
    await driver?.close();
    this.driverPromise = undefined;
  }

  private async run(query: string, params: Record<string, unknown> = {}): Promise<Neo4jResult> {
    const driver = await this.getDriver();
    const session = driver.session({ database: this.database });
    try {
      return await session.run(query, params);
    } finally {
      await session.close();
    }
  }

  private async getDriver(): Promise<Neo4jDriver> {
    this.driverPromise ??= this.openDriver();
    return this.driverPromise;
  }

  private async openDriver(): Promise<Neo4jDriver> {
    const module = await dynamicImport<Neo4jModule>("neo4j-driver");
    const factory = module.default ?? module;
    const auth = factory.auth?.basic(this.username, this.password) ?? module.auth?.basic(this.username, this.password);
    const driverFactory = factory.driver ?? module.driver;
    if (!auth || !driverFactory) {
      throw new Error("neo4j-driver 未正确加载。请安装 optional dependency: neo4j-driver。");
    }
    const driver = driverFactory(this.uri, auth, {
      maxConnectionLifetime: this.maxConnectionLifetime * 1000,
      maxConnectionPoolSize: this.maxConnectionPoolSize,
      connectionAcquisitionTimeout: this.connectionAcquisitionTimeout * 1000,
    });
    await driver.verifyConnectivity();
    await this.createIndexes(driver);
    return driver;
  }

  private async createIndexes(driver: Neo4jDriver): Promise<void> {
    const indexes = [
      "CREATE INDEX entity_id_index IF NOT EXISTS FOR (e:Entity) ON (e.id)",
      "CREATE INDEX entity_name_index IF NOT EXISTS FOR (e:Entity) ON (e.name)",
      "CREATE INDEX entity_type_index IF NOT EXISTS FOR (e:Entity) ON (e.type)",
      "CREATE INDEX memory_id_index IF NOT EXISTS FOR (m:Memory) ON (m.id)",
      "CREATE INDEX memory_type_index IF NOT EXISTS FOR (m:Memory) ON (m.memory_type)",
      "CREATE INDEX memory_timestamp_index IF NOT EXISTS FOR (m:Memory) ON (m.timestamp)",
    ];
    const session = driver.session({ database: this.database });
    try {
      for (const index of indexes) {
        try {
          await session.run(index);
        } catch {
          // Index syntax differs across Neo4j-compatible deployments. Graph writes still work without these indexes.
        }
      }
    } finally {
      await session.close();
    }
  }
}

function sanitizeRelationshipType(value: string): string {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return cleaned.length > 0 ? cleaned : "RELATED_TO";
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 20;
  }
  return Math.max(0, Math.floor(value));
}

function nodeToObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  if ("properties" in value) {
    const props = (value as { properties?: Record<string, unknown> }).properties;
    return props ? normalizeNeo4jNumbers(props) : {};
  }
  return normalizeNeo4jNumbers(value as Record<string, unknown>);
}

function normalizeNeo4jNumbers(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, numericValue(value)]));
}

function numericValue(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "toNumber" in value) {
    const converted = (value as { toNumber(): number }).toNumber();
    return Number.isFinite(converted) ? converted : value;
  }
  return value;
}

function counters(result: Neo4jResult): { nodesDeleted: number } {
  const updates = result.summary?.counters?.updates?.() ?? {};
  return {
    nodesDeleted: updates.nodesDeleted ?? 0,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
