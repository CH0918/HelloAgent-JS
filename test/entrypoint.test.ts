import { afterEach, describe, expect, it, vi } from "vitest";

import "./helpers/openai-mock.js";

const originalEnv = { ...process.env };

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
