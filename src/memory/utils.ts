export type Env = Record<string, string | undefined>;

export function currentEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

export async function dynamicImport<T = unknown>(specifier: string): Promise<T> {
  const importer = new Function("specifier", "return import(specifier)") as (value: string) => Promise<T>;
  return importer(specifier);
}

export function generateId(prefix = ""): string {
  const random = Math.random().toString(16).slice(2);
  const time = Date.now().toString(16);
  return `${prefix}${time}-${random.slice(0, 4)}-${random.slice(4, 8)}-${random.slice(8, 12)}-${random.slice(12, 24)}`;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function readNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readInteger(value: string | undefined, fallback: number): number {
  const parsed = readNumber(value, Number.NaN);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const size = Math.min(a.length, b.length);
  if (size === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < size; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function normalizeVector(vector: readonly number[], dimension: number): number[] {
  const normalized = vector.slice(0, dimension).map((value) => Number(value) || 0);
  while (normalized.length < dimension) {
    normalized.push(0);
  }
  return normalized;
}

export function hashString(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hashToVector(input: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  const seed = hashString(input || "empty");

  for (let index = 0; index < dimension; index += 1) {
    const mixed = hashString(`${seed}:${index}:${input.slice(index % Math.max(input.length, 1))}`);
    vector[index] = (mixed / 0xffffffff) * 2 - 1;
  }

  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

export function tokenize(text: string): string[] {
  const cjkChars = text.match(/[\u3400-\u9fff]/g) ?? [];
  const words = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return [...words, ...cjkChars];
}

export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const nonCjk = text.replace(/[\u3400-\u9fff]/g, " ");
  return cjk + nonCjk.split(/\s+/).filter(Boolean).length;
}

export function dirname(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "." : normalized.slice(0, index);
}

export async function ensureDirectory(path: string): Promise<void> {
  const fs = await dynamicImport<{ mkdir(path: string, options: { recursive: boolean }): Promise<void> }>("node:fs/promises");
  await fs.mkdir(path, { recursive: true });
}

export async function readBinaryLike(pathOrData: unknown): Promise<string> {
  if (typeof pathOrData !== "string") {
    return String(pathOrData);
  }

  try {
    const fs = await dynamicImport<{ readFile(path: string): Promise<{ toString(encoding: string): string }> }>(
      "node:fs/promises",
    );
    const buffer = await fs.readFile(pathOrData);
    return buffer.toString("base64");
  } catch {
    return pathOrData;
  }
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
