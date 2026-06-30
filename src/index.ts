import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HelloAgentsLLM, type ChatMessage } from "./hello-agents-llm.js";

async function main(): Promise<void> {
  try {
    const llmClient = new HelloAgentsLLM();

    const exampleMessages: ChatMessage[] = [
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
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(message);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}

export { HelloAgentsLLM } from "./hello-agents-llm.js";
export { MyLLM } from "./my-llm.js";
export type { ChatMessage, HelloAgentsLLMOptions } from "./hello-agents-llm.js";
export type { MyLLMOptions } from "./my-llm.js";
