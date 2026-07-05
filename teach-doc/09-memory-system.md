# 从0构建SDK第9节：给 Agent 加上完整记忆系统

前面几节我们已经完成了 LLM 调用、Agent 基类、工具系统、函数调用 Agent、搜索工具、工具链和异步工具。到这里，SDK 已经可以完成一次任务，但它仍然缺少一个关键能力：记住长期信息。

一个只依赖当前输入的 Agent，每次运行都像第一次见到用户。它不知道用户偏好，不知道以前发生过什么，也无法把抽象知识、具体经历和多模态资料分开管理。记忆系统要解决的就是这个问题。

本章要实现的是 SDK 的第一阶段记忆系统，包含四类记忆：

1. 工作记忆 `WorkingMemory`：保存当前会话里最短期、最常用的上下文。
2. 情景记忆 `EpisodicMemory`：保存具体事件、会话片段、经历和时间线。
3. 语义记忆 `SemanticMemory`：保存概念、实体、事实和关系。
4. 感知记忆 `PerceptualMemory`：保存文本、图片、音频、视频等多模态输入。

除了四类记忆，本章还会实现三类底层存储能力：

- SQLite 文档存储：作为结构化记忆的权威数据源。
- Qdrant 向量存储：负责相似度检索。
- Neo4j 图存储：负责实体关系和知识图谱检索。

最后，我们会把记忆系统包装成 `MemoryTool`，让 `FunctionCallAgent` 可以像调用搜索工具一样调用记忆工具。

## 1. 本章目标

完成本章后，SDK 会新增这些能力：

- 可以从 `helloagent-js` 导入 `MemoryConfig`、`MemoryItem`、`MemoryManager`。
- 可以直接使用 `WorkingMemory`、`EpisodicMemory`、`SemanticMemory`、`PerceptualMemory`。
- 可以使用 `MemoryTool` 给 Agent 注册记忆能力。
- 工作记忆不依赖任何外部服务，默认即可运行。
- 情景记忆使用 SQLite 保存完整记录，并使用 Qdrant 做向量召回。
- 语义记忆使用 Qdrant 做文本向量召回，并使用 Neo4j 保存实体和关系。
- 感知记忆按模态拆分 Qdrant 集合，避免不同模态向量混在同一个集合里。
- Embedding 层支持 OpenAI-compatible 远程服务、本地 transformer 和 TF-IDF 风格兜底。
- examples 里提供一个可以直接运行的记忆系统示例。

这一章仍然遵守 SDK 的基本原则：上层 API 要简单，底层实现要分层。用户可以只使用 `MemoryTool`，也可以直接使用某一种记忆类型。

## 2. 目录结构

本章新增的目录结构如下：

```text
src/
├── core/
│   └── database-config.ts
├── memory/
│   ├── base.ts
│   ├── embedding.ts
│   ├── index.ts
│   ├── manager.ts
│   ├── utils.ts
│   ├── storage/
│   │   ├── document-store.ts
│   │   ├── index.ts
│   │   ├── neo4j-store.ts
│   │   └── qdrant-store.ts
│   └── types/
│       ├── episodic.ts
│       ├── index.ts
│       ├── perceptual.ts
│       ├── semantic.ts
│       └── working.ts
└── tools/
    └── builtin/
        └── memory.ts
```

每个文件负责一层清晰的职责：

- `src/memory/base.ts` 定义记忆系统的基础类型，例如 `MemoryItem`、`MemoryConfig` 和 `BaseMemory`。
- `src/memory/embedding.ts` 统一封装文本向量模型。
- `src/memory/storage/document-store.ts` 封装 SQLite 文档存储。
- `src/memory/storage/qdrant-store.ts` 封装 Qdrant REST API。
- `src/memory/storage/neo4j-store.ts` 封装 Neo4j 图数据库。
- `src/memory/types/working.ts` 实现短期工作记忆。
- `src/memory/types/episodic.ts` 实现情景记忆。
- `src/memory/types/semantic.ts` 实现语义记忆。
- `src/memory/types/perceptual.ts` 实现感知记忆。
- `src/memory/manager.ts` 把多种记忆统一管理起来。
- `src/tools/builtin/memory.ts` 把记忆系统包装成 Agent 可调用的工具。

这个拆法有一个好处：每一层都可以单独使用，也可以组合使用。比如只想在当前进程里做短期上下文，就只启用 `WorkingMemory`。如果要做长期知识库，就启用 `SemanticMemory` 和外部数据库。

## 3. 先写基础类型

记忆系统的核心数据结构是 `MemoryItem`。无论是工作记忆、情景记忆、语义记忆还是感知记忆，最终都要保存成一个统一对象：

```ts
export class MemoryItem {
  id: string;
  content: string;
  memoryType: string;
  userId: string;
  timestamp: Date;
  importance: number;
  metadata: MemoryMetadata;
}
```

这些字段的含义如下：

- `id` 是记忆 ID。调用方可以手动传入，也可以让 SDK 自动生成。
- `content` 是记忆正文。它可以是一句话、一段对话摘要，也可以是图片或音频的描述。
- `memoryType` 表示记忆类型，例如 `working`、`episodic`、`semantic`、`perceptual`。
- `userId` 用来隔离不同用户的记忆。
- `timestamp` 记录记忆创建或更新的时间。
- `importance` 是重要性分数，范围是 0 到 1。
- `metadata` 存放扩展字段，例如 `session_id`、`tags`、`modality`、`raw_data`。

接着是 `MemoryConfig`：

```ts
export class MemoryConfig {
  storagePath: string;
  maxCapacity: number;
  importanceThreshold: number;
  decayFactor: number;
  workingMemoryCapacity: number;
  workingMemoryTokens: number;
  workingMemoryTtlMinutes: number;
  perceptualMemoryModalities: string[];
}
```

这里有两类配置。

第一类是通用配置：

- `storagePath` 决定 SQLite 文件和本地数据放在哪里。
- `maxCapacity` 是统计和遗忘策略会使用的容量上限。
- `importanceThreshold` 是默认重要性阈值。
- `decayFactor` 用来计算时间衰减。

第二类是具体记忆类型配置：

- `workingMemoryCapacity` 控制工作记忆最多保留多少条。
- `workingMemoryTokens` 控制工作记忆的估算 token 上限。
- `workingMemoryTtlMinutes` 控制工作记忆的默认过期时间。
- `perceptualMemoryModalities` 控制感知记忆支持哪些模态。

最后是 `BaseMemory`。它规定每一种记忆类型都必须实现同一组方法：

```ts
abstract add(memoryItem: MemoryItem): Promise<string>;
abstract retrieve(query: string, limit?: number, options?: RetrieveMemoryOptions): Promise<MemoryItem[]>;
abstract update(memoryId: string, content?: string, importance?: number, metadata?: MemoryMetadata): Promise<boolean>;
abstract remove(memoryId: string): Promise<boolean>;
abstract hasMemory(memoryId: string): Promise<boolean>;
abstract clear(): Promise<void>;
abstract getStats(): Promise<MemoryStats>;
abstract getAll(): Promise<MemoryItem[]>;
```

这样上层的 `MemoryManager` 不需要关心底层到底是内存、SQLite、Qdrant 还是 Neo4j。只要某个类继承 `BaseMemory`，就可以被统一管理。

## 4. 数据库配置

记忆系统会连接 Qdrant 和 Neo4j，所以我们先在 `src/core/database-config.ts` 里集中处理数据库配置。

Qdrant 配置包含：

```ts
export interface QdrantConfig {
  url?: string;
  apiKey?: string;
  collectionName: string;
  vectorSize: number;
  distance: "cosine" | "dot" | "euclidean";
  timeout: number;
}
```

Neo4j 配置包含：

```ts
export interface Neo4jConfig {
  uri: string;
  username: string;
  password: string;
  database: string;
  maxConnectionLifetime: number;
  maxConnectionPoolSize: number;
  connectionAcquisitionTimeout: number;
}
```

配置从环境变量读取：

```text
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=hello_agents_vectors
QDRANT_VECTOR_SIZE=
QDRANT_DISTANCE=cosine
QDRANT_TIMEOUT=30

NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=hello-agents-password
NEO4J_DATABASE=neo4j
```

同时 SDK 暴露 `getDatabaseConfig()` 和 `updateDatabaseConfig()`。这样用户既可以通过 `.env` 配置，也可以在代码里临时覆盖：

```ts
import { updateDatabaseConfig } from "helloagent-js";

updateDatabaseConfig({
  qdrant: {
    url: "http://localhost:6333",
    collectionName: "my_vectors",
  },
});
```

集中配置的好处是，情景记忆、语义记忆、感知记忆都会拿到同一套数据库连接信息，避免每个类重复读取环境变量。

## 5. Embedding 层

向量检索的前提是先把文本变成向量。本章的 `src/memory/embedding.ts` 定义了统一接口：

```ts
export interface EmbeddingModel {
  readonly dimension: number;
  encode(input: EmbeddingInput): Promise<number[] | number[][]>;
}
```

当前实现包含三类模型：

- `OpenAICompatibleEmbedding`：通过 OpenAI-compatible REST 接口调用远程 embedding 服务，OpenRouter、OpenAI-compatible 网关和 DashScope 都可以走这条请求形状。
- `DashScopeEmbedding`：为了兼容旧配置保留的包装类，本质上也是 OpenAI-compatible 请求，只是默认模型、base URL 和维度使用 DashScope 的默认值。
- `LocalTransformerEmbedding`：通过 `@xenova/transformers` 在本地生成文本向量。
- `TFIDFEmbedding`：不依赖外部模型的兜底实现，使用确定性哈希向量保证示例可运行。

选择模型的环境变量是：

```text
EMBED_MODEL_TYPE=openai_compatible
EMBED_MODEL_NAME=text-embedding-3-small
EMBED_API_KEY=your-api-key
EMBED_BASE_URL=https://api.openai.com/v1
EMBED_DIMENSION=1536
```

如果使用 OpenRouter，可以写成：

```text
EMBED_MODEL_TYPE=openrouter
EMBED_MODEL_NAME=openai/text-embedding-3-small
EMBED_API_KEY=your-openrouter-api-key
EMBED_BASE_URL=https://openrouter.ai/api/v1
EMBED_DIMENSION=1536
```

如果要完全离线验证，可以设置：

```text
EMBED_MODEL_TYPE=tfidf
EMBED_DIMENSION=384
```

这里的 TF-IDF 风格实现和生产级 embedding 不是同一个质量等级。它的作用是让本地示例和记忆链路可以跑通。当你要做真实语义检索时，应该使用 OpenAI-compatible 远程 embedding 服务或本地 transformer。

还有一个容易忽略的点：Qdrant collection 的向量维度必须和当前 embedding 模型的输出维度一致。现在 SDK 先读 `QDRANT_VECTOR_SIZE`，如果没填就读 `EMBED_DIMENSION`，最后才回到默认 384。默认 TF-IDF 和本地 transformer 是 384 维，DashScope 默认是 1024 维，常见 OpenAI-compatible embedding 模型可能是 1536 或 3072 维。维度不一致时，Qdrant 层会跳过这条向量，结构化记忆仍会写入 SQLite，但向量召回不会命中。

所有记忆类型都通过 `getTextEmbedder()` 获取文本向量模型。这样以后如果要替换 embedding provider，只需要改 `embedding.ts`，不需要改四类记忆。

## 6. SQLite 文档存储

情景记忆和感知记忆都需要保存完整原文、metadata、时间戳和重要性。向量数据库适合召回，但不适合作为唯一事实来源。所以我们实现了 `SQLiteDocumentStore`，让 SQLite 成为结构化记录的权威存储。

`SQLiteDocumentStore` 位于 `src/memory/storage/document-store.ts`，核心接口是：

```ts
export interface DocumentStore {
  addMemory(memory: MemoryItem): Promise<string>;
  getMemory(memoryId: string): Promise<StoredMemory | undefined>;
  searchMemories(options?: SearchMemoriesOptions): Promise<StoredMemory[]>;
  updateMemory(memoryId: string, updates: Partial<StoredMemory>): Promise<boolean>;
  deleteMemory(memoryId: string): Promise<boolean>;
  getDatabaseStats(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
```

SQLite 里会创建这些表：

- `users`：用户信息。
- `memories`：所有记忆主表。
- `concepts`：概念节点。
- `memory_concepts`：记忆和概念之间的关系。
- `concept_relationships`：概念之间的关系。

这里使用的是 `better-sqlite3`，但它被放在 `optionalDependencies` 里，并通过动态导入加载。原因是并不是所有用户都需要长期记忆，如果只用 `WorkingMemory`，不应该强制安装 SQLite 原生依赖。

## 7. Qdrant 向量存储

Qdrant 负责相似度检索。本章没有引入额外的 Qdrant npm 包，而是直接封装 Qdrant REST API。这样运行时依赖更少，也更容易和本地 Docker 或云服务对接。

`QdrantVectorStore` 提供这些能力：

- 确保 collection 存在。
- 创建常用 payload 索引。
- 写入向量和 metadata。
- 按向量检索相似记忆。
- 按 `memory_id` 删除向量。
- 清空 collection。
- 获取 collection 统计。
- 执行健康检查。

因为不同记忆类型可能复用同一个 Qdrant 服务，所以我们还实现了 `QdrantConnectionManager`。它按连接信息和 collection 名称缓存 `QdrantVectorStore` 实例，避免重复初始化。

Qdrant 中 payload 会保存这些信息：

```ts
{
  memory_id: memory.id,
  content: memory.content,
  memory_type: memory.memoryType,
  user_id: memory.userId,
  importance: memory.importance,
  timestamp: memory.timestamp.toISOString(),
  metadata: memory.metadata
}
```

检索时，Qdrant 返回的是向量分数和 payload。上层记忆类型会再结合重要性、时间衰减、图关系等因素重新排序。

## 8. Neo4j 图存储

语义记忆不只关心文本相似度，还关心实体之间的关系。例如：

```text
李明是腾讯的资深工程师，擅长 TypeScript 和机器学习。
```

这里可以抽出几个实体：

- 李明
- 腾讯
- TypeScript
- 机器学习

它们之间可以形成图关系。`Neo4jGraphStore` 负责把实体和关系写入 Neo4j，并提供图检索能力。

核心方法包括：

```ts
addEntity(entity): Promise<void>;
addRelationship(relationship): Promise<void>;
findRelatedEntities(entityName, depth, limit): Promise<unknown[]>;
searchEntitiesByName(name, limit): Promise<unknown[]>;
getEntityRelationships(entityId): Promise<unknown[]>;
deleteEntity(entityId): Promise<boolean>;
clearAll(): Promise<void>;
getStats(): Promise<Record<string, unknown>>;
healthCheck(): Promise<boolean>;
```

Neo4j 连接使用 `neo4j-driver`，同样放在 `optionalDependencies` 里，并通过动态导入加载。只有当用户启用 `SemanticMemory`，并实际需要图数据库时，才需要安装和启动 Neo4j。

## 9. 工作记忆 WorkingMemory

工作记忆是最轻量的一类记忆。它不依赖 SQLite、Qdrant 或 Neo4j，只保存在当前进程内。

适合放在工作记忆里的内容包括：

- 当前对话里用户刚刚提到的偏好。
- 本轮任务中临时需要引用的约束。
- Agent 刚刚得出的中间结论。
- 最近几轮对话摘要。

`WorkingMemory` 的写入流程是：

1. 接收 `MemoryItem`。
2. 按 `memory.id` 放入 Map。
3. 更新访问时间和访问次数。
4. 执行容量、token 和 TTL 清理。

检索流程是：

1. 先过滤过期记忆和低重要性记忆。
2. 计算查询和记忆内容的轻量相似度。
3. 结合重要性、访问次数、时间衰减排序。
4. 返回前 `limit` 条。

工作记忆还提供几个辅助方法：

- `getRecent(limit)` 获取最近记忆。
- `getImportant(limit)` 获取重要记忆。
- `getContextSummary(limit)` 生成可塞进 prompt 的上下文摘要。
- `forget(strategy, threshold, maxAgeDays)` 按策略遗忘。

因为它完全本地运行，所以 examples 默认只验证 `WorkingMemory` 和 `MemoryTool`。这条路径不需要任何数据库服务。

## 10. 情景记忆 EpisodicMemory

情景记忆保存的是具体发生过的事情。它和工作记忆最大的区别是：情景记忆应该可以长期保留，并且支持按语义召回。

典型情景记忆包括：

- 用户上次说他正在做某个项目。
- Agent 之前给过某个方案。
- 某次线上问题复盘。
- 某个会话里的关键结论。

`EpisodicMemory` 使用两层存储：

- SQLite 保存完整记忆记录，作为权威数据。
- Qdrant 保存向量索引，负责相似度召回。

写入流程如下：

1. 确保 `memoryType` 是 `episodic`。
2. 把 `session_id`、`tags`、时间戳等信息保存到 metadata。
3. 写入 SQLite。
4. 使用 `getTextEmbedder()` 生成文本向量。
5. 把向量和 payload 写入 Qdrant。

检索流程如下：

1. 对查询文本生成 embedding。
2. 在 Qdrant 中执行向量检索。
3. 拿到候选 `memory_id` 后，从 SQLite 读取完整记录。
4. 结合向量分数、时间衰减、重要性重新排序。
5. 如果 Qdrant 不可用，退回 SQLite 的关键词过滤。

为什么不是只用 Qdrant？

因为向量数据库里的 payload 适合召回，不适合作为唯一权威记录。更新、删除、按时间范围过滤、按 session 查询，这些操作在 SQLite 里更稳定。Qdrant 只承担索引角色，SQLite 才保存完整事实。

## 11. 语义记忆 SemanticMemory

语义记忆保存的是抽象知识。它关注“什么是什么”“谁和谁有关”“概念之间有什么关系”。

适合放在语义记忆里的内容包括：

- 用户的长期偏好。
- 项目里的业务规则。
- 技术概念和定义。
- 人、公司、技术栈之间的关系。

`SemanticMemory` 使用 Qdrant 和 Neo4j：

- Qdrant 负责根据查询文本召回相似知识。
- Neo4j 负责保存实体、关系和图搜索结果。

写入流程如下：

1. 保存原始 `MemoryItem`。
2. 使用 embedding 生成文本向量。
3. 从文本中抽取实体。
4. 根据实体共现生成关系。
5. 把实体和关系写入 Neo4j。
6. 把文本向量写入 Qdrant。

当前 TypeScript 实现使用轻量规则抽取实体。它会识别中文短语、英文长词和技术词，并把它们转成 `Entity`。这样可以保证 SDK 不强制绑定大型 NLP 依赖。后续如果要接入更强的实体抽取模型，可以替换 `SemanticMemory` 内部的抽取方法，不影响外部 API。

检索流程如下：

1. 对查询做向量检索，得到 Qdrant 候选。
2. 对查询抽取实体，到 Neo4j 里查找相关实体和关系。
3. 把向量结果和图结果合并。
4. 计算综合分数。
5. 返回排序后的 `MemoryItem[]`。

这个设计让语义记忆既能回答“哪些内容和这个问题相似”，也能回答“哪些实体和这个概念相关”。

## 12. 感知记忆 PerceptualMemory

感知记忆处理多模态输入。它和普通文本记忆不同，因为不同模态的向量维度和语义空间可能完全不一样。

例如：

- 文本 embedding 可能是 384 维。
- 图片 embedding 可能来自 CLIP。
- 音频 embedding 可能来自 CLAP。
- 视频 embedding 可能来自多帧或多模态模型。

如果把这些向量强行放进同一个 Qdrant collection，就会出现维度冲突。因此 `PerceptualMemory` 按模态创建不同 collection：

```text
hello_agents_vectors_perceptual_text
hello_agents_vectors_perceptual_image
hello_agents_vectors_perceptual_audio
hello_agents_vectors_perceptual_video
```

感知记忆的 metadata 里通常会包含：

```ts
{
  modality: "image",
  raw_data: "/path/to/image.png",
  file_name: "image.png"
}
```

写入流程是：

1. 判断 `modality`。
2. 对文本使用 `getTextEmbedder()`。
3. 对图片、音频、视频读取原始二进制或路径信息。
4. 使用确定性哈希向量作为默认编码。
5. 写入 SQLite。
6. 写入对应模态的 Qdrant collection。

这里的图片、音频、视频默认编码是可运行兜底，不等于生产级多模态模型。这样设计是为了让 SDK 的多模态存储接口先完整跑通，同时保留后续替换真实多模态 embedding 的位置。

检索时可以指定：

```ts
await perceptual.retrieve("Qdrant 架构图", 3, {
  targetModality: "text",
  queryModality: "text",
});
```

如果以后接入真正的图片或音频模型，只需要让对应模态的编码函数返回真实 embedding，存储和检索接口不需要变化。

## 13. MemoryManager

直接使用四类记忆没有问题，但 Agent 通常不应该自己判断每次要写到哪一种记忆里。因此我们实现 `MemoryManager` 作为统一入口。

创建方式如下：

```ts
import { MemoryConfig, MemoryManager } from "helloagent-js";

const manager = new MemoryManager({
  config: new MemoryConfig(),
  userId: "user_001",
  enableWorking: true,
  enableEpisodic: true,
  enableSemantic: true,
  enablePerceptual: false,
});
```

默认启用：

- `working`
- `episodic`
- `semantic`

默认不启用：

- `perceptual`

原因是感知记忆通常需要额外的多模态文件和更重的外部配置。用户需要时再显式打开。

`MemoryManager.addMemory()` 支持自动分类：

```ts
await manager.addMemory({
  content: "今天我们完成了记忆系统第一版。",
  importance: 0.8,
});
```

自动分类规则很简单：

- 内容里出现“昨天”“今天”“发生”“经历”等词，更偏向 `episodic`。
- 内容里出现“定义”“概念”“规则”“知识”“原理”等词，更偏向 `semantic`。
- 其他情况默认进入 `working`。

如果你已经明确知道目标类型，可以关闭自动分类：

```ts
await manager.addMemory({
  content: "TypeScript 使用结构化类型系统。",
  memoryType: "semantic",
  importance: 0.9,
  autoClassify: false,
});
```

统一检索使用 `retrieveMemories()`：

```ts
const memories = await manager.retrieveMemories({
  query: "TypeScript 类型系统",
  memoryTypes: ["working", "semantic"],
  limit: 5,
  minImportance: 0.2,
});
```

它会分发到多个记忆类型中检索，再把结果合并排序。

管理器还提供：

- `updateMemory()`：跨类型查找并更新记忆。
- `removeMemory()`：跨类型查找并删除记忆。
- `forgetMemories()`：统一执行遗忘策略。
- `consolidateMemories()`：把重要工作记忆转移到情景记忆。
- `getMemoryStats()`：查看整体统计。
- `clearAllMemories()`：清空所有启用的记忆。

## 14. MemoryTool

记忆系统真正进入 Agent 工作流，是通过 `MemoryTool` 完成的。

创建工具：

```ts
import { MemoryConfig, MemoryTool } from "helloagent-js";

const memoryTool = new MemoryTool({
  userId: "user_001",
  memoryTypes: ["working", "episodic", "semantic"],
  memoryConfig: new MemoryConfig({
    workingMemoryCapacity: 10,
    workingMemoryTokens: 2000,
  }),
});
```

`MemoryTool` 的工具名是 `memory`，描述是：

```text
记忆工具 - 可以存储和检索对话历史、知识和经验
```

工具参数由 `getParameters()` 暴露，核心参数如下：

- `action`：必填。支持 `add`、`search`、`summary`、`stats`、`update`、`remove`、`forget`、`consolidate`、`clear_all`。
- `content`：添加或更新记忆时使用。
- `query`：搜索记忆时使用。
- `memory_type`：限定记忆类型。
- `importance`：重要性分数。
- `limit`：结果数量。
- `memory_id`：更新或删除的目标记忆 ID。
- `file_path`：感知记忆的本地文件路径。
- `modality`：感知记忆模态。

直接调用工具可以这样写：

```ts
const result = await memoryTool.run({
  action: "add",
  content: "用户喜欢用 TypeScript 写 Agent SDK。",
  memory_type: "working",
  importance: 0.8,
});

console.log(result);
```

搜索记忆：

```ts
const result = await memoryTool.run({
  action: "search",
  query: "用户喜欢什么语言",
  memory_type: "working",
  limit: 3,
});
```

工具内部会把这些 action 分发给 `MemoryManager`。例如 `add` 会调用 `memoryManager.addMemory()`，`search` 会调用 `memoryManager.retrieveMemories()`。

## 15. MemoryTool 如何进入 Agent 工具调用链

因为 `MemoryTool` 继承自 `Tool`，所以它和搜索工具、普通自定义工具使用同一套注册流程。

以 `FunctionCallAgent` 为例：

```ts
import { FunctionCallAgent, HelloAgentsLLM, MemoryTool } from "helloagent-js";

const llm = new HelloAgentsLLM({
  provider: "deepseek",
  apiKey: process.env.DEEPSEEK_API_KEY,
});

const agent = new FunctionCallAgent({
  name: "memory-agent",
  llm,
  systemPrompt: "你是一个会主动保存和检索记忆的助手。",
});

agent.addTool(new MemoryTool({ userId: "user_001" }));
```

注册发生在 `agent.addTool()`：

```ts
addTool(tool: Tool, autoExpand = true): void {
  this.toolRegistry.registerTool(tool, autoExpand);
  this.enableToolCalling = true;
}
```

`ToolRegistry` 会保存这个工具。之后 Agent 运行时会发生下面的链路。

第一步，Agent 组装 prompt。

`FunctionCallAgent` 会调用 `getEnhancedSystemPrompt()`，把工具说明拼进 system prompt：

```text
## 可用工具
当你判断需要外部信息、计算或业务动作时，可以通过原生函数调用使用以下工具：
- memory: 记忆工具 - 可以存储和检索对话历史、知识和经验 参数: action(string, 必需), content(string, 可选), ...
```

第二步，Agent 生成工具 schema。

`MemoryTool.toOpenAISchema()` 会把参数定义转换成 OpenAI function calling schema。这个 schema 会作为 `tools` 参数传给 LLM：

```ts
{
  type: "function",
  function: {
    name: "memory",
    description: "记忆工具 - 可以存储和检索对话历史、知识和经验",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "要执行的操作..." },
        query: { type: "string", description: "搜索查询，search 时使用" }
      },
      required: ["action"]
    }
  }
}
```

第三步，模型返回 `tool_calls`。

如果模型判断需要搜索记忆，它可能返回类似结构：

```json
{
  "tool_calls": [
    {
      "id": "call_1",
      "type": "function",
      "function": {
        "name": "memory",
        "arguments": "{\"action\":\"search\",\"query\":\"用户喜欢什么语言\",\"limit\":3}"
      }
    }
  ]
}
```

第四步，Agent 解析工具参数。

`FunctionCallAgent` 会用 `JSON.parse()` 解析 `function.arguments`，得到：

```ts
{
  action: "search",
  query: "用户喜欢什么语言",
  limit: 3
}
```

第五步，执行工具。

Agent 调用：

```ts
executeRegisteredToolWithParameters(this.toolRegistry, toolName, parsedArguments);
```

工具执行器会找到 `memory` 工具，再调用：

```ts
memoryTool.run(parsedArguments);
```

第六步，工具结果回填给 LLM。

执行结果会被塞回消息列表：

```ts
messages.push({
  role: "tool",
  content: result,
  name: "memory",
  tool_call_id: toolCall.id,
});
```

第七步，LLM 基于工具结果生成最终回答。

如果搜索到相关记忆，工具结果可能是：

```text
找到 1 条相关记忆:
1. [工作记忆] 用户喜欢用 TypeScript 写 Agent SDK。 (重要性: 0.80)
```

LLM 会拿这个结果组织最终回答。

第八步，Agent 保存历史。

当最终回答生成后，`FunctionCallAgent` 会调用 `saveTurn()`：

```ts
this.addMessage(new Message(inputText, "user"));
this.addMessage(new Message(response, "assistant"));
```

这一步保存的是 Agent 自己的对话历史。它和 `MemoryTool` 保存的长期记忆是两层不同的东西：

- Agent history 用来保留最近几轮对话。
- Memory system 用来保存可检索、可遗忘、可跨会话复用的记忆。

如果你希望每轮对话都自动写入记忆，可以在业务层调用：

```ts
await memoryTool.autoRecordConversation(userInput, answer);
```

这个方法会把用户输入和助手回答写入工作记忆，并在内容较长或包含“重要”“记住”等关键词时额外写入情景记忆。

## 16. 导出 SDK API

为了让用户可以从包入口导入记忆能力，本章更新了 `src/index.ts`：

```ts
import {
  BaseMemory,
  MemoryConfig,
  MemoryItem,
  MemoryManager,
  WorkingMemory,
  EpisodicMemory,
  SemanticMemory,
  PerceptualMemory,
  QdrantVectorStore,
  Neo4jGraphStore,
  SQLiteDocumentStore,
  MemoryTool,
} from "helloagent-js";
```

实际代码里这些导出分布在 `src/memory/index.ts`、`src/tools/builtin/index.ts` 和 `src/index.ts` 中。用户只需要从根入口导入即可。

## 17. 可选依赖

本章在 `package.json` 里新增了可选依赖：

```json
{
  "optionalDependencies": {
    "@xenova/transformers": "^2.17.2",
    "better-sqlite3": "^11.7.0",
    "neo4j-driver": "^5.28.1"
  }
}
```

它们为什么是可选依赖？

- 只用 `WorkingMemory` 时，不需要任何数据库。
- 只用 OpenAI-compatible 远程 embedding 时，不需要本地 transformer。
- 只用 Qdrant 向量检索时，不一定需要 Neo4j。
- SQLite 和 Neo4j 依赖里有运行时环境要求，不应该让最小 SDK 示例变重。

因此这些模块都通过动态导入加载。用户启用相关能力时再安装对应依赖即可。

## 18. 运行示例

本章新增示例：

```text
examples/09-memory-system.mjs
examples/09-1-embedding-demo.mjs
examples/09-02-qdrant-business-demo.mjs
examples/09-03-neo4j-business-demo.mjs
```

`examples/09-1-embedding-demo.mjs` 是一个最小业务语义匹配示例。它不启动 Qdrant、Neo4j，也不创建完整记忆系统，只模拟一个客服 FAQ 场景：用户问“订单同步失败导致销售报表缺数，应该怎么处理？”，示例会读取 `examples/.env` 里的 `EMBED_*` 配置，把用户问题和 3 条 FAQ 都转成向量，然后用相似度找出最匹配的 FAQ 答案。

如果使用 OpenRouter，可以在 `examples/.env` 中配置：

```text
EMBED_MODEL_TYPE=openrouter
EMBED_MODEL_NAME=openai/text-embedding-3-small
EMBED_API_KEY=your-openrouter-api-key
EMBED_BASE_URL=https://openrouter.ai/api/v1
EMBED_DIMENSION=1536
```

运行这个示例后，你会看到用户问题、匹配到的 FAQ、推荐回答和相似度。这里 embedding 是底层语义匹配能力，业务输出是一条可直接回复用户的 FAQ 答案：

```bash
pnpm build
node examples/09-1-embedding-demo.mjs
```

`examples/09-02-qdrant-business-demo.mjs` 是在上一个示例基础上前进一步：它仍然使用真实业务语义匹配场景，但不再把向量留在内存里自己算相似度，而是把知识库条目写入 Qdrant collection，再用 Qdrant 做向量召回。

这个示例模拟的是一个 SaaS 客服知识库。代码里准备了几条处理手册：订单同步失败、支付到账但订单未付款、发票抬头修改、库存预警通知失败。每一条知识都包含标题、分类、优先级和处理方案。示例启动后会做四件事：

1. 读取 `examples/.env` 中的 `EMBED_*` 配置，创建 embedding 模型。
2. 读取 `QDRANT_*` 配置，创建 `QdrantVectorStore`。
3. 把每条客服知识拼成适合 embedding 的文本，生成向量后写入 Qdrant。
4. 把一条真实风格的客户工单也转成向量，在同一个 collection 中召回最相关的处理方案。

这条链路能帮助你看到 Embedding 和 Qdrant 的分工。Embedding 负责把“订单同步失败导致销售看板缺数”这种自然语言变成向量；Qdrant 负责保存这些向量，并在查询时找出距离最近的知识条目。业务代码拿到召回结果后，再把 payload 里的标题、分类、优先级和处理方案组合成客服建议。

示例使用固定 UUID 作为 point id，所以重复运行会覆盖同几条知识，不会无限新增重复数据。写入 payload 时也带上了 `namespace=support_playbook` 和 `data_source=09-02-qdrant-business-demo`，查询时会用这两个字段过滤，避免和其他记忆数据混在一起。

运行前确保 `examples/.env` 至少有这些配置：

```text
EMBED_MODEL_TYPE=openrouter
EMBED_MODEL_NAME=openai/text-embedding-3-small
EMBED_API_KEY=your-openrouter-api-key
EMBED_BASE_URL=https://openrouter.ai/api/v1
EMBED_DIMENSION=1536

QDRANT_URL=https://your-cluster-url
QDRANT_API_KEY=your-qdrant-api-key
QDRANT_COLLECTION=hello_agents_support_playbook
QDRANT_VECTOR_SIZE=1536
QDRANT_DISTANCE=cosine
```

如果你用的是本地 TF-IDF 快速验证，可以把 embedding 改成：

```text
EMBED_MODEL_TYPE=tfidf
EMBED_DIMENSION=384
QDRANT_VECTOR_SIZE=384
```

运行：

```bash
pnpm build
node examples/09-02-qdrant-business-demo.mjs
```

运行成功后，终端会打印当前使用的 Qdrant collection、向量维度、用户工单、召回到的前三条知识，以及基于第一条结果拼出来的建议回复。如果这里报维度不一致，优先检查 `EMBED_DIMENSION` 和 `QDRANT_VECTOR_SIZE` 是否一致；如果 collection 之前已经用其他维度创建过，建议换一个新的 `QDRANT_COLLECTION` 名字重新跑。

`examples/09-03-neo4j-business-demo.mjs` 专门验证 Neo4j。它不调用 embedding，也不连接 Qdrant，只演示图数据库最核心的能力：保存实体和关系，然后从一个实体出发找到相关实体。

这个示例仍然使用客服业务背景，但把问题简化成一张小图：

- 客户：杭州星河零售。
- 系统：订单同步系统。
- 团队：集成支持团队。
- 问题：销售报表缺数。

然后写入四条关系：

- 杭州星河零售 `USES` 订单同步系统。
- 订单同步系统 `OWNED_BY` 集成支持团队。
- 销售报表缺数 `IMPACTS` 杭州星河零售。
- 销售报表缺数 `RELATED_TO` 订单同步系统。

运行时，示例会先用 `Neo4jGraphStore.healthCheck()` 检查连接，再用 `addEntity()` 写入 4 个实体，用 `addRelationship()` 写入 4 条关系。因为底层使用 `MERGE`，重复运行不会重复创建同一个实体或同一条关系。

写完之后，示例会按名称搜索“杭州星河”，找到客户实体，再做两类查询：

1. `getEntityRelationships()`：查看这个客户的一跳直接关系。
2. `findRelatedEntities()`：从这个客户出发查两跳内相关实体，比如能顺着 `USES -> OWNED_BY` 找到负责订单同步系统的团队。

运行前确保 `examples/.env` 有 Neo4j 配置：

```text
NEO4J_URI=neo4j+s://your-instance.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=neo4j
```

运行：

```bash
pnpm build
node examples/09-03-neo4j-business-demo.mjs
```

运行成功后，终端会打印 Neo4j URI、数据库名、查询到的客户、直接关系、两跳内相关实体和图数据库统计。这个示例的重点是让你先确认 Neo4j 连接、实体写入、关系写入和图查询这四件事都能跑通。

默认运行路径只验证 `WorkingMemory` 和 `MemoryTool`：

```bash
pnpm build
node examples/09-memory-system.mjs
```

这条路径会完成：

1. 创建 `MemoryTool`。
2. 添加一条工作记忆。
3. 自动记录一轮对话。
4. 搜索相关记忆。
5. 打印记忆摘要。

如果要验证完整后端链路，需要先准备 Qdrant 和 Neo4j：

```bash
docker run -p 6333:6333 qdrant/qdrant
docker run -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/hello-agents-password neo4j:5
```

然后在 `examples/.env` 中配置：

```text
RUN_FULL_MEMORY_DEMO=1
EMBED_MODEL_TYPE=tfidf
EMBED_DIMENSION=384
QDRANT_URL=http://localhost:6333
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=hello-agents-password
```

再运行：

```bash
pnpm build
node examples/09-memory-system.mjs
```

完整路径会继续验证：

- `EpisodicMemory` 写入 SQLite 和 Qdrant，并检索线上事故复盘记忆。
- `SemanticMemory` 写入 Qdrant 和 Neo4j，并检索实体相关知识。
- `PerceptualMemory` 写入文本模态感知记忆，并按模态检索。

## 19. 本章小结

这一章完成了 SDK 的完整记忆系统第一阶段。

从能力上看，SDK 已经具备：

- 短期工作记忆。
- 长期情景记忆。
- 抽象语义记忆。
- 多模态感知记忆。
- Qdrant 向量检索。
- Neo4j 图关系检索。
- SQLite 权威文档存储。
- 统一 MemoryManager。
- Agent 可调用的 MemoryTool。

从架构上看，记忆系统保持了清晰分层：

```text
Agent
  -> MemoryTool
    -> MemoryManager
      -> WorkingMemory
      -> EpisodicMemory
         -> SQLiteDocumentStore + QdrantVectorStore
      -> SemanticMemory
         -> QdrantVectorStore + Neo4jGraphStore
      -> PerceptualMemory
         -> SQLiteDocumentStore + per-modality QdrantVectorStore
```

这样设计以后，RAG 系统可以直接复用本章的 embedding、Qdrant 存储和文档存储能力。下一阶段做 RAG 时，我们不需要重新发明向量索引和数据库配置，只需要在这些基础能力上继续实现文档切分、索引构建、查询扩展和结果重排。
