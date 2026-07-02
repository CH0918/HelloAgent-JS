import { Config } from "./config.js";
import type { HelloAgentsLLM } from "./llm.js";
import { Message } from "./message.js";
import type { MessageRole, OpenAIMessage } from "./message.js";

export interface AgentOptions {
  name: string;
  llm: HelloAgentsLLM;
  systemPrompt?: string;
  config?: Config;
}

export abstract class Agent {
  readonly name: string;
  readonly llm: HelloAgentsLLM;
  readonly systemPrompt?: string;
  readonly config: Config;

  protected readonly history: Message[];

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.llm = options.llm;
    this.systemPrompt = options.systemPrompt;
    this.config = options.config ?? new Config();
    this.history = [];
  }

  abstract run(inputText: string, options?: Record<string, unknown>): Promise<string>;

  addMessage(message: Message): void {
    this.history.push(message);
    this.trimHistory();
  }

  clearHistory(): void {
    this.history.length = 0;
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  protected buildBaseMessages(systemPrompt?: string): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    for (const message of this.history) {
      messages.push(message.toDict());
    }

    return messages;
  }

  protected remember(content: string, role: MessageRole): void {
    this.addMessage(new Message(content, role));
  }

  protected trimHistory(): void {
    const maxHistoryLength = this.config.maxHistoryLength;
    if (this.history.length <= maxHistoryLength) {
      return;
    }

    this.history.splice(0, this.history.length - maxHistoryLength);
  }

  toString(): string {
    return `Agent(name=${this.name}, provider=${this.llm.provider})`;
  }
}
