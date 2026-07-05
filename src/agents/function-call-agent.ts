import { Agent } from "../core/agent.js";
import type { AgentOptions } from "../core/agent.js";
import { AgentException } from "../core/exceptions.js";
import type { ChatMessage } from "../core/llm.js";
import type { LLMMessageResponse } from "../core/llm.js";
import { Message } from "../core/message.js";
import type { OpenAIToolCall } from "../core/message.js";
import type { OpenAIToolSchema, Tool, ToolParameters } from "../tools/base.js";
import { executeRegisteredToolWithParameters } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";

export type FunctionCallToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

export type FunctionCallStepEventType = "assistant" | "tool-call" | "tool-result" | "finish";

export interface FunctionCallStepEvent {
  iteration: number;
  type: FunctionCallStepEventType;
  content: string;
  toolName?: string;
  toolCallId?: string;
  arguments?: ToolParameters;
}

export interface FunctionCallAgentOptions extends AgentOptions {
  toolRegistry?: ToolRegistry;
  enableToolCalling?: boolean;
  defaultToolChoice?: FunctionCallToolChoice;
  maxToolIterations?: number;
}

export interface FunctionCallAgentRunOptions extends Record<string, unknown> {
  maxToolIterations?: number;
  toolChoice?: FunctionCallToolChoice;
  onStep?: (event: FunctionCallStepEvent) => void;
}

export class FunctionCallAgent extends Agent {
  readonly toolRegistry: ToolRegistry;

  private readonly defaultToolChoice: FunctionCallToolChoice;
  private readonly maxToolIterations: number;
  private enableToolCalling: boolean;

  constructor(options: FunctionCallAgentOptions) {
    super(options);
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.enableToolCalling = options.enableToolCalling ?? true;
    this.defaultToolChoice = options.defaultToolChoice ?? "auto";
    this.maxToolIterations = options.maxToolIterations ?? 3;
  }

  async run(inputText: string, options: FunctionCallAgentRunOptions = {}): Promise<string> {
    const {
      maxToolIterations = this.maxToolIterations,
      toolChoice = this.defaultToolChoice,
      onStep,
      ...llmOptions
    } = options;
    const messages = this.buildMessages(inputText);
    const toolSchemas = this.buildToolSchemas();

    if (toolSchemas.length === 0) {
      const response = await this.llm.invoke(messages, llmOptions);
      this.saveTurn(inputText, response);
      return response;
    }

    let currentIteration = 0;
    let hasExecutedTool = false;

    while (currentIteration < maxToolIterations) {
      const response = await this.llm.invokeMessage(messages, {
        ...llmOptions,
        tools: toolSchemas,
        tool_choice: toolChoice,
      });

      if (response.content) {
        onStep?.({
          iteration: currentIteration + 1,
          type: "assistant",
          content: response.content,
        });
      }

      const toolCalls =
        response.toolCalls.length > 0
          ? response.toolCalls
          : this.recoverMalformedToolCalls(response, currentIteration + 1);

      if (toolCalls.length === 0) {
        if (response.content.trim().length > 0) {
          return this.finishRun(inputText, messages, response.content, currentIteration + 1, onStep);
        }

        if (hasExecutedTool) {
          const finalResponse = await this.requestFinalResponse(messages, llmOptions);
          return this.finishRun(inputText, messages, finalResponse.content, currentIteration + 1, onStep, finalResponse);
        }

        throw this.createEmptyFinalResponseError(response);
      }

      messages.push(this.createAssistantToolCallMessage(response.content, toolCalls));

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const parsedArguments = this.parseFunctionCallArguments(toolCall.function.arguments);

        onStep?.({
          iteration: currentIteration + 1,
          type: "tool-call",
          content: toolCall.function.arguments,
          toolName,
          toolCallId: toolCall.id,
          arguments: parsedArguments,
        });

        const result = await executeRegisteredToolWithParameters(this.toolRegistry, toolName, parsedArguments);
        hasExecutedTool = true;
        messages.push({
          role: "tool",
          content: result,
          name: toolName,
          tool_call_id: toolCall.id,
        });

        onStep?.({
          iteration: currentIteration + 1,
          type: "tool-result",
          content: result,
          toolName,
          toolCallId: toolCall.id,
          arguments: parsedArguments,
        });
      }

      currentIteration += 1;
    }

    const finalResponse = await this.requestFinalResponse(messages, llmOptions);
    return this.finishRun(inputText, messages, finalResponse.content, currentIteration + 1, onStep, finalResponse);
  }

  private async requestFinalResponse(
    messages: ChatMessage[],
    llmOptions: Record<string, unknown>,
  ): Promise<LLMMessageResponse> {
    const finalOptions = { ...llmOptions };
    delete finalOptions.tools;
    delete finalOptions.tool_choice;
    return this.llm.invokeMessage(messages, finalOptions);
  }

  private finishRun(
    inputText: string,
    messages: ChatMessage[],
    content: string,
    iteration: number,
    onStep?: (event: FunctionCallStepEvent) => void,
    response?: LLMMessageResponse,
  ): string {
    if (content.trim().length === 0) {
      throw this.createEmptyFinalResponseError(response);
    }

    messages.push({ role: "assistant", content });
    onStep?.({
      iteration,
      type: "finish",
      content,
    });
    this.saveTurn(inputText, content);
    return content;
  }

  async *streamRun(inputText: string, options: FunctionCallAgentRunOptions = {}): AsyncGenerator<string> {
    yield await this.run(inputText, options);
  }

  addTool(tool: Tool, autoExpand = true): void {
    this.toolRegistry.registerTool(tool, autoExpand);
    this.enableToolCalling = true;
  }

  removeTool(toolName: string): boolean {
    return this.toolRegistry.unregisterTool(toolName);
  }

  listTools(): string[] {
    return this.toolRegistry.listTools();
  }

  hasTools(): boolean {
    return this.enableToolCalling && this.toolRegistry.listTools().length > 0;
  }

  private buildMessages(inputText: string): ChatMessage[] {
    return [
      ...this.buildBaseMessages(this.getEnhancedSystemPrompt()),
      {
        role: "user",
        content: inputText,
      },
    ];
  }

  private getEnhancedSystemPrompt(): string {
    const basePrompt = this.systemPrompt ?? "你是一个可靠的AI助理，能够在需要时调用工具完成任务。";

    if (!this.hasTools()) {
      return basePrompt;
    }

    const toolsDescription = this.toolRegistry.getToolsDescription();
    if (!toolsDescription || toolsDescription === "暂无可用工具") {
      return basePrompt;
    }

    return `${basePrompt}

## 可用工具
当你判断需要外部信息、计算或业务动作时，可以通过原生函数调用使用以下工具：
${toolsDescription}

请根据任务主动决定是否调用工具。工具结果会由系统回填给你，你需要基于工具结果给出最终回答。
如果决定调用工具，必须使用模型 API 的原生 tool_calls 结构返回；不要在普通文本中输出 call(...)、print(...)、default_api.xxx(...) 或 JSON 字符串来表示工具调用。`;
  }

  private buildToolSchemas(): OpenAIToolSchema[] {
    if (!this.hasTools()) {
      return [];
    }

    return this.toolRegistry.getOpenAIToolSchemas();
  }

  private createAssistantToolCallMessage(content: string, toolCalls: OpenAIToolCall[]): ChatMessage {
    return {
      role: "assistant",
      content,
      tool_calls: toolCalls,
    };
  }

  private parseFunctionCallArguments(argumentsText: string | undefined): ToolParameters {
    if (!argumentsText) {
      return {};
    }

    try {
      const parsed = JSON.parse(argumentsText) as unknown;
      return isToolParameters(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private saveTurn(inputText: string, response: string): void {
    this.addMessage(new Message(inputText, "user"));
    this.addMessage(new Message(response, "assistant"));
  }

  private recoverMalformedToolCalls(response: LLMMessageResponse, iteration: number): OpenAIToolCall[] {
    if (!response.refusal || response.content.trim().length > 0) {
      return [];
    }

    const recoveredCall = this.parseMalformedToolCall(response.refusal, iteration);
    return recoveredCall ? [recoveredCall] : [];
  }

  private parseMalformedToolCall(text: string, iteration: number): OpenAIToolCall | undefined {
    const functionCallPattern = /(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\s*\(([^()]*)\)/g;

    for (const match of text.matchAll(functionCallPattern)) {
      const toolName = match[1];
      if (!toolName || (!this.toolRegistry.getTool(toolName) && !this.toolRegistry.getFunction(toolName))) {
        continue;
      }

      return {
        id: `recovered-call-${iteration}`,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(this.parseMalformedArguments(match[2] ?? "")),
        },
      };
    }

    return undefined;
  }

  private parseMalformedArguments(argumentsText: string): ToolParameters {
    const parsed: ToolParameters = {};

    for (const part of argumentsText.split(",")) {
      const [name, ...valueParts] = part.split("=");
      const parameterName = name?.trim();
      if (!parameterName) {
        continue;
      }

      parsed[parameterName] = this.parseMalformedArgumentValue(valueParts.join("=").trim());
    }

    return parsed;
  }

  private parseMalformedArgumentValue(value: string): unknown {
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }

    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }

    const numberValue = Number(value);
    return Number.isFinite(numberValue) && value !== "" ? numberValue : value;
  }

  private createEmptyFinalResponseError(response?: LLMMessageResponse): AgentException {
    const refusal = response?.refusal ? ` 服务返回：${response.refusal}` : "";
    const toolCallHint =
      response && response.toolCalls.length > 0
        ? " 模型仍然返回了工具调用，请调大 maxToolIterations 或检查模型服务的 tools 兼容性。"
        : "";
    return new AgentException(`FunctionCallAgent 没有拿到可保存的最终回复。${refusal}${toolCallHint}`);
  }
}

function isToolParameters(value: unknown): value is ToolParameters {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
