import { Config } from "./config.js";
import { HelloAgentsLLM } from "./hello-agents-llm.js";
import { Message } from "./message.js";

/**
 * Agent 基类。
 */
abstract class Agent {
  readonly name: string;
  readonly llm: HelloAgentsLLM;
  readonly systemPrompt?: string;
  readonly config: Config;
  protected readonly history: Message[] = [];

  constructor(
    name: string,
    llm: HelloAgentsLLM,
    systemPrompt?: string,
    config: Config = new Config(),
  ) {
    this.name = name;
    this.llm = llm;
    this.systemPrompt = systemPrompt;
    this.config = config;
  }

  /**
   * 运行 Agent。
   */
  abstract run(inputText: string, options?: Record<string, unknown>): Promise<string> | string;

  /**
   * 添加消息到历史记录。
   */
  addMessage(message: Message): void {
    this.history.push(message);
  }

  /**
   * 清空历史记录。
   */
  clearHistory(): void {
    this.history.length = 0;
  }

  /**
   * 获取历史记录副本。
   */
  getHistory(): Message[] {
    return [...this.history];
  }

  toString(): string {
    const provider =
      (this.llm as unknown as { provider?: string }).provider ?? "openai-compatible";

    return `Agent(name=${this.name}, provider=${provider})`;
  }
}

export { Agent };
