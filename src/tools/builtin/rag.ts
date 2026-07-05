import { HelloAgentsLLM } from "../../core/llm.js";
import { compressRankedItems, createRAGPipeline, mergeSnippetsGrouped } from "../../memory/rag/index.js";
import type { RAGPipeline, RAGPipelineOptions, RAGSearchResult, RAGVectorBackend } from "../../memory/rag/index.js";
import { Tool } from "../base.js";
import type { ToolParameter, ToolParameters } from "../base.js";

export interface RAGToolOptions {
  backend?: RAGVectorBackend;
  knowledgeBasePath?: string;
  qdrantUrl?: string;
  qdrantApiKey?: string;
  collectionName?: string;
  ragNamespace?: string;
  expandable?: boolean;
  llm?: HelloAgentsLLM;
}

export class RAGTool extends Tool {
  readonly backend: RAGVectorBackend;
  readonly knowledgeBasePath: string;
  readonly collectionName: string;
  readonly ragNamespace: string;

  private readonly options: RAGToolOptions;
  private readonly pipelines = new Map<string, RAGPipeline>();
  private llm?: HelloAgentsLLM;

  constructor(options: RAGToolOptions = {}) {
    super("rag", "RAG工具 - 添加知识库文本或文档，并基于知识库进行检索增强问答", options.expandable ?? false);
    const env = currentEnv();
    this.options = options;
    this.backend = options.backend ?? normalizeBackend(env.RAG_BACKEND);
    this.knowledgeBasePath = options.knowledgeBasePath ?? "./knowledge_base";
    this.collectionName = options.collectionName ?? env.RAG_COLLECTION ?? "hello_agents_rag_vectors";
    this.ragNamespace = options.ragNamespace ?? "default";
    this.llm = options.llm;
    this.pipelines.set(this.ragNamespace, this.createPipeline(this.ragNamespace));
  }

  async run(parameters: ToolParameters): Promise<string> {
    if (!this.validateParameters(parameters)) {
      return "参数验证失败：缺少必需的 action 参数";
    }

    const action = readString(parameters.action);
    try {
      if (action === "add_document") {
        return this.addDocument({
          filePath: readString(parameters.file_path) ?? readString(parameters.filePath),
          namespace: readString(parameters.namespace) ?? this.ragNamespace,
          chunkSize: readInteger(parameters.chunk_size, 800),
          chunkOverlap: readInteger(parameters.chunk_overlap, 100),
        });
      }
      if (action === "add_text") {
        return this.addText({
          text: readString(parameters.text),
          documentId: readString(parameters.document_id) ?? readString(parameters.documentId),
          namespace: readString(parameters.namespace) ?? this.ragNamespace,
          chunkSize: readInteger(parameters.chunk_size, 800),
          chunkOverlap: readInteger(parameters.chunk_overlap, 100),
        });
      }
      if (action === "search") {
        return this.search({
          query: readString(parameters.query) ?? readString(parameters.question),
          namespace: readString(parameters.namespace) ?? this.ragNamespace,
          limit: readInteger(parameters.limit, 5),
          minScore: readNumber(parameters.min_score, 0.1),
          enableAdvancedSearch: readBoolean(parameters.enable_advanced_search, true),
          includeCitations: readBoolean(parameters.include_citations, true),
          maxChars: readInteger(parameters.max_chars, 1200),
        });
      }
      if (action === "ask") {
        return this.ask({
          question: readString(parameters.question) ?? readString(parameters.query),
          namespace: readString(parameters.namespace) ?? this.ragNamespace,
          limit: readInteger(parameters.limit, 5),
          enableAdvancedSearch: readBoolean(parameters.enable_advanced_search, true),
          includeCitations: readBoolean(parameters.include_citations, true),
          maxChars: readInteger(parameters.max_chars, 1600),
        });
      }
      if (action === "stats") {
        return this.getStats(readString(parameters.namespace) ?? this.ragNamespace);
      }
      if (action === "clear") {
        return this.clearKnowledgeBase(
          readBoolean(parameters.confirm, false),
          readString(parameters.namespace) ?? this.ragNamespace,
        );
      }

      return `不支持的 RAG 操作: ${String(parameters.action)}`;
    } catch (error) {
      return `执行 RAG 操作失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  getParameters(): ToolParameter[] {
    return [
      {
        name: "action",
        type: "string",
        description: "操作类型：add_document, add_text, search, ask, stats, clear",
        required: true,
      },
      { name: "file_path", type: "string", description: "要添加到知识库的文本或 Markdown 文件路径", required: false },
      { name: "text", type: "string", description: "要添加到知识库的文本内容", required: false },
      { name: "document_id", type: "string", description: "文本知识的文档 ID", required: false },
      { name: "question", type: "string", description: "ask 操作中的用户问题", required: false },
      { name: "query", type: "string", description: "search 操作中的检索查询", required: false },
      { name: "namespace", type: "string", description: "知识库命名空间，用于隔离不同项目", required: false, default: "default" },
      { name: "limit", type: "integer", description: "返回结果数量", required: false, default: 5 },
      { name: "min_score", type: "number", description: "最低相似度分数", required: false, default: 0.1 },
      { name: "include_citations", type: "boolean", description: "是否包含引用来源", required: false, default: true },
      { name: "enable_advanced_search", type: "boolean", description: "是否启用 MQE/HyDE 查询扩展", required: false, default: true },
      { name: "max_chars", type: "integer", description: "检索上下文最大字符数", required: false, default: 1200 },
      { name: "chunk_size", type: "integer", description: "文档分块大小", required: false, default: 800 },
      { name: "chunk_overlap", type: "integer", description: "文档分块重叠大小", required: false, default: 100 },
      { name: "confirm", type: "boolean", description: "clear 操作确认参数", required: false, default: false },
    ];
  }

  async getRelevantContext(query: string, limit = 3, maxChars = 1200, namespace = this.ragNamespace): Promise<string> {
    return this.getPipeline(namespace).getRelevantContext(query, {
      limit,
      maxChars,
      namespace,
    });
  }

  private async addDocument(input: {
    filePath?: string;
    namespace: string;
    chunkSize: number;
    chunkOverlap: number;
  }): Promise<string> {
    if (!input.filePath) {
      return "缺少 file_path";
    }

    const pipeline = this.getPipeline(input.namespace);
    const startedAt = Date.now();
    const indexed = await pipeline.addDocuments([input.filePath], {
      namespace: input.namespace,
      chunkSize: input.chunkSize,
      chunkOverlap: input.chunkOverlap,
      sourceLabel: "rag",
    });

    if (indexed === 0) {
      return `未能从文件解析并索引有效内容: ${input.filePath}`;
    }

    return [
      `文档已添加到知识库: ${basename(input.filePath)}`,
      `分块数量: ${indexed}`,
      `处理时间: ${Date.now() - startedAt}ms`,
      `命名空间: ${input.namespace}`,
      `后端: ${pipeline.backend}`,
    ].join("\n");
  }

  private async addText(input: {
    text?: string;
    documentId?: string;
    namespace: string;
    chunkSize: number;
    chunkOverlap: number;
  }): Promise<string> {
    if (!input.text?.trim()) {
      return "文本内容不能为空";
    }

    const pipeline = this.getPipeline(input.namespace);
    const startedAt = Date.now();
    const indexed = await pipeline.addText(input.text, {
      documentId: input.documentId,
      namespace: input.namespace,
      chunkSize: input.chunkSize,
      chunkOverlap: input.chunkOverlap,
    });

    if (indexed === 0) {
      return "未能从文本生成有效分块";
    }

    return [
      `文本已添加到知识库: ${input.documentId ?? "inline_text"}`,
      `分块数量: ${indexed}`,
      `处理时间: ${Date.now() - startedAt}ms`,
      `命名空间: ${input.namespace}`,
      `后端: ${pipeline.backend}`,
    ].join("\n");
  }

  private async search(input: {
    query?: string;
    namespace: string;
    limit: number;
    minScore: number;
    enableAdvancedSearch: boolean;
    includeCitations: boolean;
    maxChars: number;
  }): Promise<string> {
    if (!input.query?.trim()) {
      return "搜索查询不能为空";
    }

    const pipeline = this.getPipeline(input.namespace);
    const results = input.enableAdvancedSearch
      ? await pipeline.searchAdvanced({
          query: input.query,
          topK: input.limit,
          scoreThreshold: input.minScore > 0 ? input.minScore : undefined,
          namespace: input.namespace,
          enableMqe: true,
          enableHyde: true,
        })
      : await pipeline.search({
          query: input.query,
          topK: input.limit,
          scoreThreshold: input.minScore > 0 ? input.minScore : undefined,
          namespace: input.namespace,
        });

    if (results.length === 0) {
      return `未找到与 '${input.query}' 相关的内容`;
    }

    const compressed = compressRankedItems(results);
    const context = mergeSnippetsGrouped(compressed, {
      maxChars: input.maxChars,
      includeCitations: input.includeCitations,
    });
    return [`搜索结果：`, context, "", this.formatScoreLines(compressed)].join("\n");
  }

  private async ask(input: {
    question?: string;
    namespace: string;
    limit: number;
    enableAdvancedSearch: boolean;
    includeCitations: boolean;
    maxChars: number;
  }): Promise<string> {
    if (!input.question?.trim()) {
      return "请提供要询问的问题";
    }

    const pipeline = this.getPipeline(input.namespace);
    const results = input.enableAdvancedSearch
      ? await pipeline.searchAdvanced({
          query: input.question,
          topK: input.limit,
          namespace: input.namespace,
          enableMqe: true,
          enableHyde: true,
        })
      : await pipeline.search({
          query: input.question,
          topK: input.limit,
          namespace: input.namespace,
        });

    if (results.length === 0) {
      return [
        `知识库中没有找到与「${input.question}」相关的信息。`,
        "建议：换一个更具体的关键词，或先用 add_text/add_document 添加相关资料。",
      ].join("\n");
    }

    const context = mergeSnippetsGrouped(compressRankedItems(results), {
      maxChars: input.maxChars,
      includeCitations: input.includeCitations,
    });
    const llm = this.getLLM();
    if (!llm) {
      return [
        "当前没有可用的 LLM 配置，无法执行 ask 生成答案。",
        "以下是已检索到的相关上下文：",
        context,
      ].join("\n\n");
    }

    const startedAt = Date.now();
    const answer = await llm.invoke([
      {
        role: "system",
        content:
          "你是一个可靠的知识库问答助手。必须严格基于用户提供的上下文回答；如果上下文不足，请明确说明不足，不要编造。",
      },
      {
        role: "user",
        content: `请基于以下上下文回答问题。\n\n【问题】${input.question}\n\n【上下文】\n${context}\n\n【要求】给出直接答案，并尽量指出依据来自哪些片段。`,
      },
    ]);

    return [
      "智能问答结果",
      "",
      answer.trim(),
      "",
      "参考上下文",
      context,
      "",
      `生成耗时: ${Date.now() - startedAt}ms`,
    ].join("\n");
  }

  private async getStats(namespace: string): Promise<string> {
    const pipeline = this.getPipeline(namespace);
    const stats = await pipeline.getStats();
    return [
      "RAG 知识库统计",
      `命名空间: ${namespace}`,
      `后端: ${stats.store_type}`,
      `集合名称: ${stats.collection_name ?? this.collectionName}`,
      `分块数: ${String(stats.chunks_count ?? stats.points_count ?? stats.vectors_count ?? 0)}`,
      `存储根路径: ${this.knowledgeBasePath}`,
    ].join("\n");
  }

  private async clearKnowledgeBase(confirm: boolean, namespace: string): Promise<string> {
    if (!confirm) {
      return "危险操作：清空知识库需要传入 confirm=true。";
    }
    const pipeline = this.getPipeline(namespace);
    await pipeline.clearNamespace(namespace);
    return `知识库已清空（命名空间：${namespace}，后端：${pipeline.backend}）`;
  }

  private getPipeline(namespace: string): RAGPipeline {
    const existing = this.pipelines.get(namespace);
    if (existing) {
      return existing;
    }
    const pipeline = this.createPipeline(namespace);
    this.pipelines.set(namespace, pipeline);
    return pipeline;
  }

  private createPipeline(namespace: string): RAGPipeline {
    const options: RAGPipelineOptions = {
      backend: this.backend,
      qdrantUrl: this.options.qdrantUrl,
      qdrantApiKey: this.options.qdrantApiKey,
      collectionName: this.collectionName,
      ragNamespace: namespace,
      llm: this.llm,
    };
    return createRAGPipeline(options);
  }

  private getLLM(): HelloAgentsLLM | undefined {
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

  private formatScoreLines(results: RAGSearchResult[]): string {
    return results
      .map((result, index) => {
        const source = readString(result.metadata.source_path) ?? readString(result.metadata.doc_id) ?? "source";
        return `${index + 1}. ${source} score=${result.score.toFixed(3)} vector=${result.vectorScore.toFixed(3)} graph=${result.graphScore.toFixed(3)}`;
      })
      .join("\n");
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readInteger(value: unknown, fallback: number): number {
  const parsed = readNumber(value, Number.NaN);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return ["true", "1", "yes", "y"].includes(value.toLowerCase());
  }
  return fallback;
}

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
}

function currentEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

function normalizeBackend(value: string | undefined): RAGVectorBackend {
  return value?.toLowerCase() === "qdrant" ? "qdrant" : "memory";
}
