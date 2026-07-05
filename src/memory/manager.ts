import { MemoryConfig, MemoryItem, type BaseMemory, type MemoryMetadata, type MemoryStats } from "./base.js";
import type { MemoryType, RetrieveMemoryOptions } from "./base.js";
import { EpisodicMemory, PerceptualMemory, SemanticMemory, WorkingMemory } from "./types/index.js";

export interface MemoryManagerOptions {
  config?: MemoryConfig;
  userId?: string;
  enableWorking?: boolean;
  enableEpisodic?: boolean;
  enableSemantic?: boolean;
  enablePerceptual?: boolean;
}

export interface MemoryManagerStats {
  user_id: string;
  enabled_types: string[];
  total_memories: number;
  memories_by_type: Record<string, MemoryStats>;
  config: {
    max_capacity: number;
    importance_threshold: number;
    decay_factor: number;
  };
}

export class MemoryManager {
  readonly config: MemoryConfig;
  readonly userId: string;
  readonly memoryTypes: Map<string, BaseMemory>;

  constructor(options: MemoryManagerOptions = {}) {
    this.config = options.config ?? new MemoryConfig();
    this.userId = options.userId ?? "default_user";
    this.memoryTypes = new Map();

    if (options.enableWorking ?? true) {
      this.memoryTypes.set("working", new WorkingMemory(this.config));
    }
    if (options.enableEpisodic ?? true) {
      this.memoryTypes.set("episodic", new EpisodicMemory(this.config));
    }
    if (options.enableSemantic ?? true) {
      this.memoryTypes.set("semantic", new SemanticMemory(this.config));
    }
    if (options.enablePerceptual ?? false) {
      this.memoryTypes.set("perceptual", new PerceptualMemory(this.config));
    }
  }

  async addMemory(input: {
    content: string;
    memoryType?: MemoryType | string;
    importance?: number;
    metadata?: MemoryMetadata;
    autoClassify?: boolean;
  }): Promise<string> {
    const memoryType = input.autoClassify ?? true ? this.classifyMemoryType(input.content, input.metadata) : input.memoryType ?? "working";
    const importance = input.importance ?? this.calculateImportance(input.content, input.metadata);
    const memory = new MemoryItem({
      content: input.content,
      memoryType,
      userId: this.userId,
      importance,
      metadata: input.metadata ?? {},
    });
    const memoryInstance = this.memoryTypes.get(memoryType);
    if (!memoryInstance) {
      throw new Error(`不支持的记忆类型: ${memoryType}`);
    }
    return memoryInstance.add(memory);
  }

  async retrieveMemories(input: {
    query: string;
    memoryTypes?: string[];
    limit?: number;
    minImportance?: number;
    timeRange?: [Date, Date];
  }): Promise<MemoryItem[]> {
    const targetTypes = input.memoryTypes ?? [...this.memoryTypes.keys()];
    const allResults: MemoryItem[] = [];
    const perTypeLimit = Math.max(1, Math.floor((input.limit ?? 10) / Math.max(targetTypes.length, 1)));
    const options: RetrieveMemoryOptions = {
      userId: this.userId,
      minImportance: input.minImportance ?? 0,
      timeRange: input.timeRange,
    };

    for (const memoryType of targetTypes) {
      const memoryInstance = this.memoryTypes.get(memoryType);
      if (!memoryInstance) {
        continue;
      }
      try {
        allResults.push(...(await memoryInstance.retrieve(input.query, perTypeLimit, options)));
      } catch {
        // Python skips failed memory type retrieval and continues.
      }
    }

    return allResults.sort((left, right) => right.importance - left.importance).slice(0, input.limit ?? 10);
  }

  async updateMemory(memoryId: string, content?: string, importance?: number, metadata?: MemoryMetadata): Promise<boolean> {
    for (const memoryInstance of this.memoryTypes.values()) {
      if (await memoryInstance.hasMemory(memoryId)) {
        return memoryInstance.update(memoryId, content, importance, metadata);
      }
    }
    return false;
  }

  async removeMemory(memoryId: string): Promise<boolean> {
    for (const memoryInstance of this.memoryTypes.values()) {
      if (await memoryInstance.hasMemory(memoryId)) {
        return memoryInstance.remove(memoryId);
      }
    }
    return false;
  }

  async forgetMemories(strategy = "importance_based", threshold = 0.1, maxAgeDays = 30): Promise<number> {
    let total = 0;
    for (const memoryInstance of this.memoryTypes.values()) {
      if ("forget" in memoryInstance && typeof memoryInstance.forget === "function") {
        total += await memoryInstance.forget(strategy, threshold, maxAgeDays);
      }
    }
    return total;
  }

  async consolidateMemories(fromType = "working", toType = "episodic", importanceThreshold = 0.7): Promise<number> {
    const source = this.memoryTypes.get(fromType);
    const target = this.memoryTypes.get(toType);
    if (!source || !target) {
      return 0;
    }

    const candidates = (await source.getAll()).filter((memory) => memory.importance >= importanceThreshold);
    let count = 0;
    for (const memory of candidates) {
      if (await source.remove(memory.id)) {
        memory.memoryType = toType;
        memory.importance *= 1.1;
        await target.add(memory);
        count += 1;
      }
    }
    return count;
  }

  async getMemoryStats(): Promise<MemoryManagerStats> {
    const memoriesByType: Record<string, MemoryStats> = {};
    let total = 0;
    for (const [memoryType, memoryInstance] of this.memoryTypes.entries()) {
      const stats = await memoryInstance.getStats();
      memoriesByType[memoryType] = stats;
      total += Number(stats.count ?? 0);
    }
    return {
      user_id: this.userId,
      enabled_types: [...this.memoryTypes.keys()],
      total_memories: total,
      memories_by_type: memoriesByType,
      config: {
        max_capacity: this.config.maxCapacity,
        importance_threshold: this.config.importanceThreshold,
        decay_factor: this.config.decayFactor,
      },
    };
  }

  async clearAllMemories(): Promise<void> {
    for (const memoryInstance of this.memoryTypes.values()) {
      await memoryInstance.clear();
    }
  }

  private classifyMemoryType(content: string, metadata?: MemoryMetadata): string {
    if (typeof metadata?.type === "string") {
      return metadata.type;
    }
    if (["昨天", "今天", "明天", "上次", "记得", "发生", "经历"].some((keyword) => content.includes(keyword))) {
      return "episodic";
    }
    if (["定义", "概念", "规则", "知识", "原理", "方法"].some((keyword) => content.includes(keyword))) {
      return "semantic";
    }
    return "working";
  }

  private calculateImportance(content: string, metadata?: MemoryMetadata): number {
    let importance = 0.5;
    if (content.length > 100) {
      importance += 0.1;
    }
    if (["重要", "关键", "必须", "注意", "警告", "错误"].some((keyword) => content.includes(keyword))) {
      importance += 0.2;
    }
    if (metadata?.priority === "high") {
      importance += 0.3;
    } else if (metadata?.priority === "low") {
      importance -= 0.2;
    }
    return Math.min(Math.max(importance, 0), 1);
  }
}
