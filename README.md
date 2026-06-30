# HelloAgent-JS

JavaScript version of the Hello Agents LLM client.

## Setup

```bash
npm install
cp .env.example .env
```

Then fill in `.env`:

```env
LLM_MODEL_ID=your-model-id
LLM_API_KEY=your-api-key
LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
LLM_TIMEOUT=60
MODELSCOPE_API_KEY=your-modelscope-api-key
EVOLINK_API_KEY=your-evolink-api-key
OLLAMA_API_KEY=ollama
```

## Run

```bash
npm start
```

Run the local Ollama example:

```bash
pnpm example:ollama
```

## Custom Providers

```ts
import { MyLLM } from "./src/my-llm.js";

const modelscopeLLM = new MyLLM({
  provider: "modelscope",
});

const evolinkLLM = new MyLLM({
  provider: "evolink",
  model: "your-evolink-model-id",
});

const ollamaLLM = new MyLLM({
  provider: "ollama",
});
```

`MyLLM` extends `HelloAgentsLLM`. When `provider` is `modelscope`, it reads
`MODELSCOPE_API_KEY`, uses
`https://api-inference.modelscope.cn/v1/`, and defaults to
`Qwen/Qwen2.5-VL-72B-Instruct`.

When `provider` is `evolink`, it reads `EVOLINK_API_KEY` and uses
`https://direct.evolink.ai/v1` by default.

When `provider` is `ollama`, it uses the local OpenAI-compatible Ollama
endpoint `http://localhost:11434/v1`, defaults to `qwen3:8b`, and does not
require a real API key. You can override the model and endpoint with `model`
and `baseUrl`.
