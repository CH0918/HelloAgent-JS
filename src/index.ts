export const version = "0.1.0";

export {
  AgentException,
  ConfigException,
  HelloAgentsException,
  LLMException,
  ToolException,
} from "./core/exceptions.js";
export { Config } from "./core/config.js";
export { Agent } from "./core/agent.js";
export { HelloAgentsLLM } from "./core/llm.js";
export { Message } from "./core/message.js";
export { DEFAULT_REFLECTION_PROMPTS, ReflectionAgent, ReflectionMemory } from "./agents/reflection-agent.js";
export { DEFAULT_REACT_PROMPT, ReActAgent } from "./agents/react-agent.js";
export { SimpleAgent } from "./agents/simple-agent.js";
export { Tool } from "./tools/base.js";
export { executeRegisteredTool, parseToolParameters } from "./tools/executor.js";
export { ToolRegistry, globalRegistry } from "./tools/registry.js";

export type { AgentOptions } from "./core/agent.js";
export type { ConfigDict, ConfigOptions } from "./core/config.js";
export type {
  ChatMessage,
  HelloAgentsLLMOptions,
  OpenAICompatibleClient,
  SupportedProvider,
} from "./core/llm.js";
export type { MessageOptions, MessageRole, OpenAIMessage } from "./core/message.js";
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
export type { RegisteredFunction } from "./tools/registry.js";
