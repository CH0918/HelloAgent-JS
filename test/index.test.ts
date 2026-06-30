import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openAiMock = vi.hoisted(() => {
  const create = vi.fn();
  const constructor = vi.fn();

  class MockOpenAI {
    chat = {
      completions: {
        create,
      },
    };

    constructor(options: unknown) {
      constructor(options);
    }
  }

  return {
    create,
    constructor,
    MockOpenAI,
  };
});

vi.mock("openai", () => ({
  default: openAiMock.MockOpenAI,
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("入口模块", () => {
  it("作为库导入时不会执行命令行入口", async () => {
    delete process.env.LLM_MODEL_ID;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    process.env.DOTENV_CONFIG_PATH = "/tmp/helloagent-js-vitest-empty-env";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await import("../src/index.js");
    await new Promise((resolve) => setImmediate(resolve));

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

describe("HelloAgentsLLM", () => {
  it("优先使用构造参数创建 OpenAI 兼容客户端", async () => {
    const { HelloAgentsLLM } = await import("../src/index.js");

    new HelloAgentsLLM({
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

  it("构造参数缺失时读取环境变量并使用默认超时时间", async () => {
    process.env.LLM_MODEL_ID = "env-model";
    process.env.LLM_API_KEY = "env-api-key";
    process.env.LLM_BASE_URL = "https://env.example.test/v1";
    delete process.env.LLM_TIMEOUT;

    const { HelloAgentsLLM } = await import("../src/index.js");

    new HelloAgentsLLM();

    expect(openAiMock.constructor).toHaveBeenCalledWith({
      apiKey: "env-api-key",
      baseURL: "https://env.example.test/v1",
      timeout: 60_000,
    });
  });

  it("缺少模型、密钥或服务地址时抛出配置错误", async () => {
    delete process.env.LLM_MODEL_ID;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;

    const { HelloAgentsLLM } = await import("../src/index.js");

    expect(() => new HelloAgentsLLM()).toThrow(
      "模型ID、API密钥和服务地址必须被提供或在.env文件中定义。",
    );
  });

  it("think 会发送流式请求并拼接模型响应", async () => {
    const { HelloAgentsLLM } = await import("../src/index.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    openAiMock.create.mockResolvedValueOnce(
      (async function* () {
        yield { choices: [{ delta: { content: "你好" } }] };
        yield { choices: [] };
        yield { choices: [{ delta: { content: "，世界" } }] };
      })(),
    );

    const llm = new HelloAgentsLLM({
      model: "stream-model",
      apiKey: "test-api-key",
      baseUrl: "https://example.test/v1",
    });

    const result = await llm.think([{ role: "user", content: "打招呼" }], 0.7);

    expect(openAiMock.create).toHaveBeenCalledWith({
      model: "stream-model",
      messages: [{ role: "user", content: "打招呼" }],
      temperature: 0.7,
      stream: true,
    });
    expect(stdoutSpy).toHaveBeenNthCalledWith(1, "你好");
    expect(stdoutSpy).toHaveBeenNthCalledWith(2, "，世界");
    expect(result).toBe("你好，世界");
    expect(logSpy).toHaveBeenCalledWith("✅ 大语言模型响应成功:");
  });

  it("think 请求失败时返回 null 并输出错误信息", async () => {
    const { HelloAgentsLLM } = await import("../src/index.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    openAiMock.create.mockRejectedValueOnce(new Error("接口不可用"));

    const llm = new HelloAgentsLLM({
      model: "error-model",
      apiKey: "test-api-key",
      baseUrl: "https://example.test/v1",
    });

    const result = await llm.think([{ role: "user", content: "打招呼" }]);

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("❌ 调用LLM API时发生错误: 接口不可用");
    expect(logSpy).toHaveBeenCalledWith("🧠 正在调用 error-model 模型...");
  });
});
