import { MemoryConfig, MemoryManager } from "../../memory/index.js";
import { Tool } from "../base.js";
import type { ToolParameter, ToolParameters } from "../base.js";

export interface MemoryToolOptions {
  userId?: string;
  memoryConfig?: MemoryConfig;
  memoryTypes?: string[];
  expandable?: boolean;
}

export class MemoryTool extends Tool {
  readonly memoryConfig: MemoryConfig;
  readonly memoryTypes: string[];
  readonly memoryManager: MemoryManager;
  private currentSessionId?: string;
  private conversationCount = 0;

  constructor(options: MemoryToolOptions = {}) {
    super("memory", "记忆工具 - 可以存储和检索对话历史、知识和经验", options.expandable ?? false);
    this.memoryConfig = options.memoryConfig ?? new MemoryConfig();
    this.memoryTypes = options.memoryTypes ?? ["working", "episodic", "semantic"];
    this.memoryManager = new MemoryManager({
      config: this.memoryConfig,
      userId: options.userId ?? "default_user",
      enableWorking: this.memoryTypes.includes("working"),
      enableEpisodic: this.memoryTypes.includes("episodic"),
      enableSemantic: this.memoryTypes.includes("semantic"),
      enablePerceptual: this.memoryTypes.includes("perceptual"),
    });
  }

  async run(parameters: ToolParameters): Promise<string> {
    if (!this.validateParameters(parameters)) {
      return "参数验证失败：缺少必需的参数";
    }

    const action = readString(parameters.action);
    try {
      if (action === "add") {
        return this.addMemory({
          content: readString(parameters.content) ?? "",
          memoryType: readString(parameters.memory_type) ?? readString(parameters.memoryType) ?? "working",
          importance: readNumber(parameters.importance, 0.5),
          filePath: readString(parameters.file_path) ?? readString(parameters.filePath),
          modality: readString(parameters.modality),
        });
      }
      if (action === "search") {
        return this.searchMemory({
          query: readString(parameters.query) ?? "",
          limit: readInteger(parameters.limit, 5),
          memoryType: readString(parameters.memory_type) ?? readString(parameters.memoryType),
          minImportance: readNumber(parameters.min_importance, 0.1),
        });
      }
      if (action === "summary") {
        return this.getSummary(readInteger(parameters.limit, 10));
      }
      if (action === "stats") {
        return this.getStats();
      }
      if (action === "update") {
        return this.updateMemory({
          memoryId: readString(parameters.memory_id) ?? readString(parameters.memoryId),
          content: readString(parameters.content),
          importance: readOptionalNumber(parameters.importance),
        });
      }
      if (action === "remove") {
        return this.removeMemory(readString(parameters.memory_id) ?? readString(parameters.memoryId));
      }
      if (action === "forget") {
        return this.forget(
          readString(parameters.strategy) ?? "importance_based",
          readNumber(parameters.threshold, 0.1),
          readInteger(parameters.max_age_days, 30),
        );
      }
      if (action === "consolidate") {
        return this.consolidate(
          readString(parameters.from_type) ?? "working",
          readString(parameters.to_type) ?? "episodic",
          readNumber(parameters.importance_threshold, 0.7),
        );
      }
      if (action === "clear_all") {
        return this.clearAll();
      }
      return `不支持的操作: ${String(parameters.action)}`;
    } catch (error) {
      return `执行记忆操作失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  getParameters(): ToolParameter[] {
    return [
      {
        name: "action",
        type: "string",
        description:
          "要执行的操作：add(添加记忆), search(搜索记忆), summary(获取摘要), stats(获取统计), update(更新记忆), remove(删除记忆), forget(遗忘记忆), consolidate(整合记忆), clear_all(清空所有记忆)",
        required: true,
      },
      { name: "content", type: "string", description: "记忆内容，add/update 时使用；感知记忆可作为描述", required: false },
      { name: "query", type: "string", description: "搜索查询，search 时使用", required: false },
      {
        name: "memory_type",
        type: "string",
        description: "记忆类型：working, episodic, semantic, perceptual",
        required: false,
        default: "working",
      },
      { name: "importance", type: "number", description: "重要性分数，0.0-1.0", required: false },
      { name: "limit", type: "integer", description: "搜索结果数量限制", required: false, default: 5 },
      { name: "memory_id", type: "string", description: "目标记忆ID，update/remove 时使用", required: false },
      { name: "file_path", type: "string", description: "感知记忆：本地文件路径", required: false },
      { name: "modality", type: "string", description: "感知记忆模态：text/image/audio/video", required: false },
      {
        name: "strategy",
        type: "string",
        description: "遗忘策略：importance_based/time_based/capacity_based",
        required: false,
        default: "importance_based",
      },
      { name: "threshold", type: "number", description: "遗忘阈值", required: false, default: 0.1 },
      { name: "max_age_days", type: "integer", description: "最大保留天数", required: false, default: 30 },
      { name: "from_type", type: "string", description: "整合来源类型", required: false, default: "working" },
      { name: "to_type", type: "string", description: "整合目标类型", required: false, default: "episodic" },
      { name: "importance_threshold", type: "number", description: "整合重要性阈值", required: false, default: 0.7 },
    ];
  }

  async autoRecordConversation(userInput: string, agentResponse: string): Promise<void> {
    this.conversationCount += 1;
    await this.addMemory({
      content: `用户: ${userInput}`,
      memoryType: "working",
      importance: 0.6,
    });
    await this.addMemory({
      content: `助手: ${agentResponse}`,
      memoryType: "working",
      importance: 0.7,
    });
    if (agentResponse.length > 100 || userInput.includes("重要") || userInput.includes("记住")) {
      await this.addMemory({
        content: `对话 - 用户: ${userInput}\n助手: ${agentResponse}`,
        memoryType: "episodic",
        importance: 0.8,
      });
    }
  }

  async addKnowledge(content: string, importance = 0.9): Promise<string> {
    return this.addMemory({ content, memoryType: "semantic", importance });
  }

  async getContextForQuery(query: string, limit = 3): Promise<string> {
    const results = await this.memoryManager.retrieveMemories({
      query,
      limit,
      minImportance: 0.3,
    });
    if (results.length === 0) {
      return "";
    }
    return ["相关记忆:", ...results.map((memory) => `- ${memory.content}`)].join("\n");
  }

  async clearSession(): Promise<void> {
    this.currentSessionId = undefined;
    this.conversationCount = 0;
    const workingMemory = this.memoryManager.memoryTypes.get("working");
    await workingMemory?.clear();
  }

  async consolidateMemories(): Promise<number> {
    return this.memoryManager.consolidateMemories();
  }

  async forgetOldMemories(maxAgeDays = 30): Promise<number> {
    return this.memoryManager.forgetMemories("time_based", 0.1, maxAgeDays);
  }

  private async addMemory(input: {
    content: string;
    memoryType: string;
    importance: number;
    filePath?: string;
    modality?: string;
  }): Promise<string> {
    if (!this.currentSessionId) {
      this.currentSessionId = `session_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    }

    const metadata: Record<string, unknown> = {
      session_id: this.currentSessionId,
      timestamp: new Date().toISOString(),
    };

    if (input.memoryType === "perceptual" && input.filePath) {
      metadata.modality = input.modality ?? inferModality(input.filePath);
      metadata.raw_data = input.filePath;
    }

    const memoryId = await this.memoryManager.addMemory({
      content: input.content,
      memoryType: input.memoryType,
      importance: input.importance,
      metadata,
      autoClassify: false,
    });
    return `记忆已添加 (ID: ${memoryId.slice(0, 8)}...)`;
  }

  private async searchMemory(input: {
    query: string;
    limit: number;
    memoryType?: string;
    minImportance: number;
  }): Promise<string> {
    const results = await this.memoryManager.retrieveMemories({
      query: input.query,
      limit: input.limit,
      memoryTypes: input.memoryType ? [input.memoryType] : undefined,
      minImportance: input.minImportance,
    });
    if (results.length === 0) {
      return `未找到与 '${input.query}' 相关的记忆`;
    }

    return [
      `找到 ${results.length} 条相关记忆:`,
      ...results.map((memory, index) => {
        const label = {
          working: "工作记忆",
          episodic: "情景记忆",
          semantic: "语义记忆",
          perceptual: "感知记忆",
        }[memory.memoryType] ?? memory.memoryType;
        const preview = memory.content.length > 80 ? `${memory.content.slice(0, 80)}...` : memory.content;
        return `${index + 1}. [${label}] ${preview} (重要性: ${memory.importance.toFixed(2)})`;
      }),
    ].join("\n");
  }

  private async getSummary(limit = 10): Promise<string> {
    const stats = await this.memoryManager.getMemoryStats();
    const lines = [
      "记忆系统摘要",
      `总记忆数: ${stats.total_memories}`,
      `当前会话: ${this.currentSessionId ?? "未开始"}`,
      `对话轮次: ${this.conversationCount}`,
      "",
      "记忆类型分布:",
    ];

    for (const [memoryType, typeStats] of Object.entries(stats.memories_by_type)) {
      const label = {
        working: "工作记忆",
        episodic: "情景记忆",
        semantic: "语义记忆",
        perceptual: "感知记忆",
      }[memoryType] ?? memoryType;
      lines.push(`  - ${label}: ${typeStats.count} 条 (平均重要性: ${Number(typeStats.avg_importance ?? 0).toFixed(2)})`);
    }

    const important = await this.memoryManager.retrieveMemories({
      query: "",
      limit: limit * 3,
      minImportance: 0.5,
    });
    const seen = new Set<string>();
    const unique = important.filter((memory) => {
      const key = memory.content.trim().toLowerCase();
      if (seen.has(memory.id) || seen.has(key)) {
        return false;
      }
      seen.add(memory.id);
      seen.add(key);
      return true;
    });

    if (unique.length > 0) {
      lines.push("", `重要记忆 (前${Math.min(limit, unique.length)}条):`);
      for (const [index, memory] of unique.slice(0, limit).entries()) {
        const preview = memory.content.length > 60 ? `${memory.content.slice(0, 60)}...` : memory.content;
        lines.push(`  ${index + 1}. ${preview} (重要性: ${memory.importance.toFixed(2)})`);
      }
    }

    return lines.join("\n");
  }

  private async getStats(): Promise<string> {
    const stats = await this.memoryManager.getMemoryStats();
    return [
      "记忆系统统计",
      `总记忆数: ${stats.total_memories}`,
      `启用的记忆类型: ${stats.enabled_types.join(", ")}`,
      `会话ID: ${this.currentSessionId ?? "未开始"}`,
      `对话轮次: ${this.conversationCount}`,
    ].join("\n");
  }

  private async updateMemory(input: {
    memoryId?: string;
    content?: string;
    importance?: number;
  }): Promise<string> {
    if (!input.memoryId) {
      return "缺少 memory_id";
    }
    const success = await this.memoryManager.updateMemory(input.memoryId, input.content, input.importance);
    return success ? "记忆已更新" : "未找到要更新的记忆";
  }

  private async removeMemory(memoryId?: string): Promise<string> {
    if (!memoryId) {
      return "缺少 memory_id";
    }
    const success = await this.memoryManager.removeMemory(memoryId);
    return success ? "记忆已删除" : "未找到要删除的记忆";
  }

  private async forget(strategy: string, threshold: number, maxAgeDays: number): Promise<string> {
    const count = await this.memoryManager.forgetMemories(strategy, threshold, maxAgeDays);
    return `已遗忘 ${count} 条记忆（策略: ${strategy}）`;
  }

  private async consolidate(fromType: string, toType: string, importanceThreshold: number): Promise<string> {
    const count = await this.memoryManager.consolidateMemories(fromType, toType, importanceThreshold);
    return `已整合 ${count} 条记忆为长期记忆（${fromType} -> ${toType}，阈值=${importanceThreshold}）`;
  }

  private async clearAll(): Promise<string> {
    await this.memoryManager.clearAllMemories();
    return "已清空所有记忆";
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readOptionalNumber(value: unknown): number | undefined {
  const parsed = readNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readInteger(value: unknown, fallback: number): number {
  const parsed = readNumber(value, Number.NaN);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function inferModality(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (["png", "jpg", "jpeg", "bmp", "gif", "webp"].includes(ext ?? "")) {
    return "image";
  }
  if (["mp3", "wav", "flac", "m4a", "ogg"].includes(ext ?? "")) {
    return "audio";
  }
  return "text";
}
