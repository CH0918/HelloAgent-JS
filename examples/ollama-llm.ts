import { MyLLM } from "../src/my-llm.js";

async function main(): Promise<void> {
  const llm = new MyLLM({
    provider: "ollama",
    model: "qwen3:8b",
  });

  const response = await llm.think(
    [
      {
        role: 'system',
        content: '你是一个简洁的中文助手。',
      },
      {
        role: 'user',
        content: '你的知识库截止到什么时候？',
      },
    ],
    0,
  );

  if (!response) {
    process.exitCode = 1;
    return;
  }

  console.log("\n\n--- Ollama 示例调用结果 ---");
  console.log(response);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Ollama 示例运行失败: ${message}`);
  process.exitCode = 1;
});
