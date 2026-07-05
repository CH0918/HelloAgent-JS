# 第 10 章：构建 RAG 知识库检索系统

前面几章我们已经有了几个基础能力：

- 第 1 章实现了 `HelloAgentsLLM`，可以调用真实模型。
- 第 2 章到第 6 章实现了 Agent 和工具调用。
- 第 7 章实现了 `SearchTool`，让 Agent 可以查外部信息。
- 第 8 章实现了工具链和异步工具执行。
- 第 9 章实现了记忆系统，可以保存和检索用户相关的长期信息。

这一章要实现的是另一类能力：RAG。

RAG 的全称是 Retrieval-Augmented Generation，中文通常叫“检索增强生成”。它解决的问题是：模型本身不知道某个私有知识库、产品手册、内部文档、客户故障手册里的内容，但是我们可以先从知识库中检索相关片段，再把这些片段作为上下文交给模型，让模型基于资料回答问题。

本章完成之后，你可以：

- 把一段文本加入知识库。
- 把本地文本或 Markdown 文件加入知识库。
- 把文档切成可检索的片段。
- 使用 embedding 把片段变成向量。
- 用内存后端跑通本地示例。
- 用 Qdrant 后端跑真实向量检索。
- 把 RAG 包装成 `RAGTool`，注册给 `FunctionCallAgent` 使用。

## 1. 为什么 RAG 不直接放进 MemoryTool

第 9 章已经有 `MemoryTool`。它也能存内容，也能检索内容。那为什么这一章还要单独实现 RAG？

因为记忆和知识库的职责不同。

记忆系统保存的是“和用户、对话、任务状态相关的信息”。例如：

- 用户偏好。
- 历史对话结论。
- 某次任务的中间进展。
- 某个客户之前确认过的规则。

RAG 知识库保存的是“外部事实材料”。例如：

- 产品帮助文档。
- 客服处理手册。
- 公司内部 SOP。
- 法务条款。
- API 文档。
- 故障排查 runbook。

这两类数据都能被检索，但不能混成一个东西。否则后面会出现几个问题：

- 用户记忆和知识库文档混在一起，权限边界不清楚。
- 清空某个知识库时可能误删用户长期记忆。
- 文档片段需要 `source_path`、`heading_path`、`start`、`end` 等引用信息，记忆不一定需要。
- RAG 检索经常要做查询扩展、片段合并、引用输出，记忆检索更关注用户状态和重要性。

所以本章采用单独分层：

```text
Agent
  -> RAGTool
    -> RAGPipeline
      -> DocumentProcessor
      -> EmbeddingModel
      -> memory backend 或 QdrantVectorStore
      -> ranking / merge snippets
```

这样 `MemoryTool` 和 `RAGTool` 都是普通工具，但底层数据和行为保持独立。

## 2. 本章新增目录结构

本章新增和修改这些文件：

```text
src/
  memory/
    rag/
      types.ts
      document.ts
      ranking.ts
      pipeline.ts
      index.ts
    index.ts
  tools/
    builtin/
      rag.ts
      index.ts
  memory/
    storage/
      qdrant-store.ts
  index.ts

examples/
  10-rag-system.mjs
  10-02-rag-qdrant-demo.mjs
  README.md
  .env.example

teach-doc/
  10-rag-system.md
```

每个文件的职责如下：

- `src/memory/rag/types.ts`：定义 RAG 文档、分块、检索结果和管线配置类型。
- `src/memory/rag/document.ts`：负责把原始文本或文件变成 `RAGChunk`。
- `src/memory/rag/ranking.ts`：负责把召回结果重新排序、压缩和合并成上下文。
- `src/memory/rag/pipeline.ts`：负责索引、检索、查询扩展、统计和清理命名空间。
- `src/memory/rag/index.ts`：统一导出 RAG 模块。
- `src/tools/builtin/rag.ts`：把 RAG 管线包装成 Agent 可调用的 `RAGTool`。
- `src/memory/storage/qdrant-store.ts`：新增按 payload filter 删除向量的方法。
- `examples/10-rag-system.mjs`：默认可跑的本地 RAG 示例。
- `examples/10-02-rag-qdrant-demo.mjs`：真实 Qdrant 后端示例。

## 3. RAG 的核心数据结构

先看 `src/memory/rag/types.ts`。

RAG 最重要的两个结构是 `RAGDocument` 和 `RAGChunk`。

`RAGDocument` 表示一篇原始文档：

```ts
export interface RAGDocument {
  content: string;
  metadata: Record<string, unknown>;
  docId: string;
}
```

它包含三部分：

- `content`：完整文档内容。
- `metadata`：来源、格式、业务标签等元数据。
- `docId`：文档 ID。

模型检索时不会直接检索整篇文档，因为整篇文档可能太长。我们需要把文档拆成较小的片段，也就是 `RAGChunk`：

```ts
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
```

这里多了几个字段：

- `id`：分块 ID，后面会写到向量库的 `memory_id`。
- `chunkIndex`：当前分块在文档里的顺序。
- `start` / `end`：分块在原文中的位置。
- `headingPath`：Markdown 标题路径，例如 `客户成功团队处理手册 > 数据同步问题`。

这些字段看起来只是细节，但对 RAG 很重要。最终回答用户时，我们不仅要给答案，还要能说明答案来自哪个文档、哪个章节、哪个位置。

## 4. 文档处理层 DocumentProcessor

文档处理层位于 `src/memory/rag/document.ts`。

最简单的文档处理方式是按固定字符数截断。但这样会破坏段落和标题结构。例如一段 Markdown：

```md
# 客户成功团队处理手册

## 数据同步问题

订单同步失败时，先查看同步任务日志。
授权过期时，刷新店铺授权后重跑失败批次。
```

如果强行每 100 个字符切一次，标题和正文可能被切散，检索结果就很难带上准确来源。

所以本章的处理流程是：

```text
原始文本
  -> splitParagraphsWithHeadings()
  -> chunkParagraphs()
  -> RAGChunk[]
```

`splitParagraphsWithHeadings()` 会识别 Markdown 标题：

```ts
export function splitParagraphsWithHeadings(text: string): Paragraph[] {
  const lines = text.split(/\r?\n/);
  const headings: string[] = [];
  const paragraphs: Paragraph[] = [];
  // ...
}
```

当遇到 `#`、`##`、`###` 这类标题时，它会更新标题栈。后续段落会带上当前标题路径。

例如：

```md
# 客户成功团队处理手册
## 数据同步问题
订单同步失败时，先查看同步任务日志。
```

会得到一个段落：

```ts
{
  content: "订单同步失败时，先查看同步任务日志。",
  headingPath: "客户成功团队处理手册 > 数据同步问题",
  start: 18,
  end: 39
}
```

然后 `DocumentProcessor.processDocument()` 会把段落合并成分块：

```ts
const processor = new DocumentProcessor({
  chunkSize: 800,
  chunkOverlap: 100,
});

const chunks = processor.processDocument(document);
```

这里的 `chunkSize` 是近似 token 数，不是精确模型 token。SDK 用 `estimateTokens()` 做轻量估算：

- CJK 字符按 1 个 token 估算。
- 英文和数字按空格分词估算。

这样设计的原因是：RAG 切块不需要每次都依赖 tokenizer 包。默认切块只要稳定、可解释、够用即可。

## 5. 为什么要保留 chunk metadata

每个分块写入向量库时，会带上这样的 metadata：

```ts
{
  memory_id: chunk.id,
  user_id: "rag_user",
  memory_type: "rag_chunk",
  content: chunk.content,
  data_source: "rag_pipeline",
  rag_namespace: namespace,
  is_rag_data: true,
  doc_id: chunk.docId,
  chunk_index: chunk.chunkIndex,
  start: chunk.start,
  end: chunk.end,
  heading_path: chunk.headingPath
}
```

这些字段有明确分工：

- `memory_type: "rag_chunk"`：让 Qdrant 里可以区分 RAG 数据和其他数据。
- `is_rag_data: true`：给 filter 一个明确标记。
- `data_source: "rag_pipeline"`：说明这条向量来自 RAG 管线。
- `rag_namespace`：隔离不同知识库。
- `content`：检索命中后可以直接拿回原文片段。
- `source_path` / `doc_id` / `heading_path`：输出引用时使用。

这样后面搜索时可以只查当前命名空间：

```ts
{
  memory_type: "rag_chunk",
  rag_namespace: namespace,
  is_rag_data: true,
  data_source: "rag_pipeline"
}
```

## 6. RAGPipeline 的两个后端

`src/memory/rag/pipeline.ts` 实现了 `RAGPipeline`。

这一版支持两个后端：

```ts
export type RAGVectorBackend = "memory" | "qdrant";
```

### memory 后端

`memory` 后端把向量存在进程内 Map 里：

```ts
private readonly localRecords = new Map<string, LocalVectorRecord>();
```

它的作用是让默认示例可以直接跑：

```ts
const pipeline = createRAGPipeline({
  backend: "memory",
  ragNamespace: "support_rag_demo",
});
```

不需要 Qdrant，也不需要真实 LLM。配合 `EMBED_MODEL_TYPE=tfidf`，你可以先验证整个 RAG 流程。

注意，`memory` 后端不是生产存储。进程重启后数据会消失。它适合本地学习、单文件验证和 examples。

### qdrant 后端

`qdrant` 后端使用第 9 章已经实现的 `QdrantVectorStore`：

```ts
const pipeline = createRAGPipeline({
  backend: "qdrant",
  collectionName: "hello_agents_rag_vectors",
  ragNamespace: "support_docs",
});
```

它会把分块向量写入 Qdrant，适合真实知识库。

## 7. 添加文本到知识库

最小用法是 `addText()`：

```ts
const pipeline = createRAGPipeline({
  backend: "memory",
  ragNamespace: "support_docs",
});

await pipeline.addText(
  `
# 订单同步失败导致销售报表缺数

当订单同步任务失败时，先查看同步任务日志。
如果失败原因是店铺授权过期，需要刷新授权，再重跑订单同步任务。
同步完成后，要触发销售报表补算任务。
`,
  {
    documentId: "order-sync-playbook",
    namespace: "support_docs",
    metadata: {
      source_path: "support://order-sync-playbook",
    },
  },
);
```

这段代码背后发生了几件事：

1. `addText()` 创建一个 `RAGDocument`。
2. `DocumentProcessor` 把文档切成 `RAGChunk[]`。
3. `preprocessMarkdownForEmbedding()` 清理 Markdown 标记，保留语义文本。
4. `getTextEmbedder()` 获取 embedding 模型。
5. 每个分块生成向量。
6. 根据后端写入内存 Map 或 Qdrant。

`preprocessMarkdownForEmbedding()` 不会改变最终返回给用户的原始片段。它只用于让 embedding 输入更干净。

## 8. 添加文件到知识库

如果你有本地 `.txt` 或 `.md` 文件，可以用：

```ts
await pipeline.addDocuments(["./docs/support-runbook.md"], {
  namespace: "support_docs",
  chunkSize: 800,
  chunkOverlap: 100,
});
```

当前 TypeScript 第一版只内置文本和 Markdown 文件读取。PDF、Office、图片 OCR、音频转写这些能力没有放进第一版核心，原因是它们会引入很重的依赖，而且不同项目的文件解析策略差异很大。

如果后续要支持多格式文件，推荐扩展点是文档进入 `RAGPipeline` 之前：

```text
PDF / Word / HTML / 图片
  -> 业务自己的解析器
  -> markdown/text
  -> pipeline.addText(...)
```

这样 RAG 核心不需要绑定某个具体解析库。

## 9. 基础检索 search()

文档加入知识库后，可以直接检索：

```ts
const results = await pipeline.search({
  query: "授权过期导致订单同步失败怎么办",
  topK: 3,
  namespace: "support_docs",
});
```

基础检索流程是：

```text
用户 query
  -> embedQuery()
  -> 后端向量检索
  -> computeGraphSignalsFromHits()
  -> rankVectorHits()
  -> RAGSearchResult[]
```

`RAGSearchResult` 的结构是：

```ts
export interface RAGSearchResult {
  memoryId: string;
  score: number;
  vectorScore: number;
  graphScore: number;
  content: string;
  metadata: Record<string, unknown>;
}
```

`vectorScore` 来自向量相似度。`graphScore` 这里不是 Neo4j 图数据库分数，而是一个轻量的“同文档密度和邻近片段信号”：

- 同一个文档里多个片段都命中，说明这个文档整体更相关。
- 命中的片段位置相近，说明它们可能属于同一个上下文段落。

最后的综合分数是：

```text
score = 0.7 * vectorScore + 0.3 * graphScore
```

这不是最终真理，只是一个清晰可解释的默认排序规则。

## 10. 高级检索 searchAdvanced()

`searchAdvanced()` 在基础检索前增加查询扩展：

```ts
const results = await pipeline.searchAdvanced({
  query: "销售报表缺数怎么恢复",
  topK: 4,
  namespace: "support_docs",
  enableMqe: true,
  enableHyde: true,
});
```

它支持两个策略：

- MQE：让 LLM 生成多个语义等价或互补查询。
- HyDE：让 LLM 先写一段可能的答案性段落，再用这段段落做检索。

这两个策略都依赖 `HelloAgentsLLM`。如果当前没有可用 LLM 配置，`searchAdvanced()` 不会失败，而是自动退回原始 query。

这样设计是为了保证：RAG 的基础检索永远可用，高级查询扩展只是增强，不是硬依赖。

## 11. 片段压缩和引用合并

检索到的片段不能直接全部塞进 prompt。我们需要压缩和合并。

`src/memory/rag/ranking.ts` 提供了两个常用函数：

```ts
const compressed = compressRankedItems(results);

const context = mergeSnippetsGrouped(compressed, {
  maxChars: 1200,
  includeCitations: true,
});
```

`compressRankedItems()` 做两件事：

- 同一文档里相邻的片段会尽量合并。
- 每个文档最多保留少量高分片段，避免一个文档占满上下文。

`mergeSnippetsGrouped()` 会输出带引用的上下文：

```text
订单同步失败时，先查看同步任务日志。 [1]

授权过期时，刷新店铺授权后重跑失败批次。 [2]

References:
[1] support://order-sync-playbook (0-58) - 订单同步失败导致销售报表缺数
[2] support://order-sync-playbook (59-112) - 订单同步失败导致销售报表缺数
```

这个字符串可以直接放进 LLM prompt。

## 12. RAGTool 的工具定义

Agent 不应该直接操作 `RAGPipeline`。Agent 看到的应该是一个工具。

这一章新增 `src/tools/builtin/rag.ts`：

```ts
export class RAGTool extends Tool {
  constructor(options: RAGToolOptions = {}) {
    super("rag", "RAG工具 - 添加知识库文本或文档，并基于知识库进行检索增强问答");
  }
}
```

它的工具名是 `rag`。

`getParameters()` 会声明工具参数：

```ts
{
  name: "action",
  type: "string",
  description: "操作类型：add_document, add_text, search, ask, stats, clear",
  required: true,
}
```

主要 action 有：

- `add_text`：添加文本到知识库。
- `add_document`：添加本地文本或 Markdown 文件。
- `search`：只检索，不调用 LLM 生成答案。
- `ask`：先检索，再把上下文交给 LLM 生成答案。
- `stats`：查看知识库统计。
- `clear`：清空某个 namespace。

## 13. RAGTool 的执行流程

当 Agent 调用：

```json
{
  "action": "search",
  "query": "授权过期导致订单同步失败怎么办",
  "namespace": "support_docs",
  "limit": 3
}
```

`RAGTool.run()` 会执行：

```text
run()
  -> read action
  -> search()
    -> getPipeline(namespace)
    -> pipeline.searchAdvanced() 或 pipeline.search()
    -> compressRankedItems()
    -> mergeSnippetsGrouped()
    -> 返回字符串结果
```

当 Agent 调用：

```json
{
  "action": "ask",
  "question": "销售报表缺数应该怎么恢复？",
  "namespace": "support_docs"
}
```

`RAGTool` 会执行：

```text
ask()
  -> 检索相关片段
  -> 合并成上下文
  -> 构造 system/user prompt
  -> HelloAgentsLLM.invoke()
  -> 返回答案 + 参考上下文
```

如果当前没有可用 LLM 配置，`ask` 不会直接崩溃，而是返回已检索到的上下文，并告诉你没有可用 LLM 配置。

## 14. Agent 如何注册 RAGTool

`RAGTool` 继承自 `Tool`，所以和前面的工具注册流程完全一致。

```ts
import { FunctionCallAgent, HelloAgentsLLM, RAGTool } from "helloagent-js";

const llm = new HelloAgentsLLM();

const agent = new FunctionCallAgent({
  llm,
  systemPrompt: "你是客服知识库助手，需要先检索知识库，再回答客户问题。",
});

agent.addTool(
  new RAGTool({
    backend: "qdrant",
    collectionName: "hello_agents_rag_vectors",
    ragNamespace: "support_docs",
  }),
);
```

注册后，`FunctionCallAgent` 会调用：

```ts
this.toolRegistry.getOpenAIToolSchemas()
```

`RAGTool.toOpenAISchema()` 会把参数定义转换成 OpenAI-compatible tools schema。模型看到工具说明后，可以返回原生 `tool_calls`。Agent 收到 `tool_calls` 后，会通过：

```ts
executeRegisteredToolWithParameters(this.toolRegistry, toolName, parsedArguments)
```

执行 `RAGTool.run()`，再把工具结果作为 `role: "tool"` 消息回填给模型。最后模型基于工具结果生成最终回答。

这一条链路和第 6 章的 `FunctionCallAgent` 完全一致。

## 15. 清空知识库为什么只清 namespace

RAG 工具有 `clear` 操作，但它不会直接删除整个 Qdrant collection。

原因是同一个 collection 里可能有多个 namespace：

```text
hello_agents_rag_vectors
  - support_docs
  - legal_docs
  - api_docs
```

如果清空 `support_docs` 时直接删 collection，就会误删 `legal_docs` 和 `api_docs`。

所以本章给 `QdrantVectorStore` 增加了：

```ts
async deleteByFilter(where: Record<string, unknown>): Promise<void>
```

RAG 清理时使用：

```ts
await store.deleteByFilter({
  memory_type: "rag_chunk",
  rag_namespace: namespace,
  is_rag_data: true,
  data_source: "rag_pipeline",
});
```

这样只删除当前 RAG namespace 的数据。

## 16. 默认示例：memory 后端

默认示例是：

```text
examples/10-rag-system.mjs
```

运行：

```bash
pnpm build
node examples/10-rag-system.mjs
```

这个示例会：

1. 设置 `EMBED_MODEL_TYPE=tfidf`。
2. 创建 `createRAGPipeline({ backend: "memory" })`。
3. 添加三段客服处理手册。
4. 搜索“订单同步失败后，销售报表缺数应该如何恢复？”。
5. 打印命中的片段、分数和来源。
6. 再创建 `RAGTool`，验证工具形态的 `add_text` 和 `search`。

这条路径不需要 Qdrant，不需要真实模型，适合作为第一条验证路径。

## 17. Qdrant 示例

真实向量库示例是：

```text
examples/10-02-rag-qdrant-demo.mjs
```

运行前需要准备 Qdrant：

```bash
docker run -p 6333:6333 qdrant/qdrant
```

并在 `examples/.env` 中配置：

```env
EMBED_MODEL_TYPE=tfidf
EMBED_DIMENSION=384
QDRANT_URL=http://localhost:6333
RAG_COLLECTION=hello_agents_rag_vectors
```

运行：

```bash
pnpm build
node examples/10-02-rag-qdrant-demo.mjs
```

如果要换成真实 embedding 服务，可以改成 OpenAI-compatible：

```env
EMBED_MODEL_TYPE=openai_compatible
EMBED_MODEL_NAME=text-embedding-3-small
EMBED_API_KEY=你的 key
EMBED_BASE_URL=https://api.openai.com/v1
EMBED_DIMENSION=1536
QDRANT_VECTOR_SIZE=1536
```

注意：`QDRANT_VECTOR_SIZE` 必须和 embedding 输出维度一致。维度不一致时，Qdrant 写入会跳过不匹配的向量。

## 18. 本章完成后的导出

现在可以从 SDK 顶层导入：

```ts
import {
  RAGTool,
  RAGPipeline,
  createRAGPipeline,
  DocumentProcessor,
  mergeSnippetsGrouped,
  compressRankedItems,
} from "helloagent-js";
```

也可以只使用工具：

```ts
import { RAGTool } from "helloagent-js";
```

如果你只想构建自己的业务 RAG 服务，不接 Agent，可以直接用 `createRAGPipeline()`。

如果你想让 Agent 自己决定什么时候检索知识库，就注册 `RAGTool`。

## 19. 本章实现边界

这一章没有一次性实现所有高级 RAG 能力。

已经实现：

- 文本和 Markdown 处理。
- heading-aware chunk。
- 内存后端。
- Qdrant 后端。
- embedding 复用。
- namespace 隔离。
- 基础检索。
- MQE/HyDE 可选查询扩展。
- 轻量图信号排序。
- 片段压缩和引用输出。
- `RAGTool`。
- 默认 example 和 Qdrant example。

暂时没有实现：

- PDF/Word/Excel/PPT 解析。
- 图片 OCR。
- 音频转写。
- cross-encoder rerank。
- Neo4j GraphRAG。
- 文档版本管理。
- 多租户权限系统。

这些不是不要做，而是不适合塞进第一版核心。RAG 的第一版应该先把最重要的链路跑通：

```text
文档 -> 分块 -> 向量 -> 检索 -> 上下文 -> Agent 工具
```

等这条链路稳定之后，再加文件解析、重排、图谱和权限会更稳。

## 20. 验证命令

本章实现后，至少运行：

```bash
pnpm typecheck
pnpm build
node --check examples/10-rag-system.mjs
node examples/10-rag-system.mjs
```

如果本地有 Qdrant，再运行：

```bash
node --check examples/10-02-rag-qdrant-demo.mjs
node examples/10-02-rag-qdrant-demo.mjs
```

默认示例通过后，说明 RAG 的内存检索链路、`RAGPipeline` 和 `RAGTool` 都能工作。

Qdrant 示例通过后，说明真实向量库写入、命名空间过滤和检索链路也能工作。
