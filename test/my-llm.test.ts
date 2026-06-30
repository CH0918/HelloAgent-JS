import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openAiMock } from "./helpers/openai-mock.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("MyLLM", () => {
  it("ModelScope Provider 会使用专属密钥、默认服务地址和默认模型", async () => {
    process.env.MODELSCOPE_API_KEY = "modelscope-api-key";
    process.env.LLM_MODEL_ID = "";
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { MyLLM } = await import("../src/my-llm.js");

    const llm = new MyLLM({
      provider: "modelscope",
    });

    expect(openAiMock.constructor).toHaveBeenLastCalledWith({
      apiKey: "modelscope-api-key",
      baseURL: "https://api-inference.modelscope.cn/v1/",
      timeout: 60_000,
    });
    expect(logSpy).toHaveBeenCalledWith("正在使用自定义的 ModelScope Provider");

    openAiMock.create.mockResolvedValueOnce(
      (async function* () {
        yield { choices: [{ delta: { content: "完成" } }] };
      })(),
    );
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await llm.think([{ role: "user", content: "测试" }]);

    expect(openAiMock.create).toHaveBeenCalledWith({
      model: "Qwen/Qwen2.5-VL-72B-Instruct",
      messages: [{ role: "user", content: "测试" }],
      temperature: 0.7,
      stream: true,
    });
  });

  it("ModelScope Provider 缺少专属密钥时抛出配置错误", async () => {
    delete process.env.MODELSCOPE_API_KEY;
    const { MyLLM } = await import("../src/my-llm.js");

    expect(() => new MyLLM({ provider: "modelscope" })).toThrow(
      "ModelScope API key not found. Please set MODELSCOPE_API_KEY environment variable.",
    );
  });

  it("Evolink Provider 会使用专属密钥、默认服务地址和模型", async () => {
    process.env.EVOLINK_API_KEY = "evolink-api-key";
    process.env.LLM_MODEL_ID = "evolink-model";
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { MyLLM } = await import("../src/my-llm.js");

    const llm = new MyLLM({
      provider: "evolink",
      timeout: 15,
    });

    expect(openAiMock.constructor).toHaveBeenLastCalledWith({
      apiKey: "evolink-api-key",
      baseURL: "https://direct.evolink.ai/v1",
      timeout: 15_000,
    });
    expect(logSpy).toHaveBeenCalledWith("正在使用自定义的 Evolink Provider");

    openAiMock.create.mockResolvedValueOnce(
      (async function* () {
        yield { choices: [{ delta: { content: "完成" } }] };
      })(),
    );
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await llm.think([{ role: "user", content: "测试" }]);

    expect(openAiMock.create).toHaveBeenCalledWith({
      model: "evolink-model",
      messages: [{ role: "user", content: "测试" }],
      temperature: 0.7,
      stream: true,
    });
  });

  it("Evolink Provider 未传模型且环境变量没有模型时使用默认模型", async () => {
    process.env.EVOLINK_API_KEY = "evolink-api-key";
    process.env.LLM_MODEL_ID = "";
    const { MyLLM } = await import("../src/my-llm.js");
    vi.spyOn(console, "log").mockImplementation(() => {});
    openAiMock.create.mockResolvedValueOnce(
      (async function* () {
        yield { choices: [{ delta: { content: "完成" } }] };
      })(),
    );
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const llm = new MyLLM({
      provider: "evolink",
    });

    await llm.think([{ role: "user", content: "测试" }]);

    expect(openAiMock.create).toHaveBeenCalledWith({
      model: "gemini-2.5-flash-lite",
      messages: [{ role: "user", content: "测试" }],
      temperature: 0.7,
      stream: true,
    });
  });

  it("Evolink Provider 缺少专属密钥时抛出配置错误", async () => {
    delete process.env.EVOLINK_API_KEY;
    const { MyLLM } = await import("../src/my-llm.js");

    expect(() => new MyLLM({ provider: "evolink", model: "evolink-model" })).toThrow(
      "Evolink API key not found. Please set EVOLINK_API_KEY environment variable.",
    );
  });

  it("Ollama Provider 会使用本地服务地址、占位密钥和默认模型", async () => {
    process.env.LLM_MODEL_ID = "";
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.OLLAMA_API_KEY;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { MyLLM } = await import("../src/my-llm.js");

    const llm = new MyLLM({
      provider: "ollama",
    });

    expect(openAiMock.constructor).toHaveBeenLastCalledWith({
      apiKey: "ollama",
      baseURL: "http://localhost:11434/v1",
      timeout: 60_000,
    });
    expect(logSpy).toHaveBeenCalledWith("正在使用自定义的 Ollama Provider");

    openAiMock.create.mockResolvedValueOnce(
      (async function* () {
        yield { choices: [{ delta: { content: "完成" } }] };
      })(),
    );
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await llm.think([{ role: "user", content: "测试" }]);

    expect(openAiMock.create).toHaveBeenCalledWith({
      model: "qwen3:8b",
      messages: [{ role: "user", content: "测试" }],
      temperature: 0.7,
      stream: true,
    });
  });

  it("非自定义 Provider 时沿用 HelloAgentsLLM 原始逻辑", async () => {
    const { MyLLM } = await import("../src/my-llm.js");

    new MyLLM({
      provider: "auto",
      model: "test-model",
      apiKey: "test-api-key",
      baseUrl: "https://example.test/v1",
      timeout: 12,
    });

    expect(openAiMock.constructor).toHaveBeenCalledWith({
      apiKey: "test-api-key",
      baseURL: "https://example.test/v1",
      timeout: 12_000,
    });
  });
});
