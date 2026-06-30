import { HelloAgentsLLM } from "../src/index.js";

async function main(): Promise<void> {
  const llm = new HelloAgentsLLM();

  const response = await llm.think(
    [
      {
        role: "system",
        content: "你是一个中文问答助手。",
      },
      {
        role: "user",
        content: "100字左右介绍下agent有什么用",
      },
    ],
    0,
  );

  if (!response) {
    process.exitCode = 1;
    return;
  }

  console.log("\n\n--- 示例调用结果 ---");
  console.log(response);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`示例运行失败: ${message}`);
  process.exitCode = 1;
});
