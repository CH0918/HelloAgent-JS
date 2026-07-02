import { Agent } from "../core/agent.js";
import type { AgentOptions } from "../core/agent.js";
import type { ChatMessage } from "../core/llm.js";
import type { HelloAgentsLLM } from "../core/llm.js";
import { Message } from "../core/message.js";

export const DEFAULT_PLANNER_PROMPT = `
你是一个严谨的 AI 规划专家。你的任务是把用户提出的复杂问题拆解成一组清晰、可执行、按逻辑顺序排列的步骤。

请遵守以下要求：
1. 每个步骤都必须是一个独立的子任务。
2. 步骤数量要足够覆盖问题，但不要把简单任务拆得过碎。
3. 最后一步必须是综合前面步骤，形成完整最终答案。
4. 只输出 JSON 字符串数组，不要输出解释、编号列表或 Markdown 正文。

# 用户问题
{question}

请严格按下面格式输出：
\`\`\`json
["步骤1", "步骤2", "步骤3"]
\`\`\`
`;

export const DEFAULT_EXECUTOR_PROMPT = `
你是一位严谨的 AI 执行专家。你的任务是严格按照给定计划，一步一步解决问题。

你会收到原始问题、完整计划、已经完成的步骤结果，以及当前要执行的步骤。
请只专注当前步骤，不要跳过计划，不要输出与当前步骤无关的寒暄。
如果当前步骤是最后一步，请综合前面结果给出最终答案。

# 原始问题
{question}

# 完整计划
{plan}

# 历史步骤与结果
{history}

# 当前进度
第 {step_index} / {total_steps} 步

# 当前步骤
{current_step}

请输出当前步骤的执行结果：
`;

export interface PlanAndSolvePrompts {
  planner: string;
  executor: string;
}

export const DEFAULT_PLAN_AND_SOLVE_PROMPTS: PlanAndSolvePrompts = {
  planner: DEFAULT_PLANNER_PROMPT,
  executor: DEFAULT_EXECUTOR_PROMPT,
};

export interface PlanAndSolveStepResult {
  stepIndex: number;
  step: string;
  result: string;
}

export interface ExecutorExecutionResult {
  finalAnswer: string;
  stepResults: PlanAndSolveStepResult[];
}

export type PlanAndSolveStepEventType = "plan" | "step-start" | "step-finish" | "finish" | "error";

export interface PlanAndSolveStepEvent {
  type: PlanAndSolveStepEventType;
  content: string;
  plan?: string[];
  stepIndex?: number;
  totalSteps?: number;
  step?: string;
  result?: string;
}

export interface PlanAndSolveAgentOptions extends AgentOptions {
  customPrompts?: Partial<PlanAndSolvePrompts>;
}

export interface PlanAndSolveAgentRunOptions extends Record<string, unknown> {
  onStep?: (event: PlanAndSolveStepEvent) => void;
}

export class Planner {
  private readonly llm: HelloAgentsLLM;
  private readonly promptTemplate: string;

  constructor(llm: HelloAgentsLLM, promptTemplate = DEFAULT_PLANNER_PROMPT) {
    this.llm = llm;
    this.promptTemplate = promptTemplate;
  }

  async plan(
    question: string,
    options: Record<string, unknown> = {},
    contextMessages: ChatMessage[] = [],
  ): Promise<string[]> {
    const prompt = renderPrompt(this.promptTemplate, {
      question,
    });
    const responseText = await this.llm.invoke(this.buildMessages(prompt, contextMessages), options);
    return this.parsePlan(responseText);
  }

  private buildMessages(prompt: string, contextMessages: ChatMessage[]): ChatMessage[] {
    return [
      ...contextMessages,
      {
        role: "user",
        content: prompt,
      },
    ];
  }

  private parsePlan(responseText: string): string[] {
    for (const candidate of this.collectPlanCandidates(responseText)) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        const plan = normalizePlanItems(parsed);
        if (plan.length > 0) {
          return plan;
        }
      } catch {
        // Try the next candidate. Models often add prose around the JSON block.
      }
    }

    return [];
  }

  private collectPlanCandidates(responseText: string): string[] {
    const candidates: string[] = [];
    const codeBlockPattern = /```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g;

    for (const match of responseText.matchAll(codeBlockPattern)) {
      const content = match[1]?.trim();
      if (content) {
        candidates.push(content);
      }
    }

    const arrayCandidate = extractArrayCandidate(responseText);
    if (arrayCandidate) {
      candidates.push(arrayCandidate);
    }

    const trimmedResponse = responseText.trim();
    if (trimmedResponse) {
      candidates.push(trimmedResponse);
    }

    return [...new Set(candidates)];
  }
}

export class Executor {
  private readonly llm: HelloAgentsLLM;
  private readonly promptTemplate: string;

  constructor(llm: HelloAgentsLLM, promptTemplate = DEFAULT_EXECUTOR_PROMPT) {
    this.llm = llm;
    this.promptTemplate = promptTemplate;
  }

  async execute(
    question: string,
    plan: string[],
    options: Record<string, unknown> = {},
    contextMessages: ChatMessage[] = [],
    onStep?: (event: PlanAndSolveStepEvent) => void,
  ): Promise<ExecutorExecutionResult> {
    const stepResults: PlanAndSolveStepResult[] = [];
    let finalAnswer = "";

    for (const [index, step] of plan.entries()) {
      const stepIndex = index + 1;
      onStep?.({
        type: "step-start",
        content: step,
        stepIndex,
        totalSteps: plan.length,
        step,
      });

      const prompt = renderPrompt(this.promptTemplate, {
        question,
        plan: JSON.stringify(plan, null, 2),
        history: formatExecutionHistory(stepResults),
        step_index: String(stepIndex),
        total_steps: String(plan.length),
        current_step: step,
      });
      const result = (await this.llm.invoke(this.buildMessages(prompt, contextMessages), options)).trim();
      const stepResult: PlanAndSolveStepResult = {
        stepIndex,
        step,
        result,
      };

      stepResults.push(stepResult);
      finalAnswer = result;
      onStep?.({
        type: "step-finish",
        content: result,
        stepIndex,
        totalSteps: plan.length,
        step,
        result,
      });
    }

    return {
      finalAnswer,
      stepResults,
    };
  }

  private buildMessages(prompt: string, contextMessages: ChatMessage[]): ChatMessage[] {
    return [
      ...contextMessages,
      {
        role: "user",
        content: prompt,
      },
    ];
  }
}

export class PlanAndSolveAgent extends Agent {
  readonly planner: Planner;
  readonly executor: Executor;

  private lastPlan: string[];
  private stepResults: PlanAndSolveStepResult[];

  constructor(options: PlanAndSolveAgentOptions) {
    super(options);
    this.planner = new Planner(options.llm, options.customPrompts?.planner ?? DEFAULT_PLANNER_PROMPT);
    this.executor = new Executor(options.llm, options.customPrompts?.executor ?? DEFAULT_EXECUTOR_PROMPT);
    this.lastPlan = [];
    this.stepResults = [];
  }

  async run(inputText: string, options: PlanAndSolveAgentRunOptions = {}): Promise<string> {
    const { onStep, ...llmOptions } = options;
    const contextMessages = this.buildBaseMessages(this.systemPrompt);

    this.lastPlan = await this.planner.plan(inputText, llmOptions, contextMessages);
    this.stepResults = [];

    if (this.lastPlan.length === 0) {
      const finalAnswer = "无法生成有效的行动计划，任务终止。";
      onStep?.({
        type: "error",
        content: finalAnswer,
      });
      this.saveTurn(inputText, finalAnswer);
      return finalAnswer;
    }

    onStep?.({
      type: "plan",
      content: this.lastPlan.join("\n"),
      plan: this.getLastPlan(),
    });

    const executionResult = await this.executor.execute(
      inputText,
      this.lastPlan,
      llmOptions,
      contextMessages,
      onStep,
    );
    this.stepResults = executionResult.stepResults;
    const finalAnswer = executionResult.finalAnswer;

    onStep?.({
      type: "finish",
      content: finalAnswer,
      plan: this.getLastPlan(),
      result: finalAnswer,
    });

    this.saveTurn(inputText, finalAnswer);
    return finalAnswer;
  }

  getLastPlan(): string[] {
    return [...this.lastPlan];
  }

  getStepResults(): PlanAndSolveStepResult[] {
    return this.stepResults.map((stepResult) => ({ ...stepResult }));
  }

  private saveTurn(inputText: string, response: string): void {
    this.addMessage(new Message(inputText, "user"));
    this.addMessage(new Message(response, "assistant"));
  }
}

function renderPrompt(template: string, values: Record<string, string>): string {
  let rendered = template;

  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }

  return rendered;
}

function normalizePlanItems(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0);
}

function extractArrayCandidate(responseText: string): string | undefined {
  const startIndex = responseText.indexOf("[");
  const endIndex = responseText.lastIndexOf("]");

  if (startIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }

  return responseText.slice(startIndex, endIndex + 1).trim();
}

function formatExecutionHistory(stepResults: PlanAndSolveStepResult[]): string {
  if (stepResults.length === 0) {
    return "无";
  }

  return stepResults
    .map((stepResult) => `步骤 ${stepResult.stepIndex}: ${stepResult.step}\n结果: ${stepResult.result}`)
    .join("\n\n");
}
