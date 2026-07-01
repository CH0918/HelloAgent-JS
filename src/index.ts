export const version = "0.1.0";

export {
  AgentException,
  ConfigException,
  HelloAgentsException,
  LLMException,
  ToolException,
} from "./core/exceptions.js";
export { Config } from "./core/config.js";
export { HelloAgentsLLM } from "./core/llm.js";
export { Message } from "./core/message.js";

export type { ConfigDict, ConfigOptions } from "./core/config.js";
export type {
  ChatMessage,
  HelloAgentsLLMOptions,
  OpenAICompatibleClient,
  SupportedProvider,
} from "./core/llm.js";
export type { MessageOptions, MessageRole, OpenAIMessage } from "./core/message.js";
