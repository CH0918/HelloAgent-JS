import { Tool } from "../base.js";
import type { ToolParameter, ToolParameters } from "../base.js";

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_TOKENS_PER_SOURCE = 2000;
const DEFAULT_TAVILY_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_SERPAPI_ENDPOINT = "https://serpapi.com/search.json";
const DEFAULT_DUCKDUCKGO_ENDPOINT = "https://api.duckduckgo.com/";
const DEFAULT_SEARXNG_URL = "http://localhost:8888";
const DEFAULT_PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/v1/sonar";

export const SUPPORTED_SEARCH_BACKENDS = [
  "hybrid",
  "advanced",
  "tavily",
  "serpapi",
  "duckduckgo",
  "searxng",
  "perplexity",
] as const;

export const SUPPORTED_SEARCH_RETURN_MODES = ["text", "structured", "json", "dict"] as const;

export type SearchBackend = (typeof SUPPORTED_SEARCH_BACKENDS)[number];
export type SearchReturnMode = (typeof SUPPORTED_SEARCH_RETURN_MODES)[number];

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score?: number;
  source?: string;
  publishedDate?: string;
}

export interface SearchResponse {
  query: string;
  backend: string;
  answer?: string;
  results: SearchResult[];
  notices: string[];
}

export interface SearchToolOptions {
  backend?: SearchBackend;
  tavilyApiKey?: string;
  serpApiKey?: string;
  perplexityApiKey?: string;
  searxngUrl?: string;
  tavilyEndpoint?: string;
  serpApiEndpoint?: string;
  duckDuckGoEndpoint?: string;
  perplexityEndpoint?: string;
  tavilySearchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
  serpApiGl?: string;
  serpApiHl?: string;
  searxngLanguage?: string;
  perplexityModel?: string;
  env?: Record<string, string | undefined>;
  fetcher?: SearchFetchLike;
}

interface SearchRequest {
  query: string;
  backend: SearchBackend;
  fetchFullPage: boolean;
  maxResults: number;
  maxTokensPerSource: number;
  loopCount: number;
  parameters: ToolParameters;
}

export interface SearchFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

export type SearchFetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<SearchFetchResponse>;

type Env = Record<string, string | undefined>;
type JsonObject = Record<string, unknown>;

function currentEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

function getGlobalFetch(): SearchFetchLike | undefined {
  return (globalThis as { fetch?: SearchFetchLike }).fetch;
}

function hasValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return ["true", "1", "yes", "y"].includes(value.toLowerCase());
  }
  return fallback;
}

function readInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) ? parsed : fallback;
}

function readParameter(parameters: ToolParameters, names: string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(parameters, name)) {
      return parameters[name];
    }
  }
  return undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeBackend(value: string | undefined, fallback: SearchBackend): SearchBackend {
  const candidate = value?.toLowerCase();
  return SUPPORTED_SEARCH_BACKENDS.includes(candidate as SearchBackend) ? (candidate as SearchBackend) : fallback;
}

function normalizeMode(value: string | undefined): SearchReturnMode {
  const candidate = value?.toLowerCase();
  return SUPPORTED_SEARCH_RETURN_MODES.includes(candidate as SearchReturnMode) ? (candidate as SearchReturnMode) : "text";
}

function encodeQuery(parameters: Record<string, string | number | boolean>): string {
  return Object.entries(parameters)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function limitText(text: string, tokenLimit: number): string {
  const charLimit = tokenLimit * CHARS_PER_TOKEN;
  return text.length <= charLimit ? text : `${text.slice(0, charLimit)}... [truncated]`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeResult(input: {
  title?: string;
  url?: string;
  content?: string;
  rawContent?: string;
  score?: number;
  source?: string;
  publishedDate?: string;
}): SearchResult | undefined {
  const url = input.url ?? "";
  const title = input.title ?? url;
  if (!title && !url) {
    return undefined;
  }

  return {
    title,
    url,
    content: input.content ?? "",
    rawContent: input.rawContent,
    score: input.score,
    source: input.source,
    publishedDate: input.publishedDate,
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObjectArray(value: unknown): JsonObject[] {
  return asArray(value).filter(isObject);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = readString(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function getRequiredFetch(fetcher?: SearchFetchLike): SearchFetchLike {
  const fetch = fetcher ?? getGlobalFetch();
  if (!fetch) {
    throw new Error("当前运行环境不支持 fetch，无法执行网页搜索。请使用 Node.js 18+ 或传入自定义 fetcher。");
  }
  return fetch;
}

function prependNotices(response: SearchResponse, notices: string[]): SearchResponse {
  return {
    ...response,
    notices: [...notices, ...response.notices],
  };
}

export class SearchTool extends Tool {
  private readonly backend: SearchBackend;
  private readonly env: Env;
  private readonly fetcher?: SearchFetchLike;
  private readonly tavilyApiKey?: string;
  private readonly serpApiKey?: string;
  private readonly perplexityApiKey?: string;
  private readonly searxngUrl: string;
  private readonly tavilyEndpoint: string;
  private readonly serpApiEndpoint: string;
  private readonly duckDuckGoEndpoint: string;
  private readonly perplexityEndpoint: string;
  private readonly tavilySearchDepth: "basic" | "advanced" | "fast" | "ultra-fast";
  private readonly serpApiGl: string;
  private readonly serpApiHl: string;
  private readonly searxngLanguage: string;
  private readonly perplexityModel?: string;
  private readonly hasConfiguredSearxng: boolean;

  constructor(options: SearchToolOptions = {}) {
    super(
      "search",
      "智能网页搜索工具，支持 Tavily、SerpApi、DuckDuckGo、SearXNG、Perplexity 和 hybrid/advanced 组合搜索。",
    );

    this.env = options.env ?? currentEnv();
    this.backend = options.backend ?? normalizeBackend(this.env.SEARCH_BACKEND, "hybrid");
    this.fetcher = options.fetcher;
    this.tavilyApiKey = options.tavilyApiKey ?? this.env.TAVILY_API_KEY;
    this.serpApiKey = options.serpApiKey ?? this.env.SERPAPI_API_KEY;
    this.perplexityApiKey = options.perplexityApiKey ?? this.env.PERPLEXITY_API_KEY;
    this.searxngUrl = (options.searxngUrl ?? this.env.SEARXNG_URL ?? DEFAULT_SEARXNG_URL).replace(/\/+$/, "");
    this.tavilyEndpoint = options.tavilyEndpoint ?? this.env.TAVILY_ENDPOINT ?? DEFAULT_TAVILY_ENDPOINT;
    this.serpApiEndpoint = options.serpApiEndpoint ?? this.env.SERPAPI_ENDPOINT ?? DEFAULT_SERPAPI_ENDPOINT;
    this.duckDuckGoEndpoint = options.duckDuckGoEndpoint ?? this.env.DUCKDUCKGO_ENDPOINT ?? DEFAULT_DUCKDUCKGO_ENDPOINT;
    this.perplexityEndpoint =
      options.perplexityEndpoint ?? this.env.PERPLEXITY_ENDPOINT ?? DEFAULT_PERPLEXITY_ENDPOINT;
    this.tavilySearchDepth =
      options.tavilySearchDepth ??
      (this.env.TAVILY_SEARCH_DEPTH as SearchToolOptions["tavilySearchDepth"] | undefined) ??
      "basic";
    this.serpApiGl = options.serpApiGl ?? this.env.SERPAPI_GL ?? "cn";
    this.serpApiHl = options.serpApiHl ?? this.env.SERPAPI_HL ?? "zh-cn";
    this.searxngLanguage = options.searxngLanguage ?? this.env.SEARXNG_LANGUAGE ?? "zh-CN";
    this.perplexityModel = options.perplexityModel ?? this.env.PERPLEXITY_MODEL;
    this.hasConfiguredSearxng = hasValue(options.searxngUrl) || hasValue(this.env.SEARXNG_URL);
  }

  async run(parameters: ToolParameters): Promise<string> {
    try {
      const request = this.createRequest(parameters);
      const response = await this.searchWithRequest(request);
      const mode = normalizeMode(readString(readParameter(parameters, ["mode", "returnMode", "return_mode"])));

      if (mode === "structured" || mode === "json" || mode === "dict") {
        return JSON.stringify(response, null, 2);
      }

      return this.formatTextResponse(response);
    } catch (error) {
      return `搜索失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async search(parameters: ToolParameters): Promise<SearchResponse> {
    return this.searchWithRequest(this.createRequest(parameters));
  }

  getParameters(): ToolParameter[] {
    return [
      {
        name: "query",
        type: "string",
        description: "搜索查询关键词或问题",
        required: true,
      },
      {
        name: "backend",
        type: "string",
        description: "搜索后端：hybrid、advanced、tavily、serpapi、duckduckgo、searxng 或 perplexity",
        required: false,
        default: this.backend,
      },
      {
        name: "maxResults",
        type: "integer",
        description: "最多返回多少条搜索结果，范围 1 到 20",
        required: false,
        default: DEFAULT_MAX_RESULTS,
      },
      {
        name: "fetchFullPage",
        type: "boolean",
        description: "是否尝试抓取搜索结果页面正文",
        required: false,
        default: false,
      },
      {
        name: "mode",
        type: "string",
        description: "返回模式：text、structured、json 或 dict。Agent 默认使用 text",
        required: false,
        default: "text",
      },
    ];
  }

  private createRequest(parameters: ToolParameters): SearchRequest {
    const query = firstString(readParameter(parameters, ["query", "input"]));
    if (!query) {
      throw new Error("搜索查询不能为空");
    }

    const backend = normalizeBackend(readString(readParameter(parameters, ["backend"])), this.backend);
    const maxResults = clampInteger(
      readInteger(readParameter(parameters, ["maxResults", "max_results"]), DEFAULT_MAX_RESULTS),
      1,
      20,
    );
    const maxTokensPerSource = clampInteger(
      readInteger(
        readParameter(parameters, ["maxTokensPerSource", "max_tokens_per_source"]),
        DEFAULT_MAX_TOKENS_PER_SOURCE,
      ),
      100,
      8000,
    );

    return {
      query,
      backend,
      fetchFullPage: readBoolean(readParameter(parameters, ["fetchFullPage", "fetch_full_page"]), false),
      maxResults,
      maxTokensPerSource,
      loopCount: readInteger(readParameter(parameters, ["loopCount", "loop_count"]), 0),
      parameters,
    };
  }

  private async searchWithRequest(request: SearchRequest): Promise<SearchResponse> {
    const backend = request.backend === "hybrid" ? "advanced" : request.backend;

    if (backend === "tavily") {
      return this.searchTavily(request);
    }
    if (backend === "serpapi") {
      return this.searchSerpApi(request);
    }
    if (backend === "duckduckgo") {
      return this.searchDuckDuckGo(request);
    }
    if (backend === "searxng") {
      return this.searchSearxng(request);
    }
    if (backend === "perplexity") {
      return this.searchPerplexity(request);
    }

    return this.searchAdvanced(request);
  }

  private async searchTavily(request: SearchRequest): Promise<SearchResponse> {
    if (!hasValue(this.tavilyApiKey)) {
      throw new Error("TAVILY_API_KEY 未配置，无法使用 Tavily 搜索");
    }

    const payload = await this.fetchJson(this.tavilyEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.tavilyApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: request.query,
        max_results: request.maxResults,
        include_answer: true,
        include_raw_content: request.fetchFullPage,
        search_depth: this.tavilySearchDepth,
      }),
    });

    const data = isObject(payload) ? payload : {};
    const results = asObjectArray(data.results)
      .slice(0, request.maxResults)
      .map((item) =>
        normalizeResult({
          title: firstString(item.title, item.url),
          url: firstString(item.url) ?? "",
          content: firstString(item.content) ?? "",
          rawContent: this.limitOptionalText(firstString(item.raw_content, item.rawContent, item.content), request),
          score: firstNumber(item.score),
          source: firstString(item.source),
        }),
      )
      .filter((item): item is SearchResult => item !== undefined);

    return {
      query: request.query,
      backend: "tavily",
      answer: firstString(data.answer),
      results,
      notices: [],
    };
  }

  private async searchSerpApi(request: SearchRequest): Promise<SearchResponse> {
    if (!hasValue(this.serpApiKey)) {
      throw new Error("SERPAPI_API_KEY 未配置，无法使用 SerpApi 搜索");
    }

    const url = `${this.serpApiEndpoint}?${encodeQuery({
      engine: "google",
      q: request.query,
      api_key: this.serpApiKey,
      gl: this.serpApiGl,
      hl: this.serpApiHl,
      num: request.maxResults,
    })}`;
    const payload = await this.fetchJson(url);
    const data = isObject(payload) ? payload : {};
    const answerBox = isObject(data.answer_box) ? data.answer_box : {};
    const answer = firstString(answerBox.answer, answerBox.snippet, answerBox.title);
    const results = asObjectArray(data.organic_results)
      .slice(0, request.maxResults)
      .map((item) =>
        normalizeResult({
          title: firstString(item.title, item.link) ?? "",
          url: firstString(item.link) ?? "",
          content: firstString(item.snippet, item.description) ?? "",
          rawContent: this.limitOptionalText(firstString(item.snippet, item.description), request),
          source: "serpapi",
        }),
      )
      .filter((item): item is SearchResult => item !== undefined);

    return {
      query: request.query,
      backend: "serpapi",
      answer,
      results,
      notices: [],
    };
  }

  private async searchDuckDuckGo(request: SearchRequest): Promise<SearchResponse> {
    const url = `${this.duckDuckGoEndpoint}?${encodeQuery({
      q: request.query,
      format: "json",
      no_html: 1,
      skip_disambig: 1,
    })}`;
    const payload = await this.fetchJson(url);
    const data = isObject(payload) ? payload : {};
    const results: SearchResult[] = [];
    const notices: string[] = [];

    const abstractText = firstString(data.AbstractText, data.Abstract);
    const abstractUrl = firstString(data.AbstractURL);
    const heading = firstString(data.Heading) ?? request.query;
    if (abstractText || abstractUrl) {
      const rawContent =
        request.fetchFullPage && abstractUrl
          ? await this.fetchRawContent(abstractUrl, request.maxTokensPerSource)
          : abstractText;
      const result = normalizeResult({
        title: heading,
        url: abstractUrl ?? "",
        content: abstractText ?? "",
        rawContent,
        source: "duckduckgo",
      });
      if (result) {
        results.push(result);
      }
    }

    await this.collectDuckDuckGoTopics(data.RelatedTopics, request, results);
    const limited = results.slice(0, request.maxResults);
    if (limited.length === 0) {
      notices.push("DuckDuckGo Instant Answer API 未返回可用结果。");
    }

    return {
      query: request.query,
      backend: "duckduckgo",
      results: limited,
      notices,
    };
  }

  private async searchSearxng(request: SearchRequest): Promise<SearchResponse> {
    const url = `${this.searxngUrl}/search?${encodeQuery({
      q: request.query,
      format: "json",
      language: this.searxngLanguage,
      safesearch: 1,
      categories: "general",
    })}`;
    const payload = await this.fetchJson(url);
    const data = isObject(payload) ? payload : {};
    const results: SearchResult[] = [];

    for (const item of asObjectArray(data.results).slice(0, request.maxResults)) {
      const urlValue = firstString(item.url, item.link);
      const result = normalizeResult({
        title: firstString(item.title, urlValue) ?? "",
        url: urlValue ?? "",
        content: firstString(item.content, item.snippet) ?? "",
        rawContent:
          request.fetchFullPage && urlValue
            ? await this.fetchRawContent(urlValue, request.maxTokensPerSource)
            : firstString(item.content, item.snippet),
        score: firstNumber(item.score),
        source: firstString(item.engine, item.source) ?? "searxng",
        publishedDate: firstString(item.publishedDate, item.published_date),
      });
      if (result) {
        results.push(result);
      }
    }

    return {
      query: request.query,
      backend: "searxng",
      results,
      notices: [],
    };
  }

  private async searchPerplexity(request: SearchRequest): Promise<SearchResponse> {
    if (!hasValue(this.perplexityApiKey)) {
      throw new Error("PERPLEXITY_API_KEY 未配置，无法使用 Perplexity 搜索");
    }

    const body: JsonObject = {
      messages: [
        {
          role: "system",
          content: "Search the web and provide factual information with sources.",
        },
        {
          role: "user",
          content: request.query,
        },
      ],
    };
    const model = firstString(readParameter(request.parameters, ["model"]), this.perplexityModel);
    if (model) {
      body.model = model;
    }

    const payload = await this.fetchJson(this.perplexityEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.perplexityApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = isObject(payload) ? payload : {};
    const firstChoice = asObjectArray(data.choices)[0];
    const message = firstChoice && isObject(firstChoice.message) ? firstChoice.message : {};
    const answer = firstString(message.content);
    const searchResults = asObjectArray(data.search_results);
    const results =
      searchResults.length > 0
        ? searchResults.slice(0, request.maxResults).map((item) =>
            normalizeResult({
              title: firstString(item.title, item.url) ?? "",
              url: firstString(item.url) ?? "",
              content: firstString(item.snippet, item.content) ?? "",
              rawContent: request.fetchFullPage ? this.limitOptionalText(firstString(item.snippet, item.content), request) : undefined,
              source: firstString(item.source) ?? "perplexity",
              publishedDate: firstString(item.date, item.last_updated),
            }),
          )
        : asArray(data.citations)
            .slice(0, request.maxResults)
            .map((url, index) =>
              normalizeResult({
                title: `Perplexity Source ${request.loopCount + 1}-${index + 1}`,
                url: readString(url) ?? "",
                content: index === 0 ? answer ?? "" : "See main Perplexity response above.",
                rawContent: request.fetchFullPage && index === 0 && answer ? limitText(answer, request.maxTokensPerSource) : undefined,
                source: "perplexity",
              }),
            );

    return {
      query: request.query,
      backend: "perplexity",
      answer,
      results: results.filter((item): item is SearchResult => item !== undefined),
      notices: [],
    };
  }

  private async searchAdvanced(request: SearchRequest): Promise<SearchResponse> {
    const notices: string[] = [];

    if (hasValue(this.tavilyApiKey)) {
      try {
        const response = await this.searchTavily(request);
        if (response.results.length > 0 || response.answer) {
          return prependNotices(response, notices);
        }
        notices.push("Tavily 未返回有效结果，继续尝试其他搜索源。");
      } catch (error) {
        notices.push(`Tavily 搜索失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (hasValue(this.serpApiKey)) {
      try {
        const response = await this.searchSerpApi(request);
        if (response.results.length > 0 || response.answer) {
          return prependNotices(response, notices);
        }
        notices.push("SerpApi 未返回有效结果，继续尝试其他搜索源。");
      } catch (error) {
        notices.push(`SerpApi 搜索失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (this.hasConfiguredSearxng) {
      try {
        const response = await this.searchSearxng(request);
        if (response.results.length > 0 || response.answer) {
          return prependNotices(response, notices);
        }
        notices.push("SearXNG 未返回有效结果，继续尝试其他搜索源。");
      } catch (error) {
        notices.push(`SearXNG 搜索失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const response = await this.searchDuckDuckGo(request);
      if (response.results.length > 0 || response.answer) {
        return prependNotices(response, notices);
      }
      notices.push(...response.notices);
      notices.push("DuckDuckGo 未返回有效结果，继续尝试其他搜索源。");
    } catch (error) {
      notices.push(`DuckDuckGo 搜索失败：${error instanceof Error ? error.message : String(error)}`);
    }

    if (hasValue(this.perplexityApiKey)) {
      try {
        const response = await this.searchPerplexity(request);
        return prependNotices(response, notices);
      } catch (error) {
        notices.push(`Perplexity 搜索失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      query: request.query,
      backend: "advanced",
      results: [],
      notices,
    };
  }

  private async collectDuckDuckGoTopics(
    topics: unknown,
    request: SearchRequest,
    results: SearchResult[],
  ): Promise<void> {
    for (const topic of asArray(topics)) {
      if (results.length >= request.maxResults) {
        return;
      }
      if (!isObject(topic)) {
        continue;
      }
      if (Array.isArray(topic.Topics)) {
        await this.collectDuckDuckGoTopics(topic.Topics, request, results);
        continue;
      }

      const url = firstString(topic.FirstURL, topic.url);
      const text = firstString(topic.Text, topic.Result, topic.content);
      if (!url || !text) {
        continue;
      }

      const rawContent = request.fetchFullPage
        ? await this.fetchRawContent(url, request.maxTokensPerSource)
        : text;
      const result = normalizeResult({
        title: text.split(" - ")[0] ?? url,
        url,
        content: text,
        rawContent,
        source: "duckduckgo",
      });
      if (result) {
        results.push(result);
      }
    }
  }

  private limitOptionalText(value: string | undefined, request: SearchRequest): string | undefined {
    if (!value) {
      return undefined;
    }
    return request.fetchFullPage ? limitText(value, request.maxTokensPerSource) : value;
  }

  private async fetchJson(
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<unknown> {
    const response = await getRequiredFetch(this.fetcher)(url, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 240)}`);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`搜索服务返回的内容不是 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async fetchRawContent(url: string, maxTokens: number): Promise<string | undefined> {
    try {
      const response = await getRequiredFetch(this.fetcher)(url);
      const text = await response.text();
      if (!response.ok) {
        return undefined;
      }
      return limitText(stripHtml(text), maxTokens);
    } catch {
      return undefined;
    }
  }

  private formatTextResponse(response: SearchResponse): string {
    const lines = [`搜索关键词：${response.query}`, `使用搜索源：${response.backend}`];

    if (response.answer) {
      lines.push(`直接答案：${response.answer}`);
    }

    if (response.results.length > 0) {
      lines.push("", "参考来源：");
      response.results.forEach((item, index) => {
        lines.push(`[${index + 1}] ${item.title}`);
        if (item.content) {
          lines.push(`    摘要：${item.content}`);
        }
        if (item.url) {
          lines.push(`    来源：${item.url}`);
        }
        if (item.rawContent && item.rawContent !== item.content) {
          lines.push(`    正文：${item.rawContent}`);
        }
      });
    } else {
      lines.push("未找到相关搜索结果。");
    }

    if (response.notices.length > 0) {
      lines.push("", "注意事项：");
      response.notices.forEach((notice) => {
        lines.push(`- ${notice}`);
      });
    }

    return lines.join("\n");
  }
}

export async function search(query: string, backend: SearchBackend = "hybrid"): Promise<string> {
  return new SearchTool({ backend }).run({ query, backend });
}

export async function searchTavily(query: string): Promise<string> {
  return search(query, "tavily");
}

export async function searchSerpApi(query: string): Promise<string> {
  return search(query, "serpapi");
}

export async function searchDuckDuckGo(query: string): Promise<string> {
  return search(query, "duckduckgo");
}

export async function searchSearxng(query: string): Promise<string> {
  return search(query, "searxng");
}

export async function searchPerplexity(query: string): Promise<string> {
  return search(query, "perplexity");
}

export async function searchHybrid(query: string): Promise<string> {
  return search(query, "hybrid");
}
