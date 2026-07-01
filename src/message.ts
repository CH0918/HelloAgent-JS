/**
 * 消息系统。
 */
type MessageRole = "user" | "assistant" | "system" | "tool";

interface MessageOptions {
  timestamp?: Date;
  metadata?: Record<string, unknown>;
}

interface OpenAIMessageDict {
  role: MessageRole;
  content: string;
}

class Message {
  readonly content: string;
  readonly role: MessageRole;
  readonly timestamp: Date;
  readonly metadata: Record<string, unknown>;

  constructor(content: string, role: MessageRole, options: MessageOptions = {}) {
    this.content = content;
    this.role = role;
    this.timestamp = options.timestamp ?? new Date();
    this.metadata = options.metadata ?? {};
  }

  /**
   * 转换为 OpenAI API 兼容的消息字典。
   */
  toDict(): OpenAIMessageDict {
    return {
      role: this.role,
      content: this.content,
    };
  }

  toString(): string {
    return `[${this.role}] ${this.content}`;
  }
}

export { Message };
export type { MessageOptions, MessageRole, OpenAIMessageDict };
