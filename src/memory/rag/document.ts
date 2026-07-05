import { dynamicImport, estimateTokens, hashString } from "../utils.js";
import type { LoadAndChunkOptions, RAGChunk, RAGDocument, RAGDocumentProcessorOptions } from "./types.js";

interface FileSystemPromises {
  readFile(path: string, encoding: BufferEncodingName): Promise<string>;
}

type BufferEncodingName = "utf-8" | "utf8" | "latin1";

interface Paragraph {
  content: string;
  headingPath?: string;
  start: number;
  end: number;
}

interface ChunkDraft {
  content: string;
  headingPath?: string;
  start: number;
  end: number;
}

export class DocumentProcessor {
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  readonly minChunkLength: number;

  constructor(options: RAGDocumentProcessorOptions = {}) {
    this.chunkSize = options.chunkSize ?? 800;
    this.chunkOverlap = options.chunkOverlap ?? 100;
    this.minChunkLength = options.minChunkLength ?? 20;
  }

  processDocument(document: RAGDocument): RAGChunk[] {
    const paragraphs = splitParagraphsWithHeadings(document.content);
    const drafts = chunkParagraphs(paragraphs, this.chunkSize, this.chunkOverlap);
    const chunks: RAGChunk[] = [];
    const seenHashes = new Set<string>();

    for (const draft of drafts) {
      const normalized = draft.content.trim();
      if (normalized.length < this.minChunkLength) {
        continue;
      }

      const contentHash = stableHash(normalized);
      if (seenHashes.has(contentHash)) {
        continue;
      }
      seenHashes.add(contentHash);

      const chunkIndex = chunks.length;
      const id = stableHash(`${document.docId}|${chunkIndex}|${draft.start}|${draft.end}|${contentHash}`);
      chunks.push({
        id,
        content: normalized,
        docId: document.docId,
        chunkIndex,
        start: draft.start,
        end: draft.end,
        headingPath: draft.headingPath,
        metadata: {
          ...document.metadata,
          doc_id: document.docId,
          chunk_index: chunkIndex,
          start: draft.start,
          end: draft.end,
          content_hash: contentHash,
          heading_path: draft.headingPath,
          total_chunks: drafts.length,
          processed_at: new Date().toISOString(),
        },
      });
    }

    return chunks.map((chunk) => ({
      ...chunk,
      metadata: {
        ...chunk.metadata,
        total_chunks: chunks.length,
      },
    }));
  }

  processDocuments(documents: RAGDocument[]): RAGChunk[] {
    return documents.flatMap((document) => this.processDocument(document));
  }
}

export function createDocument(content: string, metadata: Record<string, unknown> = {}, docId?: string): RAGDocument {
  return {
    content,
    metadata,
    docId: docId ?? stableHash(content),
  };
}

export async function loadTextFile(filePath: string, encoding: BufferEncodingName = "utf-8"): Promise<RAGDocument> {
  const fs = await dynamicImport<FileSystemPromises>("node:fs/promises");
  const content = await fs.readFile(filePath, encoding);
  return createDocument(content, {
    source_path: filePath,
    source: "file",
    file_ext: getFileExtension(filePath),
    loaded_at: new Date().toISOString(),
    format: isMarkdownFile(filePath) ? "markdown" : "text",
  });
}

export async function loadAndChunkTexts(paths: string[], options: LoadAndChunkOptions = {}): Promise<RAGChunk[]> {
  const processor = new DocumentProcessor(options);
  const allChunks: RAGChunk[] = [];
  const globalHashes = new Set<string>();

  for (const path of paths) {
    let document: RAGDocument;
    try {
      document = await loadTextFile(path);
    } catch {
      continue;
    }

    const chunks = processor.processDocument({
      ...document,
      metadata: {
        ...document.metadata,
        namespace: options.namespace ?? "default",
        source: options.sourceLabel ?? document.metadata.source ?? "rag",
        external: true,
      },
    });

    for (const chunk of chunks) {
      const contentHash = String(chunk.metadata.content_hash ?? stableHash(chunk.content));
      if (globalHashes.has(contentHash)) {
        continue;
      }
      globalHashes.add(contentHash);
      allChunks.push(chunk);
    }
  }

  return allChunks;
}

export function splitParagraphsWithHeadings(text: string): Paragraph[] {
  const lines = text.split(/\r?\n/);
  const headings: string[] = [];
  const paragraphs: Paragraph[] = [];
  let buffer: string[] = [];
  let bufferStart = 0;
  let charPos = 0;

  const flush = (endPos: number): void => {
    const content = buffer.join("\n").trim();
    if (content.length > 0) {
      paragraphs.push({
        content,
        headingPath: headings.length > 0 ? headings.join(" > ") : undefined,
        start: bufferStart,
        end: endPos,
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const heading = parseMarkdownHeading(trimmed);

    if (heading) {
      flush(charPos);
      const parentDepth = Math.max(0, Math.min(heading.level - 1, headings.length));
      headings.splice(parentDepth);
      headings.push(heading.title);
      charPos += line.length + 1;
      continue;
    }

    if (trimmed.length === 0) {
      flush(charPos);
      charPos += line.length + 1;
      continue;
    }

    if (buffer.length === 0) {
      bufferStart = charPos;
    }
    buffer.push(line);
    charPos += line.length + 1;
  }

  flush(charPos);
  return paragraphs.length > 0
    ? paragraphs
    : [
        {
          content: text,
          start: 0,
          end: text.length,
        },
      ];
}

export function preprocessMarkdownForEmbedding(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/\n\s*\n/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function chunkParagraphs(paragraphs: Paragraph[], chunkTokens: number, overlapTokens: number): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  let current: Paragraph[] = [];
  let currentTokens = 0;

  const emit = (): void => {
    if (current.length === 0) {
      return;
    }
    const content = current.map((item) => item.content).join("\n\n");
    chunks.push({
      content,
      headingPath: findLastHeading(current),
      start: current[0]?.start ?? 0,
      end: current.at(-1)?.end ?? content.length,
    });
    current = buildOverlapTail(current, overlapTokens);
    currentTokens = current.reduce((total, item) => total + Math.max(1, estimateTokens(item.content)), 0);
  };

  for (const paragraph of paragraphs) {
    const paragraphTokens = Math.max(1, estimateTokens(paragraph.content));

    if (paragraphTokens > chunkTokens) {
      emit();
      chunks.push(...splitLargeParagraph(paragraph, chunkTokens, overlapTokens));
      current = [];
      currentTokens = 0;
      continue;
    }

    if (currentTokens + paragraphTokens > chunkTokens && current.length > 0) {
      emit();
    }

    current.push(paragraph);
    currentTokens += paragraphTokens;
  }

  emit();
  return chunks;
}

function splitLargeParagraph(paragraph: Paragraph, chunkTokens: number, overlapTokens: number): ChunkDraft[] {
  const maxChars = Math.max(120, chunkTokens * 3);
  const overlapChars = Math.min(Math.floor(maxChars / 2), Math.max(0, overlapTokens * 3));
  const chunks: ChunkDraft[] = [];
  let startOffset = 0;

  while (startOffset < paragraph.content.length) {
    const endOffset = Math.min(paragraph.content.length, startOffset + maxChars);
    const content = paragraph.content.slice(startOffset, endOffset).trim();
    if (content.length > 0) {
      chunks.push({
        content,
        headingPath: paragraph.headingPath,
        start: paragraph.start + startOffset,
        end: paragraph.start + endOffset,
      });
    }

    if (endOffset >= paragraph.content.length) {
      break;
    }
    startOffset = Math.max(startOffset + 1, endOffset - overlapChars);
  }

  return chunks;
}

function buildOverlapTail(paragraphs: Paragraph[], overlapTokens: number): Paragraph[] {
  if (overlapTokens <= 0) {
    return [];
  }

  const tail: Paragraph[] = [];
  let tokens = 0;
  for (const paragraph of [...paragraphs].reverse()) {
    const paragraphTokens = Math.max(1, estimateTokens(paragraph.content));
    if (tokens + paragraphTokens > overlapTokens) {
      break;
    }
    tail.push(paragraph);
    tokens += paragraphTokens;
  }
  return tail.reverse();
}

function parseMarkdownHeading(line: string): { level: number; title: string } | undefined {
  const match = /^(#{1,6})\s+(.+)$/.exec(line);
  if (!match) {
    return undefined;
  }
  return {
    level: match[1]?.length ?? 1,
    title: match[2]?.trim() ?? "",
  };
}

function findLastHeading(paragraphs: Paragraph[]): string | undefined {
  for (const paragraph of [...paragraphs].reverse()) {
    if (paragraph.headingPath) {
      return paragraph.headingPath;
    }
  }
  return undefined;
}

function getFileExtension(path: string): string {
  const cleanPath = path.split(/[?#]/)[0] ?? path;
  const index = cleanPath.lastIndexOf(".");
  return index >= 0 ? cleanPath.slice(index).toLowerCase() : "";
}

function isMarkdownFile(path: string): boolean {
  return [".md", ".markdown", ".mdx"].includes(getFileExtension(path));
}

function stableHash(input: string): string {
  return `rag_${hashString(input).toString(16).padStart(8, "0")}`;
}
