import OpenAI from "openai";
import "dotenv/config";

class HelloAgentsLLM {
  /**
   * 为本书 "Hello Agents" 定制的 LLM 客户端。
   * 它用于调用任何兼容 OpenAI 接口的服务，并默认使用流式响应。
   */
  constructor({ model, apiKey, baseUrl, timeout } = {}) {
    this.model = model || process.env.LLM_MODEL_ID;
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
   * @param {Array<{role: string, content: string}>} messages
   * @param {number} temperature
   * @returns {Promise<string|null>}
   */
  async think(messages, temperature = 0) {
    console.log(`🧠 正在调用 ${this.model} 模型...`);

    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature,
        stream: true,
      });

      console.log("✅ 大语言模型响应成功:");
      const collectedContent = [];

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
      console.error(`❌ 调用LLM API时发生错误: ${error.message}`);
      return null;
    }
  }
}

async function main() {
  try {
    const llmClient = new HelloAgentsLLM();

    const exampleMessages = [
      { role: "system", content: "You are a helpful assistant that writes JavaScript code." },
      { role: "user", content: "写一个快速排序算法" },
    ];

    console.log("--- 调用LLM ---");
    const responseText = await llmClient.think(exampleMessages);

    if (responseText) {
      console.log("\n\n--- 完整模型响应 ---");
      console.log(responseText);
    }
  } catch (error) {
    console.error(error.message);
  }
}

main();

export { HelloAgentsLLM };
