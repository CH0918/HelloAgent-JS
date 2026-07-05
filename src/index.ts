export const version = "0.1.0";

export {
  AgentException,
  ConfigException,
  HelloAgentsException,
  LLMException,
  ToolException,
} from "./core/exceptions.js";
export { Config } from "./core/config.js";
export {
  getDatabaseConfig,
  loadDatabaseConfig,
  updateDatabaseConfig,
} from "./core/database-config.js";
export { Agent } from "./core/agent.js";
export { HelloAgentsLLM } from "./core/llm.js";
export { Message } from "./core/message.js";
export { FunctionCallAgent } from "./agents/function-call-agent.js";
export { DEFAULT_REFLECTION_PROMPTS, ReflectionAgent, ReflectionMemory } from "./agents/reflection-agent.js";
export { DEFAULT_REACT_PROMPT, ReActAgent } from "./agents/react-agent.js";
export {
  DEFAULT_EXECUTOR_PROMPT,
  DEFAULT_PLAN_AND_SOLVE_PROMPTS,
  DEFAULT_PLANNER_PROMPT,
  Executor,
  PlanAndSolveAgent,
  Planner,
} from "./agents/plan-and-solve-agent.js";
export { SimpleAgent } from "./agents/simple-agent.js";
export { Tool } from "./tools/base.js";
export {
  MemoryTool,
  RAGTool,
  SearchTool,
  search,
  searchDuckDuckGo,
  searchHybrid,
  searchPerplexity,
  searchSerpApi,
  searchSearxng,
  searchTavily,
  SUPPORTED_SEARCH_BACKENDS,
  SUPPORTED_SEARCH_RETURN_MODES,
} from "./tools/builtin/index.js";
export {
  BaseMemory,
  DocumentProcessor,
  createEmbeddingModel,
  createEmbeddingModelWithFallback,
  createDocument,
  createRAGPipeline,
  DashScopeEmbedding,
  Entity,
  EpisodicMemory,
  getDimension,
  getTextEmbedder,
  loadAndChunkTexts,
  loadTextFile,
  LocalTransformerEmbedding,
  MemoryConfig,
  MemoryItem,
  MemoryManager,
  mergeSnippetsGrouped,
  Neo4jGraphStore,
  OpenAICompatibleEmbedding,
  Perception,
  PerceptualMemory,
  QdrantConnectionManager,
  QdrantVectorStore,
  RAGPipeline,
  refreshEmbedder,
  Relation,
  SemanticMemory,
  SQLiteDocumentStore,
  TFIDFEmbedding,
  WorkingMemory,
  computeGraphSignalsFromHits,
  compressRankedItems,
  preprocessMarkdownForEmbedding,
  rankVectorHits,
} from "./memory/index.js";
export {
  executeRegisteredTool,
  executeRegisteredToolWithParameters,
  parseToolParameters,
} from "./tools/executor.js";
export { ToolChain, ToolChainManager } from "./tools/chain.js";
export {
  AsyncToolExecutor,
  runBatchTool,
  runParallelTools,
} from "./tools/async-executor.js";
export { ToolRegistry, globalRegistry } from "./tools/registry.js";

export type { AgentOptions } from "./core/agent.js";
export type { ConfigDict, ConfigOptions } from "./core/config.js";
export type {
  DatabaseConfig,
  Neo4jConfig,
  QdrantConfig,
} from "./core/database-config.js";
export type {
  ChatMessage,
  HelloAgentsLLMOptions,
  LLMMessageResponse,
  OpenAICompatibleClient,
  SupportedProvider,
} from "./core/llm.js";
export type { MessageOptions, MessageRole, OpenAIMessage, OpenAIToolCall } from "./core/message.js";
export type {
  FunctionCallAgentOptions,
  FunctionCallAgentRunOptions,
  FunctionCallStepEvent,
  FunctionCallStepEventType,
  FunctionCallToolChoice,
} from "./agents/function-call-agent.js";
export type {
  ExecutorExecutionResult,
  PlanAndSolveAgentOptions,
  PlanAndSolveAgentRunOptions,
  PlanAndSolvePrompts,
  PlanAndSolveStepEvent,
  PlanAndSolveStepEventType,
  PlanAndSolveStepResult,
} from "./agents/plan-and-solve-agent.js";
export type {
  ReflectionAgentOptions,
  ReflectionAgentRunOptions,
  ReflectionPrompts,
  ReflectionRecord,
  ReflectionRecordType,
  ReflectionStepEvent,
  ReflectionStepEventType,
} from "./agents/reflection-agent.js";
export type {
  ReActAgentOptions,
  ReActAgentRunOptions,
  ReActStepEvent,
  ReActStepEventType,
} from "./agents/react-agent.js";
export type { SimpleAgentOptions, SimpleAgentRunOptions } from "./agents/simple-agent.js";
export type {
  OpenAIToolSchema,
  ToolDict,
  ToolParameter,
  ToolParameters,
  ToolParameterType,
  ToolResult,
} from "./tools/base.js";
export type {
  MemoryToolOptions,
  RAGToolOptions,
  SearchBackend,
  SearchFetchLike,
  SearchFetchResponse,
  SearchResponse,
  SearchResult,
  SearchReturnMode,
  SearchToolOptions,
} from "./tools/builtin/index.js";
export type {
  DocumentStore,
  EmbeddingInput,
  EmbeddingModel,
  EmbeddingModelOptions,
  LoadAndChunkOptions,
  MemoryConfigOptions,
  MemoryItemInput,
  MemoryManagerOptions,
  MemoryManagerStats,
  MemoryMetadata,
  MemoryStats,
  MemoryType,
  Neo4jGraphStoreOptions,
  QdrantSearchHit,
  QdrantVectorStoreOptions,
  RAGAddDocumentsOptions,
  RAGAddTextOptions,
  RAGAdvancedSearchOptions,
  RAGChunk,
  RAGDocument,
  RAGDocumentProcessorOptions,
  RAGPipelineOptions,
  RAGPipelineStats,
  RAGSearchOptions,
  RAGSearchResult,
  RAGVectorBackend,
  RetrieveMemoryOptions,
  SearchMemoriesOptions,
  StoredMemory,
} from "./memory/index.js";
export type {
  ToolChainContext,
  ToolChainInfo,
  ToolChainRunResult,
  ToolChainStep,
  ToolChainStepResult,
  ToolChainToolOptions,
} from "./tools/chain.js";
export type {
  AsyncToolExecutorOptions,
  AsyncToolTask,
  AsyncToolTaskResult,
  AsyncToolTaskStatus,
} from "./tools/async-executor.js";
export type { RegisteredFunction } from "./tools/registry.js";
