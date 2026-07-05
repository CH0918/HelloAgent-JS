/**
 * 真实使用示例 -- 完整记忆系统
 *
 * 默认运行只验证 WorkingMemory + MemoryTool，这条路径不需要 SQLite、Qdrant 或 Neo4j。
 *
 * 如果要验证完整 Python 对齐链路，需要先安装可选依赖并准备后端：
 *
 *   pnpm add -w better-sqlite3 neo4j-driver @xenova/transformers
 *   docker run -p 6333:6333 qdrant/qdrant
 *   docker run -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/hello-agents-password neo4j:5
 *
 * 然后在 examples/.env 中配置：
 *
 *   RUN_FULL_MEMORY_DEMO=1
 *   EMBED_MODEL_TYPE=tfidf
 *   QDRANT_URL=http://localhost:6333
 *   NEO4J_URI=bolt://localhost:7687
 *   NEO4J_USERNAME=neo4j
 *   NEO4J_PASSWORD=hello-agents-password
 *
 * 如果要使用 OpenRouter 或其他 OpenAI-compatible embedding 服务，可以改成：
 *
 *   EMBED_MODEL_TYPE=openrouter
 *   EMBED_MODEL_NAME=openai/text-embedding-3-small
 *   EMBED_API_KEY=your-api-key
 *   EMBED_BASE_URL=https://openrouter.ai/api/v1
 *   EMBED_DIMENSION=1536
 *
 * 运行：
 *   pnpm build
 *   node examples/09-memory-system.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

import {
  MemoryConfig,
  MemoryItem,
  MemoryTool,
  EpisodicMemory,
  SemanticMemory,
  PerceptualMemory,
} from "../dist/index.js";

async function demoWorkingMemoryTool() {
  console.log("== WorkingMemory + MemoryTool ==");
  const memoryTool = new MemoryTool({
    userId: "demo_user_001",
    memoryTypes: ["working"],
    memoryConfig: new MemoryConfig({
      workingMemoryCapacity: 6,
      workingMemoryTokens: 800,
      workingMemoryTtlMinutes: 120,
    }),
  });

  const profile = await memoryTool.run({
    action: "add",
    content: "用户李明是软件工程师，主要做 TypeScript 和 Python 开发。",
    memory_type: "working",
    importance: 0.8,
  });
  console.log("===profile===" + profile);

  await memoryTool.autoRecordConversation(
    "我最近在学习向量数据库，尤其是 Qdrant。",
    "可以先理解向量、payload 过滤和相似度检索，再做一个小知识库。",
  );

  const searchResult = await memoryTool.run({
    action: "search",
    query: "李明 TypeScript Qdrant",
    memory_type: "working",
    limit: 5,
  });
  console.log("\n=======searchResult" + searchResult);

  const summary = await memoryTool.run({ action: "summary" });
  console.log("\n" + summary);
}

async function demoFullMemoryBackends() {
  if (process.env.RUN_FULL_MEMORY_DEMO !== "1") {
    console.log("\n== 完整后端验证已跳过 ==");
    console.log("设置 RUN_FULL_MEMORY_DEMO=1 后，会验证 EpisodicMemory、SemanticMemory 和 PerceptualMemory。");
    return;
  }

  console.log("\n== EpisodicMemory: SQLite + Qdrant ==");
  const config = new MemoryConfig({
    storagePath: "./examples-memory-data",
    perceptualMemoryModalities: ["text", "image", "audio"],
  });

  const episodic = new EpisodicMemory(config);
  await episodic.add(
    new MemoryItem({
      id: "episode_demo_1",
      content: "昨天晚上做了一次线上事故复盘，定位到缓存雪崩，后续追加了限流。",
      memoryType: "episodic",
      userId: "demo_user_001",
      importance: 0.9,
      metadata: {
        session_id: "session_incident",
        tags: ["incident", "cache"],
      },
    }),
  );
  const episodes = await episodic.retrieve("线上事故 缓存", 3, { userId: "demo_user_001" });
  console.log(episodes.map((item) => ({ id: item.id, content: item.content, score: item.metadata.relevance_score })));

  console.log("\n== SemanticMemory: Qdrant + Neo4j ==");
  const semantic = new SemanticMemory(config);
  await semantic.add(
    new MemoryItem({
      id: "semantic_demo_1",
      content: "李明是腾讯的资深工程师，擅长 TypeScript、Python 和机器学习。",
      memoryType: "semantic",
      userId: "demo_user_001",
      importance: 0.85,
      metadata: {},
    }),
  );
  const semanticResults = await semantic.retrieve("腾讯 工程师 TypeScript", 3, { userId: "demo_user_001" });
  console.log(semanticResults.map((item) => ({ id: item.id, content: item.content, score: item.metadata.combined_score })));

  console.log("\n== PerceptualMemory: SQLite + Qdrant per modality ==");
  const perceptual = new PerceptualMemory(config);
  await perceptual.add(
    new MemoryItem({
      id: "perceptual_text_demo_1",
      content: "用户上传了一张包含 Qdrant 架构图的截图。",
      memoryType: "perceptual",
      userId: "demo_user_001",
      importance: 0.7,
      metadata: {
        modality: "text",
        raw_data: "Qdrant architecture diagram screenshot",
      },
    }),
  );
  const perceptualResults = await perceptual.retrieve("Qdrant 架构图", 3, {
    targetModality: "text",
    queryModality: "text",
  });
  console.log(perceptualResults.map((item) => ({ id: item.id, content: item.content, score: item.metadata.relevance_score })));
}

await demoWorkingMemoryTool();
await demoFullMemoryBackends();
