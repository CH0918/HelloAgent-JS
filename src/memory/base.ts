import { clamp, generateId } from "./utils.js";

export type MemoryType = "working" | "episodic" | "semantic" | "perceptual";
export type MemoryMetadata = Record<string, unknown>;

export interface MemoryItemInput {
  id?: string;
  content: string;
  memoryType: MemoryType | string;
  userId: string;
  timestamp?: Date | string | number;
  importance?: number;
  metadata?: MemoryMetadata;
}

export class MemoryItem {
  id: string;
  content: string;
  memoryType: string;
  userId: string;
  timestamp: Date;
  importance: number;
  metadata: MemoryMetadata;

  constructor(input: MemoryItemInput) {
    this.id = input.id ?? generateId();
    this.content = input.content;
    this.memoryType = input.memoryType;
    this.userId = input.userId;
    this.timestamp = normalizeDate(input.timestamp);
    this.importance = clamp(input.importance ?? 0.5, 0, 1);
    this.metadata = input.metadata ?? {};
  }

  clone(overrides: Partial<MemoryItemInput> = {}): MemoryItem {
    return new MemoryItem({
      id: overrides.id ?? this.id,
      content: overrides.content ?? this.content,
      memoryType: overrides.memoryType ?? this.memoryType,
      userId: overrides.userId ?? this.userId,
      timestamp: overrides.timestamp ?? this.timestamp,
      importance: overrides.importance ?? this.importance,
      metadata: {
        ...this.metadata,
        ...(overrides.metadata ?? {}),
      },
    });
  }
}

export interface MemoryConfigOptions {
  storagePath?: string;
  maxCapacity?: number;
  importanceThreshold?: number;
  decayFactor?: number;
  workingMemoryCapacity?: number;
  workingMemoryTokens?: number;
  workingMemoryTtlMinutes?: number;
  perceptualMemoryModalities?: string[];
}

export class MemoryConfig {
  storagePath: string;
  maxCapacity: number;
  importanceThreshold: number;
  decayFactor: number;
  workingMemoryCapacity: number;
  workingMemoryTokens: number;
  workingMemoryTtlMinutes: number;
  perceptualMemoryModalities: string[];

  constructor(options: MemoryConfigOptions = {}) {
    this.storagePath = options.storagePath ?? "./memory_data";
    this.maxCapacity = options.maxCapacity ?? 100;
    this.importanceThreshold = options.importanceThreshold ?? 0.1;
    this.decayFactor = options.decayFactor ?? 0.95;
    this.workingMemoryCapacity = options.workingMemoryCapacity ?? 10;
    this.workingMemoryTokens = options.workingMemoryTokens ?? 2000;
    this.workingMemoryTtlMinutes = options.workingMemoryTtlMinutes ?? 120;
    this.perceptualMemoryModalities = options.perceptualMemoryModalities ?? ["text", "image", "audio", "video"];
  }
}

export interface RetrieveMemoryOptions {
  userId?: string;
  minImportance?: number;
  importanceThreshold?: number;
  sessionId?: string;
  timeRange?: [Date, Date];
  targetModality?: string;
  queryModality?: string;
}

export interface MemoryStats {
  count: number;
  forgottenCount?: number;
  totalCount?: number;
  memoryType: string;
  avgImportance?: number;
  [key: string]: unknown;
}

export abstract class BaseMemory {
  readonly config: MemoryConfig;
  readonly memoryType: string;

  protected constructor(config: MemoryConfig) {
    this.config = config;
    this.memoryType = this.constructor.name.toLowerCase().replace("memory", "");
  }

  abstract add(memoryItem: MemoryItem): Promise<string>;

  abstract retrieve(query: string, limit?: number, options?: RetrieveMemoryOptions): Promise<MemoryItem[]>;

  abstract update(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: MemoryMetadata,
  ): Promise<boolean>;

  abstract remove(memoryId: string): Promise<boolean>;

  abstract hasMemory(memoryId: string): Promise<boolean>;

  abstract clear(): Promise<void>;

  abstract getStats(): Promise<MemoryStats>;

  abstract getAll(): Promise<MemoryItem[]>;

  calculateImportance(content: string, baseImportance = 0.5, metadata?: MemoryMetadata): number {
    let importance = baseImportance;

    if (content.length > 100) {
      importance += 0.1;
    }

    const keywords = ["重要", "关键", "必须", "注意", "警告", "错误"];
    if (keywords.some((keyword) => content.includes(keyword))) {
      importance += 0.2;
    }

    if (metadata?.priority === "high") {
      importance += 0.3;
    } else if (metadata?.priority === "low") {
      importance -= 0.2;
    }

    return clamp(importance, 0, 1);
  }
}

function normalizeDate(value: Date | string | number | undefined): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}
