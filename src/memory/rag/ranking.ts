import type { QdrantSearchHit } from "../storage/index.js";
import type { RAGSearchResult } from "./types.js";

export function computeGraphSignalsFromHits(
  hits: QdrantSearchHit[],
  options: {
    sameDocWeight?: number;
    proximityWeight?: number;
    proximityWindowChars?: number;
  } = {},
): Map<string, number> {
  const sameDocWeight = options.sameDocWeight ?? 1;
  const proximityWeight = options.proximityWeight ?? 1;
  const proximityWindowChars = options.proximityWindowChars ?? 1600;
  const byDoc = new Map<string, QdrantSearchHit[]>();

  for (const hit of hits) {
    const docId = readString(hit.metadata.doc_id) ?? readString(hit.metadata.source_path) ?? String(hit.id);
    const existing = byDoc.get(docId) ?? [];
    existing.push(hit);
    byDoc.set(docId, existing);
  }

  const maxDocCount = Math.max(1, ...[...byDoc.values()].map((items) => items.length));
  const signals = new Map<string, number>();

  for (const items of byDoc.values()) {
    items.sort((left, right) => readNumber(left.metadata.start, 0) - readNumber(right.metadata.start, 0));
    const density = items.length / maxDocCount;

    for (const [index, item] of items.entries()) {
      const memoryId = getMemoryId(item);
      const start = readNumber(item.metadata.start, 0);
      let proximity = 0;

      for (const neighbor of [items[index - 1], items[index + 1]]) {
        if (!neighbor) {
          continue;
        }
        const distance = Math.abs(start - readNumber(neighbor.metadata.start, 0));
        if (distance <= proximityWindowChars) {
          proximity += Math.max(0, 1 - distance / Math.max(1, proximityWindowChars));
        }
      }

      signals.set(memoryId, (signals.get(memoryId) ?? 0) + sameDocWeight * density + proximityWeight * proximity);
    }
  }

  const maxSignal = Math.max(0, ...signals.values());
  if (maxSignal <= 0) {
    return signals;
  }

  for (const [key, value] of signals.entries()) {
    signals.set(key, value / maxSignal);
  }
  return signals;
}

export function rankVectorHits(
  hits: QdrantSearchHit[],
  graphSignals: Map<string, number> = new Map(),
  options: {
    vectorWeight?: number;
    graphWeight?: number;
  } = {},
): RAGSearchResult[] {
  const vectorWeight = options.vectorWeight ?? 0.7;
  const graphWeight = options.graphWeight ?? 0.3;
  return hits
    .map((hit) => {
      const memoryId = getMemoryId(hit);
      const vectorScore = Number(hit.score ?? 0);
      const graphScore = graphSignals.get(memoryId) ?? 0;
      return {
        memoryId,
        score: vectorWeight * vectorScore + graphWeight * graphScore,
        vectorScore,
        graphScore,
        content: readString(hit.metadata.content) ?? "",
        metadata: hit.metadata,
      };
    })
    .sort((left, right) => right.score - left.score);
}

export function compressRankedItems(
  items: RAGSearchResult[],
  options: {
    enableCompression?: boolean;
    maxPerDoc?: number;
    joinGap?: number;
  } = {},
): RAGSearchResult[] {
  if (options.enableCompression === false) {
    return items;
  }

  const maxPerDoc = options.maxPerDoc ?? 2;
  const joinGap = options.joinGap ?? 200;
  const perDocCount = new Map<string, number>();
  const lastByDoc = new Map<string, RAGSearchResult>();
  const compressed: RAGSearchResult[] = [];

  for (const item of items) {
    const docId = getDocId(item);
    const start = readNumber(item.metadata.start, 0);
    const end = readNumber(item.metadata.end, start + item.content.length);
    const last = lastByDoc.get(docId);

    if (!last) {
      compressed.push(item);
      lastByDoc.set(docId, item);
      perDocCount.set(docId, 1);
      continue;
    }

    const lastStart = readNumber(last.metadata.start, 0);
    const lastEnd = readNumber(last.metadata.end, lastStart + last.content.length);
    if (start >= lastStart && start - lastEnd <= joinGap) {
      const mergedContent = [last.content.trim(), item.content.trim()].filter(Boolean).join("\n\n");
      last.content = mergedContent;
      last.score = Math.max(last.score, item.score);
      last.vectorScore = Math.max(last.vectorScore, item.vectorScore);
      last.graphScore = Math.max(last.graphScore, item.graphScore);
      last.metadata = {
        ...last.metadata,
        end: Math.max(lastEnd, end),
      };
      lastByDoc.set(docId, last);
      continue;
    }

    const count = perDocCount.get(docId) ?? 0;
    if (count >= maxPerDoc) {
      continue;
    }
    compressed.push(item);
    lastByDoc.set(docId, item);
    perDocCount.set(docId, count + 1);
  }

  return compressed;
}

export function mergeSnippetsGrouped(
  items: RAGSearchResult[],
  options: {
    maxChars?: number;
    includeCitations?: boolean;
  } = {},
): string {
  const maxChars = options.maxChars ?? 1200;
  const includeCitations = options.includeCitations ?? true;
  const byDoc = new Map<string, RAGSearchResult[]>();
  const docScore = new Map<string, number>();

  for (const item of items) {
    const docId = getDocId(item);
    const current = byDoc.get(docId) ?? [];
    current.push(item);
    byDoc.set(docId, current);
    docScore.set(docId, (docScore.get(docId) ?? 0) + item.score);
  }

  const orderedDocs = [...byDoc.keys()].sort((left, right) => (docScore.get(right) ?? 0) - (docScore.get(left) ?? 0));
  const snippets: string[] = [];
  const citations: Array<{ index: number; metadata: Record<string, unknown> }> = [];
  let usedChars = 0;
  let citationIndex = 1;

  for (const docId of orderedDocs) {
    const docItems = byDoc.get(docId) ?? [];
    docItems.sort((left, right) => readNumber(left.metadata.start, 0) - readNumber(right.metadata.start, 0));

    for (const item of docItems) {
      const suffix = includeCitations ? ` [${citationIndex}]` : "";
      const text = item.content.trim();
      if (!text) {
        continue;
      }

      const available = maxChars - usedChars - suffix.length;
      if (available <= 0) {
        break;
      }

      const clipped = text.length > available ? text.slice(0, Math.max(0, available - 3)) + "..." : text;
      snippets.push(clipped + suffix);
      usedChars += clipped.length + suffix.length;

      if (includeCitations) {
        citations.push({ index: citationIndex, metadata: item.metadata });
        citationIndex += 1;
      }

      if (usedChars >= maxChars) {
        break;
      }
    }
  }

  if (!includeCitations || citations.length === 0) {
    return snippets.join("\n\n");
  }

  const citationLines = citations.map(({ index, metadata }) => {
    const source = readString(metadata.source_path) ?? readString(metadata.doc_id) ?? "source";
    const start = metadata.start === undefined ? "" : ` (${String(metadata.start)}-${String(metadata.end ?? "")})`;
    const heading = readString(metadata.heading_path);
    return heading ? `[${index}] ${source}${start} - ${heading}` : `[${index}] ${source}${start}`;
  });
  return [...snippets, "", "References:", ...citationLines].join("\n");
}

function getMemoryId(hit: QdrantSearchHit): string {
  return readString(hit.metadata.memory_id) ?? String(hit.id);
}

function getDocId(item: RAGSearchResult): string {
  return readString(item.metadata.doc_id) ?? readString(item.metadata.source_path) ?? item.memoryId;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : fallback;
}
