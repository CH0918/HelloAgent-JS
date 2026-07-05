import { dirname, dynamicImport, ensureDirectory, generateId, parseJsonObject } from "../utils.js";

export interface StoredMemory {
  memoryId: string;
  userId: string;
  content: string;
  memoryType: string;
  timestamp: number;
  importance: number;
  properties: Record<string, unknown>;
  createdAt?: string;
}

export interface SearchMemoriesOptions {
  userId?: string;
  memoryType?: string;
  startTime?: number;
  endTime?: number;
  importanceThreshold?: number;
  limit?: number;
}

export interface DocumentStore {
  addMemory(input: {
    memoryId: string;
    userId: string;
    content: string;
    memoryType: string;
    timestamp: number;
    importance: number;
    properties?: Record<string, unknown>;
  }): Promise<string>;
  getMemory(memoryId: string): Promise<StoredMemory | undefined>;
  searchMemories(options?: SearchMemoriesOptions): Promise<StoredMemory[]>;
  updateMemory(memoryId: string, updates: {
    content?: string;
    importance?: number;
    properties?: Record<string, unknown>;
  }): Promise<boolean>;
  deleteMemory(memoryId: string): Promise<boolean>;
  getDatabaseStats(): Promise<Record<string, unknown>>;
  addDocument(content: string, metadata?: Record<string, unknown>): Promise<string>;
  getDocument(documentId: string): Promise<StoredMemory | undefined>;
  close(): Promise<void>;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteStatement {
  run(...params: unknown[]): { changes?: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface BetterSqliteModule {
  default?: new (path: string) => SqliteDatabase;
}

export class SQLiteDocumentStore implements DocumentStore {
  private static readonly instances = new Map<string, SQLiteDocumentStore>();

  readonly dbPath: string;
  private databasePromise?: Promise<SqliteDatabase>;

  static getInstance(dbPath = "./memory.db"): SQLiteDocumentStore {
    const existing = SQLiteDocumentStore.instances.get(dbPath);
    if (existing) {
      return existing;
    }
    const store = new SQLiteDocumentStore(dbPath);
    SQLiteDocumentStore.instances.set(dbPath, store);
    return store;
  }

  constructor(dbPath = "./memory.db") {
    this.dbPath = dbPath;
  }

  async addMemory(input: {
    memoryId: string;
    userId: string;
    content: string;
    memoryType: string;
    timestamp: number;
    importance: number;
    properties?: Record<string, unknown>;
  }): Promise<string> {
    const db = await this.getDatabase();
    db.prepare("INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)").run(input.userId, input.userId);
    db.prepare(`
      INSERT OR REPLACE INTO memories
        (id, user_id, content, memory_type, timestamp, importance, properties, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      input.memoryId,
      input.userId,
      input.content,
      input.memoryType,
      input.timestamp,
      input.importance,
      JSON.stringify(input.properties ?? {}),
    );
    return input.memoryId;
  }

  async getMemory(memoryId: string): Promise<StoredMemory | undefined> {
    const db = await this.getDatabase();
    const row = db.prepare(`
      SELECT id, user_id, content, memory_type, timestamp, importance, properties, created_at
      FROM memories
      WHERE id = ?
    `).get(memoryId);
    return normalizeStoredMemory(row);
  }

  async searchMemories(options: SearchMemoriesOptions = {}): Promise<StoredMemory[]> {
    const db = await this.getDatabase();
    const where: string[] = [];
    const params: unknown[] = [];

    if (options.userId) {
      where.push("user_id = ?");
      params.push(options.userId);
    }
    if (options.memoryType) {
      where.push("memory_type = ?");
      params.push(options.memoryType);
    }
    if (options.startTime !== undefined) {
      where.push("timestamp >= ?");
      params.push(options.startTime);
    }
    if (options.endTime !== undefined) {
      where.push("timestamp <= ?");
      params.push(options.endTime);
    }
    if (options.importanceThreshold !== undefined) {
      where.push("importance >= ?");
      params.push(options.importanceThreshold);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT id, user_id, content, memory_type, timestamp, importance, properties, created_at
      FROM memories
      ${whereClause}
      ORDER BY importance DESC, timestamp DESC
      LIMIT ?
    `).all(...params, options.limit ?? 10);
    return rows.map(normalizeStoredMemory).filter((item): item is StoredMemory => item !== undefined);
  }

  async updateMemory(memoryId: string, updates: {
    content?: string;
    importance?: number;
    properties?: Record<string, unknown>;
  }): Promise<boolean> {
    const fields: string[] = [];
    const params: unknown[] = [];

    if (updates.content !== undefined) {
      fields.push("content = ?");
      params.push(updates.content);
    }
    if (updates.importance !== undefined) {
      fields.push("importance = ?");
      params.push(updates.importance);
    }
    if (updates.properties !== undefined) {
      fields.push("properties = ?");
      params.push(JSON.stringify(updates.properties));
    }

    if (fields.length === 0) {
      return false;
    }

    const db = await this.getDatabase();
    const result = db.prepare(`
      UPDATE memories
      SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...params, memoryId);
    return (result.changes ?? 0) > 0;
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    const db = await this.getDatabase();
    const result = db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
    return (result.changes ?? 0) > 0;
  }

  async getDatabaseStats(): Promise<Record<string, unknown>> {
    const db = await this.getDatabase();
    const tables = ["users", "memories", "concepts", "memory_concepts", "concept_relationships"];
    const stats: Record<string, unknown> = {
      store_type: "sqlite",
      db_path: this.dbPath,
    };

    for (const table of tables) {
      const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count?: number } | undefined;
      stats[`${table}_count`] = row?.count ?? 0;
    }

    const memoryTypes = db.prepare("SELECT memory_type, COUNT(*) as count FROM memories GROUP BY memory_type").all() as Array<{
      memory_type?: string;
      count?: number;
    }>;
    stats.memory_types = Object.fromEntries(memoryTypes.map((row) => [row.memory_type ?? "unknown", row.count ?? 0]));
    return stats;
  }

  async addDocument(content: string, metadata: Record<string, unknown> = {}): Promise<string> {
    const documentId = generateId();
    await this.addMemory({
      memoryId: documentId,
      userId: typeof metadata.user_id === "string" ? metadata.user_id : "system",
      content,
      memoryType: "document",
      timestamp: Math.floor(Date.now() / 1000),
      importance: 0.5,
      properties: metadata,
    });
    return documentId;
  }

  async getDocument(documentId: string): Promise<StoredMemory | undefined> {
    return this.getMemory(documentId);
  }

  async close(): Promise<void> {
    const db = await this.databasePromise;
    db?.close();
    this.databasePromise = undefined;
  }

  private async getDatabase(): Promise<SqliteDatabase> {
    this.databasePromise ??= this.openDatabase();
    return this.databasePromise;
  }

  private async openDatabase(): Promise<SqliteDatabase> {
    await ensureDirectory(dirname(this.dbPath));
    const module = await dynamicImport<BetterSqliteModule>("better-sqlite3");
    const BetterSqlite = module.default;
    if (!BetterSqlite) {
      throw new Error("better-sqlite3 未正确加载。请安装 optional dependency: better-sqlite3。");
    }
    const db = new BetterSqlite(this.dbPath);
    this.initializeDatabase(db);
    return db;
  }

  private initializeDatabase(db: SqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        properties TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        importance REAL NOT NULL,
        properties TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      );

      CREATE TABLE IF NOT EXISTS concepts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        properties TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS memory_concepts (
        memory_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        relevance_score REAL DEFAULT 1.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (memory_id, concept_id),
        FOREIGN KEY (memory_id) REFERENCES memories (id) ON DELETE CASCADE,
        FOREIGN KEY (concept_id) REFERENCES concepts (id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS concept_relationships (
        from_concept_id TEXT NOT NULL,
        to_concept_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        strength REAL DEFAULT 1.0,
        properties TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (from_concept_id, to_concept_id, relationship_type),
        FOREIGN KEY (from_concept_id) REFERENCES concepts (id) ON DELETE CASCADE,
        FOREIGN KEY (to_concept_id) REFERENCES concepts (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories (user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories (memory_type);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories (timestamp);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories (importance);
      CREATE INDEX IF NOT EXISTS idx_memory_concepts_memory ON memory_concepts (memory_id);
      CREATE INDEX IF NOT EXISTS idx_memory_concepts_concept ON memory_concepts (concept_id);
    `);
  }
}

function normalizeStoredMemory(row: unknown): StoredMemory | undefined {
  if (typeof row !== "object" || row === null) {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  return {
    memoryId: String(record.id ?? ""),
    userId: String(record.user_id ?? ""),
    content: String(record.content ?? ""),
    memoryType: String(record.memory_type ?? ""),
    timestamp: Number(record.timestamp ?? 0),
    importance: Number(record.importance ?? 0.5),
    properties: parseJsonObject(typeof record.properties === "string" ? record.properties : undefined),
    createdAt: typeof record.created_at === "string" ? record.created_at : undefined,
  };
}
