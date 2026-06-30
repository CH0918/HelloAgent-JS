import { vi } from "vitest";

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

export { openAiMock };
