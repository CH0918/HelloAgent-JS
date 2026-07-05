import { Agent } from "../core/agent.js";
import type { AgentOptions } from "../core/agent.js";
import type { ChatMessage } from "../core/llm.js";
import { Message } from "../core/message.js";
import type { Tool } from "../tools/base.js";
import { executeRegisteredTool } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";

// 默认 ReAct 提示词模板。
export const DEFAULT_REACT_PROMPT = `你是一个具备推理和行动能力的AI助手。你可以通过思考分析问题，然后调用合适的工具来获取信息，最终给出准确的答案。

## 可用工具
{tools}

## 工作流程
请严格按照以下格式进行回应，每次只能执行一个步骤：

Thought: 分析当前问题，思考需要什么信息或采取什么行动。
Action: 选择一个行动，格式必须是以下之一：
- \`{tool_name}[{tool_input}]\`：调用指定工具。
- \`Finish[最终答案]\`：当你有足够信息给出最终答案时。

## 重要提醒
1. 每次回应必须包含 Thought 和 Action 两部分。
2. 工具调用格式必须严格遵循：工具名[参数]。
3. 每次只能调用一个工具，不要在同一个 Action 中写多个工具调用。
4. 只有当你确信有足够信息回答问题时，才使用 Finish。
5. 如果工具返回的信息不够，继续使用其他工具或相同工具的不同参数。

## 当前任务
Question: {question}

## 执行历史
{history}

现在开始你的推理和行动：`;

interface ParsedAction {
  toolName: string;
  toolInput: string;
}

interface ParsedStep {
  thought?: string;
  action?: string;
}

export type ReActStepEventType = "thought" | "action" | "observation" | "finish" | "error";

export interface ReActStepEvent {
  step: number;
  type: ReActStepEventType;
  content: string;
  toolName?: string;
  toolInput?: string;
}

export interface ReActAgentOptions extends AgentOptions {
  toolRegistry?: ToolRegistry;
  maxSteps?: number;
  customPrompt?: string;
}

export interface ReActAgentRunOptions extends Record<string, unknown> {
  maxSteps?: number;
  onStep?: (event: ReActStepEvent) => void;
}

/**
 * ReAct (Reasoning and Acting) Agent.
 *
 * 结合推理和行动的智能体，能够：
 * 1. 分析问题并制定行动计划。
 * 2. 调用外部工具获取信息。
 * 3. 基于观察结果继续推理。
 * 4. 迭代执行直到得出最终答案。
 *
 * 这是一个经典的 Agent 范式，特别适合需要外部信息或多步工具调用的任务。
 */
export class ReActAgent extends Agent {
  readonly toolRegistry: ToolRegistry;
  private readonly maxSteps: number;
  private readonly promptTemplate: string;
  private currentHistory: string[];

  /**
   * 初始化 ReActAgent。
   *
   * @param options.name Agent 名称。
   * @param options.llm LLM 实例。
   * @param options.toolRegistry 工具注册表；如果不提供，会创建空的工具注册表。
   * @param options.systemPrompt 系统提示词。
   * @param options.config 配置对象。
   * @param options.maxSteps 最大执行步数。
   * @param options.customPrompt 自定义 ReAct 提示词模板。
   */
  constructor(options: ReActAgentOptions) {
    super(options);
    // 如果没有提供 toolRegistry，创建一个空的注册表。
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.maxSteps = options.maxSteps ?? 5;
    // 用户自定义提示词优先，否则使用默认 ReAct 模板。
    this.promptTemplate = options.customPrompt ?? DEFAULT_REACT_PROMPT;
    this.currentHistory = [];
  }

  /**
   * 运行 ReAct Agent。
   *
   * @param inputText 用户问题。
   * @param options LLM 调用参数；可用 maxSteps 覆盖本次最大执行步数。
   * @returns 最终答案。
   */
  async run(inputText: string, options: ReActAgentRunOptions = {}): Promise<string> {
    const { maxSteps = this.maxSteps, onStep, ...llmOptions } = options;
    this.currentHistory = [];

    for (let currentStep = 1; currentStep <= maxSteps; currentStep += 1) {
      // 构建提示词。
      const prompt = this.buildPrompt(inputText);
      // 调用 LLM。
      const response = await this.llm.invoke(this.buildMessages(prompt), llmOptions);
      // 解析 LLM 输出，提取思考和行动。
      const parsedStep = this.parseStep(response);

      if (parsedStep.thought) {
        this.currentHistory.push(`Thought: ${parsedStep.thought}`);
        onStep?.({
          step: currentStep,
          type: "thought",
          content: parsedStep.thought,
        });
      }

      if (!parsedStep.action) {
        const observation = "未能解析出有效的 Action，请严格使用 Action: tool_name[input] 或 Action: Finish[最终答案]。";
        this.currentHistory.push(`Observation: ${observation}`);
        onStep?.({
          step: currentStep,
          type: "error",
          content: observation,
        });
        continue;
      }

      onStep?.({
        step: currentStep,
        type: "action",
        content: parsedStep.action,
      });

      // 检查是否完成。
      if (parsedStep.action.startsWith("Finish")) {
        const finalAnswer = this.parseActionInput(parsedStep.action) || response;
        onStep?.({
          step: currentStep,
          type: "finish",
          content: finalAnswer,
        });
        // 保存到长期历史记录。
        this.saveTurn(inputText, finalAnswer);
        return finalAnswer;
      }

      // 执行工具调用。
      const action = this.parseAction(parsedStep.action);
      if (!action) {
        const observation = "无效的 Action 格式，请使用 工具名[参数]。";
        this.currentHistory.push(`Action: ${parsedStep.action}`);
        this.currentHistory.push(`Observation: ${observation}`);
        onStep?.({
          step: currentStep,
          type: "error",
          content: observation,
        });
        continue;
      }

      // 调用工具并记录观察结果。
      const observation = await executeRegisteredTool(this.toolRegistry, action.toolName, action.toolInput);
      this.currentHistory.push(`Action: ${parsedStep.action}`);
      this.currentHistory.push(`Observation: ${observation}`);
      onStep?.({
        step: currentStep,
        type: "observation",
        content: observation,
        toolName: action.toolName,
        toolInput: action.toolInput,
      });
    }

    const finalAnswer = "抱歉，我无法在限定步数内完成这个任务。";
    onStep?.({
      step: maxSteps,
      type: "finish",
      content: finalAnswer,
    });
    // 保存到长期历史记录。
    this.saveTurn(inputText, finalAnswer);
    return finalAnswer;
  }

  /**
   * 添加工具到工具注册表。
   *
   * 支持普通 Tool，也支持通过 Tool.expandable/getExpandedTools() 自动展开的工具。
   */
  addTool(tool: Tool, autoExpand = true): void {
    this.toolRegistry.registerTool(tool, autoExpand);
  }

  removeTool(toolName: string): boolean {
    return this.toolRegistry.unregisterTool(toolName);
  }

  listTools(): string[] {
    return this.toolRegistry.listTools();
  }

  getScratchpad(): string[] {
    return [...this.currentHistory];
  }

  /** 组装发送给 LLM 的消息。 */
  private buildMessages(prompt: string): ChatMessage[] {
    const messages = this.buildBaseMessages(this.systemPrompt);
    messages.push({ role: "user", content: prompt });
    return messages;
  }

  /** 构建包含工具说明、用户问题和执行历史的 ReAct 提示词。 */
  private buildPrompt(inputText: string): string {
    const tools = this.toolRegistry.getToolsDescription();
    const history = this.currentHistory.length > 0 ? this.currentHistory.join("\n") : "暂无执行历史";

    return this.promptTemplate
      .replaceAll("{tools}", tools)
      .replaceAll("{question}", inputText)
      .replaceAll("{history}", history);
  }

  /** 解析 LLM 输出，提取 Thought 和 Action。 */
  private parseStep(text: string): ParsedStep {
    const thoughtMatch = text.match(/Thought:\s*([\s\S]*?)(?=\n\s*Action:|$)/i);
    const actionMatch = text.match(/Action:\s*([^\n]+)/i);

    return {
      thought: thoughtMatch?.[1]?.trim(),
      action: actionMatch?.[1]?.trim(),
    };
  }

  /** 解析行动文本，提取工具名称和工具输入。 */
  private parseAction(actionText: string): ParsedAction | undefined {
    const match = actionText.match(/^([a-zA-Z_][\w.-]*)\[(.*)\]$/s);
    if (!match) {
      return undefined;
    }

    return {
      toolName: match[1] ?? "",
      toolInput: match[2] ?? "",
    };
  }

  /** 解析行动输入，例如从 Finish[最终答案] 中取出最终答案。 */
  private parseActionInput(actionText: string): string {
    const match = actionText.match(/^\w+\[(.*)\]$/s);
    return match?.[1]?.trim() ?? "";
  }

  /** 保存用户输入和最终回答到长期历史记录。 */
  private saveTurn(inputText: string, response: string): void {
    this.addMessage(new Message(inputText, "user"));
    this.addMessage(new Message(response, "assistant"));
  }
}
