import { Agent } from "../core/agent.js";
import type { AgentOptions } from "../core/agent.js";
import type { ChatMessage } from "../core/llm.js";
import { Message } from "../core/message.js";
import { executeRegisteredTool } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/base.js";

interface ParsedToolCall {
  toolName: string;
  parameters: string;
  original: string;
}

export interface SimpleAgentOptions extends AgentOptions {
  toolRegistry?: ToolRegistry;
  enableToolCalling?: boolean;
}

export interface SimpleAgentRunOptions extends Record<string, unknown> {
  maxToolIterations?: number;
}

export class SimpleAgent extends Agent {
  private toolRegistry?: ToolRegistry;
  private enableToolCalling: boolean;

  constructor(options: SimpleAgentOptions) {
    super(options);
    this.toolRegistry = options.toolRegistry;
    this.enableToolCalling = (options.enableToolCalling ?? true) && options.toolRegistry !== undefined;
  }

  async run(inputText: string, options: SimpleAgentRunOptions = {}): Promise<string> {
    const { maxToolIterations = 3, ...llmOptions } = options;
    const messages = this.buildMessages(inputText);

    if (!this.hasTools()) {
      const response = await this.llm.invoke(messages, llmOptions);
      this.saveTurn(inputText, response);
      return response;
    }

    let currentIteration = 0;
    let finalResponse = "";

    while (currentIteration < maxToolIterations) {
      const response = await this.llm.invoke(messages, llmOptions);
      const toolCalls = this.parseToolCalls(response);

      if (toolCalls.length === 0) {
        finalResponse = response;
        break;
      }

      let cleanResponse = response;
      const toolResults: string[] = [];

      for (const call of toolCalls) {
        cleanResponse = cleanResponse.replace(call.original, "").trim();
        toolResults.push(await this.executeToolCall(call.toolName, call.parameters));
      }

      messages.push({ role: "assistant", content: cleanResponse || response });
      messages.push({
        role: "user",
        content: `工具执行结果：\n${toolResults.join("\n\n")}\n\n请基于这些结果给出完整的回答。`,
      });
      currentIteration += 1;
    }

    if (!finalResponse) {
      finalResponse = await this.llm.invoke(messages, llmOptions);
    }

    this.saveTurn(inputText, finalResponse);
    return finalResponse;
  }

  async *streamRun(inputText: string, options: Record<string, unknown> = {}): AsyncGenerator<string> {
    const messages = this.buildMessages(inputText);
    let fullResponse = "";

    for await (const chunk of this.llm.streamInvoke(messages, options)) {
      fullResponse += chunk;
      yield chunk;
    }

    this.saveTurn(inputText, fullResponse);
  }

  addTool(tool: Tool, autoExpand = true): void {
    if (!this.toolRegistry) {
      this.toolRegistry = new ToolRegistry();
    }

    this.toolRegistry.registerTool(tool, autoExpand);
    this.enableToolCalling = true;
  }

  removeTool(toolName: string): boolean {
    return this.toolRegistry?.unregisterTool(toolName) ?? false;
  }

  listTools(): string[] {
    return this.toolRegistry?.listTools() ?? [];
  }

  hasTools(): boolean {
    return this.enableToolCalling && this.toolRegistry !== undefined && this.toolRegistry.listTools().length > 0;
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
    const basePrompt = this.systemPrompt ?? "你是一个有用的AI助手。";

    if (!this.hasTools() || !this.toolRegistry) {
      return basePrompt;
    }

    const toolsDescription = this.toolRegistry.getToolsDescription();
    if (!toolsDescription || toolsDescription === "暂无可用工具") {
      return basePrompt;
    }

    return `${basePrompt}

## 可用工具
你可以使用以下工具来帮助回答问题：
${toolsDescription}

## 工具调用格式
当需要使用工具时，请使用以下格式：
\`[TOOL_CALL:{tool_name}:{parameters}]\`

### 参数格式说明
1. 多个参数：使用 \`key=value\` 格式，用逗号分隔，例如 \`[TOOL_CALL:calculator_multiply:a=12,b=8]\`
2. 单个参数：直接使用 \`key=value\`，例如 \`[TOOL_CALL:search:query=TypeScript]\`
3. 简单查询：可以直接传入文本，例如 \`[TOOL_CALL:search:TypeScript]\`

### 重要提示
- 参数名必须与工具定义的参数名完全匹配
- 数字参数直接写数字，不需要引号
- 工具调用结果会自动插入到对话中，然后你可以基于结果继续回答`;
  }

  private parseToolCalls(text: string): ParsedToolCall[] {
    const pattern = /\[TOOL_CALL:([^:\]]+):([^\]]+)\]/g;
    const calls: ParsedToolCall[] = [];

    for (const match of text.matchAll(pattern)) {
      calls.push({
        toolName: match[1]?.trim() ?? "",
        parameters: match[2]?.trim() ?? "",
        original: match[0],
      });
    }

    return calls.filter((call) => call.toolName.length > 0);
  }

  private async executeToolCall(toolName: string, parameters: string): Promise<string> {
    if (!this.toolRegistry) {
      return "错误：未配置工具注册表";
    }

    try {
      const result = await executeRegisteredTool(this.toolRegistry, toolName, parameters);
      return `工具 ${toolName} 执行结果：\n${result}`;
    } catch (error) {
      return `工具调用失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private saveTurn(inputText: string, response: string): void {
    this.addMessage(new Message(inputText, "user"));
    this.addMessage(new Message(response, "assistant"));
  }
}
