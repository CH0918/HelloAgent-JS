import OpenAI from "openai";
import "dotenv/config";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface HelloAgentsLLMOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

class HelloAgentsLLM {
  /**
   * 为本书 "Hello Agents" 定制的 LLM 客户端。
   * 它用于调用任何兼容 OpenAI 接口的服务，并默认使用流式响应。
  */
  private readonly model: string;
  private readonly client: OpenAI;

  constructor({ model, apiKey, baseUrl, timeout }: HelloAgentsLLMOptions = {}) {
    this.model = model || process.env.LLM_MODEL_ID!;
    const resolvedApiKey = apiKey || process.env.LLM_API_KEY;
    const resolvedBaseUrl = baseUrl || process.env.LLM_BASE_URL;
    const resolvedTimeout = timeout ?? Number(process.env.LLM_TIMEOUT || 60);

    if (!this.model || !resolvedApiKey || !resolvedBaseUrl) {
      throw new Error("模型ID、API密钥和服务地址必须被提供或在.env文件中定义。");
    }

    this.client = new OpenAI({
      apiKey: resolvedApiKey,
      baseURL: resolvedBaseUrl,
      timeout: resolvedTimeout * 1000,
    });
  }

  /**
   * 调用大语言模型进行思考，并返回其响应。
   */
  async think(
    messages: ChatMessage[],
    temperature: number = 0,
  ): Promise<string | null> {
    console.log(`🧠 正在调用 ${this.model} 模型...`);

    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature,
        stream: true,
      });

      console.log("✅ 大语言模型响应成功:");
      const collectedContent: string[] = [];

      for await (const chunk of stream) {
        if (!chunk.choices?.length) {
          continue;
        }

        const content = chunk.choices[0]?.delta?.content || "";
        process.stdout.write(content);
        collectedContent.push(content);
      }

      console.log();
      return collectedContent.join("");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(`❌ 调用LLM API时发生错误: ${message}`);
      return null;
    }
  }
}

export { HelloAgentsLLM };
export type { ChatMessage, HelloAgentsLLMOptions };
