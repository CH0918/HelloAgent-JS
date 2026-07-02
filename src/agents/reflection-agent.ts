import { Agent } from "../core/agent.js";
import type { AgentOptions } from "../core/agent.js";
import type { ChatMessage } from "../core/llm.js";
import { Message } from "../core/message.js";

export interface ReflectionPrompts {
  initial: string;
  reflect: string;
  refine: string;
}

export const DEFAULT_REFLECTION_PROMPTS: ReflectionPrompts = {
  initial: `
请根据以下要求完成任务：

任务: {task}

请提供一个完整、准确的回答。
`,
  reflect: `
请仔细审查以下回答，并找出可能的问题或改进空间：

# 原始任务:
{task}

# 当前回答:
{content}

请分析这个回答的质量，指出不足之处，并提出具体的改进建议。
如果回答已经很好，请回答"无需改进"。
`,
  refine: `
请根据反馈意见改进你的回答：

# 原始任务:
{task}

# 上一轮回答:
{last_attempt}

# 反馈意见:
{feedback}

请提供一个改进后的回答。
`,
};

export type ReflectionRecordType = "execution" | "reflection";

export interface ReflectionRecord {
  type: ReflectionRecordType;
  content: string;
}

export class ReflectionMemory {
  private readonly records: ReflectionRecord[];

  constructor() {
    this.records = [];
  }

  addRecord(recordType: ReflectionRecordType, content: string): void {
    this.records.push({ type: recordType, content });
  }

  getRecords(): ReflectionRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  getTrajectory(): string {
    const trajectory: string[] = [];

    for (const record of this.records) {
      if (record.type === "execution") {
        trajectory.push(`--- 上一轮尝试 (代码) ---\n${record.content}`);
      } else if (record.type === "reflection") {
        trajectory.push(`--- 评审员反馈 ---\n${record.content}`);
      }
    }

    return trajectory.join("\n\n").trim();
  }

  getLastExecution(): string {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record?.type === "execution") {
        return record.content;
      }
    }

    return "";
  }
}

export type ReflectionStepEventType = "initial" | "reflection" | "refine" | "finish";

export interface ReflectionStepEvent {
  iteration: number;
  type: ReflectionStepEventType;
  content: string;
}

export interface ReflectionAgentOptions extends AgentOptions {
  maxIterations?: number;
  customPrompts?: ReflectionPrompts;
}

export interface ReflectionAgentRunOptions extends Record<string, unknown> {
  maxIterations?: number;
  onStep?: (event: ReflectionStepEvent) => void;
}

export class ReflectionAgent extends Agent {
  private readonly maxIterations: number;
  private readonly prompts: ReflectionPrompts;
  private memory: ReflectionMemory;

  constructor(options: ReflectionAgentOptions) {
    super(options);
    this.maxIterations = options.maxIterations ?? 3;
    this.prompts = options.customPrompts ?? DEFAULT_REFLECTION_PROMPTS;
    this.memory = new ReflectionMemory();
  }

  async run(inputText: string, options: ReflectionAgentRunOptions = {}): Promise<string> {
    const { maxIterations = this.maxIterations, onStep, ...llmOptions } = options;
    this.memory = new ReflectionMemory();

    const initialPrompt = this.renderPrompt(this.prompts.initial, {
      task: inputText,
    });
    const initialResult = await this.getLLMResponse(initialPrompt, llmOptions);
    this.memory.addRecord("execution", initialResult);
    onStep?.({
      iteration: 0,
      type: "initial",
      content: initialResult,
    });

    let completedIterations = 0;

    for (let currentIteration = 1; currentIteration <= maxIterations; currentIteration += 1) {
      completedIterations = currentIteration;

      const lastResult = this.memory.getLastExecution();
      const reflectPrompt = this.renderPrompt(this.prompts.reflect, {
        task: inputText,
        content: lastResult,
      });
      const feedback = await this.getLLMResponse(reflectPrompt, llmOptions);
      this.memory.addRecord("reflection", feedback);
      onStep?.({
        iteration: currentIteration,
        type: "reflection",
        content: feedback,
      });

      if (this.shouldStop(feedback)) {
        break;
      }

      const refinePrompt = this.renderPrompt(this.prompts.refine, {
        task: inputText,
        last_attempt: lastResult,
        feedback,
      });
      const refinedResult = await this.getLLMResponse(refinePrompt, llmOptions);
      this.memory.addRecord("execution", refinedResult);
      onStep?.({
        iteration: currentIteration,
        type: "refine",
        content: refinedResult,
      });
    }

    const finalResult = this.memory.getLastExecution();
    this.saveTurn(inputText, finalResult);
    onStep?.({
      iteration: completedIterations,
      type: "finish",
      content: finalResult,
    });

    return finalResult;
  }

  getMemoryRecords(): ReflectionRecord[] {
    return this.memory.getRecords();
  }

  getTrajectory(): string {
    return this.memory.getTrajectory();
  }

  private async getLLMResponse(prompt: string, options: Record<string, unknown>): Promise<string> {
    const messages: ChatMessage[] = [{ role: "user", content: prompt }];
    return await this.llm.invoke(messages, options);
  }

  private renderPrompt(template: string, values: Record<string, string>): string {
    let rendered = template;

    for (const [key, value] of Object.entries(values)) {
      rendered = rendered.replaceAll(`{${key}}`, value);
    }

    return rendered;
  }

  private shouldStop(feedback: string): boolean {
    return feedback.includes("无需改进") || feedback.toLowerCase().includes("no need for improvement");
  }

  private saveTurn(inputText: string, response: string): void {
    this.addMessage(new Message(inputText, "user"));
    this.addMessage(new Message(response, "assistant"));
  }
}
