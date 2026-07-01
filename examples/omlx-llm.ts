/// <reference types="node" />

import { MyLLM } from "../src/my-llm.js";

/**
 * OMLX 示例 — 使用自动检测机制。
 *
 * 无需显式指定 provider，框架会根据环境变量自动推断：
 *   - 发现 OMLX_API_KEY 环境变量 → 自动识别为 "omlx"
 *   - 或通过 LLM_BASE_URL 中的 :8888 端口 → 自动识别为 "omlx"
 *
 * 运行方式：
 *   npm run example:omlx
 */
async function main(): Promise<void> {
  // 不传 provider，自动检测机制会根据 OMLX_API_KEY 环境变量
  // 或 LLM_BASE_URL 端口 (:8888) 自动识别为 omlx provider
  const llm = new MyLLM();

  const response = await llm.think(
    [
      {
        role: "system",
        content: "你是一个简洁的中文助手。",
      },
      {
        role: "user",
        content: "你的知识库截止到什么时候？",
      },
    ],
    0,
  );

  if (!response) {
    process.exitCode = 1;
    return;
  }

  console.log("\n\n--- OMLX 示例调用结果 ---");
  console.log(response);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`OMLX 示例运行失败: ${message}`);
  process.exitCode = 1;
});
