import { BaseMemory, MemoryItem, type MemoryMetadata, type MemoryStats, type RetrieveMemoryOptions } from "../base.js";
import type { MemoryConfig } from "../base.js";
import { cosineSimilarity, estimateTokens, tokenize } from "../utils.js";

export class WorkingMemory extends BaseMemory {
  private readonly maxCapacity: number;
  private readonly maxTokens: number;
  private readonly maxAgeMinutes: number;
  private readonly sessionStart: Date;
  private currentTokens = 0;
  private memories: MemoryItem[] = [];

  constructor(config: MemoryConfig) {
    super(config);
    this.maxCapacity = config.workingMemoryCapacity;
    this.maxTokens = config.workingMemoryTokens;
    this.maxAgeMinutes = config.workingMemoryTtlMinutes;
    this.sessionStart = new Date();
  }

  async add(memoryItem: MemoryItem): Promise<string> {
    this.expireOldMemories();
    this.memories.push(memoryItem);
    this.currentTokens += estimateTokens(memoryItem.content);
    this.enforceCapacityLimits();
    return memoryItem.id;
  }

  async retrieve(query: string, limit = 5, options: RetrieveMemoryOptions = {}): Promise<MemoryItem[]> {
    this.expireOldMemories();
    const minImportance = options.minImportance ?? 0;
    const active = this.memories.filter(
      (memory) =>
        !memory.metadata.forgotten &&
        memory.importance >= minImportance &&
        (!options.userId || memory.userId === options.userId),
    );

    if (active.length === 0) {
      return [];
    }

    const queryVector = buildTermVector(query);
    const queryLower = query.toLowerCase();
    const scored = active
      .map((memory) => {
        const vectorScore = cosineSimilarity(queryVector.vector, buildTermVector(memory.content, queryVector.vocabulary).vector);
        const keywordScore = calculateKeywordScore(queryLower, memory.content.toLowerCase());
        const base = vectorScore > 0 ? vectorScore * 0.7 + keywordScore * 0.3 : keywordScore;
        const score = base * this.calculateTimeDecay(memory.timestamp) * (0.8 + memory.importance * 0.4);
        return { memory, score };
      })
      .filter((item) => query.trim().length === 0 || item.score > 0)
      .sort((left, right) => right.score - left.score || right.memory.importance - left.memory.importance);

    return scored.slice(0, limit).map((item) => item.memory);
  }

  async update(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: MemoryMetadata,
  ): Promise<boolean> {
    const memory = this.memories.find((item) => item.id === memoryId);
    if (!memory) {
      return false;
    }

    if (content !== undefined) {
      this.currentTokens = Math.max(0, this.currentTokens - estimateTokens(memory.content) + estimateTokens(content));
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
    return true;
  }

  async remove(memoryId: string): Promise<boolean> {
    const before = this.memories.length;
    const removed = this.memories.find((memory) => memory.id === memoryId);
    this.memories = this.memories.filter((memory) => memory.id !== memoryId);
    if (removed) {
      this.currentTokens = Math.max(0, this.currentTokens - estimateTokens(removed.content));
    }
    return this.memories.length !== before;
  }

  async hasMemory(memoryId: string): Promise<boolean> {
    return this.memories.some((memory) => memory.id === memoryId);
  }

  async clear(): Promise<void> {
    this.memories = [];
    this.currentTokens = 0;
  }

  async getStats(): Promise<MemoryStats> {
    this.expireOldMemories();
    const avgImportance =
      this.memories.length > 0 ? this.memories.reduce((sum, memory) => sum + memory.importance, 0) / this.memories.length : 0;
    return {
      count: this.memories.length,
      forgottenCount: 0,
      totalCount: this.memories.length,
      current_tokens: this.currentTokens,
      max_capacity: this.maxCapacity,
      max_tokens: this.maxTokens,
      max_age_minutes: this.maxAgeMinutes,
      session_duration_minutes: (Date.now() - this.sessionStart.getTime()) / 60000,
      avgImportance,
      avg_importance: avgImportance,
      capacity_usage: this.maxCapacity > 0 ? this.memories.length / this.maxCapacity : 0,
      token_usage: this.maxTokens > 0 ? this.currentTokens / this.maxTokens : 0,
      memoryType: "working",
      memory_type: "working",
    };
  }

  async getAll(): Promise<MemoryItem[]> {
    this.expireOldMemories();
    return [...this.memories];
  }

  getRecent(limit = 10): MemoryItem[] {
    this.expireOldMemories();
    return [...this.memories].sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime()).slice(0, limit);
  }

  getImportant(limit = 10): MemoryItem[] {
    this.expireOldMemories();
    return [...this.memories].sort((left, right) => right.importance - left.importance).slice(0, limit);
  }

  getContextSummary(maxLength = 500): string {
    this.expireOldMemories();
    if (this.memories.length === 0) {
      return "No working memories available.";
    }

    const sorted = [...this.memories].sort(
      (left, right) =>
        right.importance - left.importance || right.timestamp.getTime() - left.timestamp.getTime(),
    );
    const parts: string[] = [];
    let length = 0;
    for (const memory of sorted) {
      if (length + memory.content.length <= maxLength) {
        parts.push(memory.content);
        length += memory.content.length;
        continue;
      }
      const remaining = maxLength - length;
      if (remaining > 50) {
        parts.push(`${memory.content.slice(0, remaining)}...`);
      }
      break;
    }
    return `Working Memory Context:\n${parts.join("\n")}`;
  }

  async forget(strategy = "importance_based", threshold = 0.1, maxAgeDays = 1): Promise<number> {
    this.expireOldMemories();
    const before = this.memories.length;
    const now = Date.now();

    if (strategy === "importance_based") {
      this.memories = this.memories.filter((memory) => memory.importance >= threshold);
    } else if (strategy === "time_based") {
      const cutoff = now - maxAgeDays * 86400000;
      this.memories = this.memories.filter((memory) => memory.timestamp.getTime() >= cutoff);
    } else if (strategy === "capacity_based" && this.memories.length > this.maxCapacity) {
      this.memories = [...this.memories]
        .sort((left, right) => this.calculatePriority(right) - this.calculatePriority(left))
        .slice(0, this.maxCapacity);
    }

    this.recalculateTokens();
    return before - this.memories.length;
  }

  private enforceCapacityLimits(): void {
    while (this.memories.length > this.maxCapacity || this.currentTokens > this.maxTokens) {
      this.removeLowestPriorityMemory();
    }
  }

  private expireOldMemories(): void {
    const cutoff = Date.now() - this.maxAgeMinutes * 60000;
    const before = this.memories.length;
    this.memories = this.memories.filter((memory) => memory.timestamp.getTime() >= cutoff);
    if (before !== this.memories.length) {
      this.recalculateTokens();
    }
  }

  private removeLowestPriorityMemory(): void {
    if (this.memories.length === 0) {
      return;
    }
    let lowest = this.memories[0];
    for (const memory of this.memories) {
      if (this.calculatePriority(memory) < this.calculatePriority(lowest)) {
        lowest = memory;
      }
    }
    this.memories = this.memories.filter((memory) => memory.id !== lowest.id);
    this.currentTokens = Math.max(0, this.currentTokens - estimateTokens(lowest.content));
  }

  private calculatePriority(memory: MemoryItem): number {
    return memory.importance * this.calculateTimeDecay(memory.timestamp);
  }

  private calculateTimeDecay(timestamp: Date): number {
    const hours = Math.max(0, (Date.now() - timestamp.getTime()) / 3600000);
    return Math.max(0.1, this.config.decayFactor ** (hours / 6));
  }

  private recalculateTokens(): void {
    this.currentTokens = this.memories.reduce((sum, memory) => sum + estimateTokens(memory.content), 0);
  }
}

function calculateKeywordScore(queryLower: string, contentLower: string): number {
  if (queryLower.trim().length === 0) {
    return 0.1;
  }
  if (contentLower.includes(queryLower)) {
    return queryLower.length / Math.max(contentLower.length, 1);
  }
  const queryWords = new Set(tokenize(queryLower));
  const contentWords = new Set(tokenize(contentLower));
  const intersection = [...queryWords].filter((word) => contentWords.has(word)).length;
  const union = new Set([...queryWords, ...contentWords]).size;
  return union > 0 ? (intersection / union) * 0.8 : 0;
}

function buildTermVector(text: string, existingVocabulary?: Map<string, number>): { vector: number[]; vocabulary: Map<string, number> } {
  const vocabulary = existingVocabulary ? new Map(existingVocabulary) : new Map<string, number>();
  for (const token of tokenize(text)) {
    if (!vocabulary.has(token)) {
      vocabulary.set(token, vocabulary.size);
    }
  }
  const vector = new Array<number>(vocabulary.size).fill(0);
  for (const token of tokenize(text)) {
    const index = vocabulary.get(token);
    if (index !== undefined) {
      vector[index] += 1;
    }
  }
  return { vector, vocabulary };
}
