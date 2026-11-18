/**
 * Splits extracted text into ~500-token chunks with overlap, keeping Markdown heading paths and
 * page ranges. Pure functions only.
 */
import { estimateTextTokens, type ChunkDraft, type ExtractedSection } from './library';

export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
  maxTokens?: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const SENTENCE_SPLIT = /(?<=[.!?…])\s+/;
const MAX_HEADING_CHARS = 200;

/** CRLF -> LF, drops NUL/control characters and form feeds, trims line ends, collapses blank runs. */
export function normalizeText(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, '\n')
      .replace(/\f/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

interface Unit {
  text: string;
  tokens: number;
  page: number | null;
  heading: string | null;
  isHeading: boolean;
  overlap: boolean;
}

function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars / 2) cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars / 2) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Splits an oversized paragraph on sentences; oversized sentences are hard-split. */
function splitOversized(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4;
  const pieces: string[] = [];
  let current = '';
  for (const sentence of text.split(SENTENCE_SPLIT).filter(Boolean)) {
    if (sentence.length > maxChars) {
      if (current) pieces.push(current);
      current = '';
      pieces.push(...hardSplit(sentence, maxChars));
      continue;
    }
    if (current && current.length + 1 + sentence.length > maxChars) {
      pieces.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function toUnits(sections: ExtractedSection[], maxTokens: number): Unit[] {
  const units: Unit[] = [];
  for (const section of sections) {
    const page = section.page ?? null;
    // heading stack by level; a section-provided heading is the base context
    const stack: { level: number; title: string }[] = [];
    const base = section.heading?.trim() || null;
    const path = (): string | null => {
      const parts = [...(base ? [base] : []), ...stack.map((h) => h.title)];
      if (parts.length === 0) return null;
      const joined = parts.join(' > ');
      return joined.length > MAX_HEADING_CHARS
        ? `${joined.slice(0, MAX_HEADING_CHARS - 1)}…`
        : joined;
    };
    const pushText = (text: string): void => {
      const t = text.trim();
      if (!t) return;
      const heading = path();
      const pieces = estimateTextTokens(t) > maxTokens ? splitOversized(t, maxTokens) : [t];
      for (const piece of pieces)
        units.push({
          text: piece,
          tokens: estimateTextTokens(piece),
          page,
          heading,
          isHeading: false,
          overlap: false,
        });
    };

    for (const paragraph of normalizeText(section.text).split(/\n{2,}/)) {
      let buffer: string[] = [];
      for (const line of paragraph.split('\n')) {
        const m = HEADING_RE.exec(line);
        if (!m) {
          buffer.push(line);
          continue;
        }
        pushText(buffer.join('\n'));
        buffer = [];
        const level = m[1]!.length;
        while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
        stack.push({ level, title: m[2]! });
        const text = line.trim();
        units.push({
          text,
          tokens: estimateTextTokens(text),
          page,
          heading: path(),
          isHeading: true,
          overlap: false,
        });
      }
      pushText(buffer.join('\n'));
    }
  }
  return units;
}

/** Trailing text worth about `overlapTokens`, as units flagged `overlap`. */
function overlapUnits(units: Unit[], overlapTokens: number): Unit[] {
  const out: Unit[] = [];
  let used = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]!;
    if (u.isHeading) continue;
    if (used + u.tokens <= overlapTokens) {
      out.unshift({ ...u, overlap: true });
      used += u.tokens;
      continue;
    }
    // partial unit: keep its trailing sentences that still fit
    const sentences = u.text.split(SENTENCE_SPLIT).filter(Boolean);
    const kept: string[] = [];
    for (let j = sentences.length - 1; j >= 0; j--) {
      const t = estimateTextTokens(sentences[j]!);
      if (used + t > overlapTokens) break;
      kept.unshift(sentences[j]!);
      used += t;
    }
    if (kept.length && kept.length < sentences.length) {
      const text = kept.join(' ');
      out.unshift({ ...u, text, tokens: estimateTextTokens(text), overlap: true });
    }
    break;
  }
  return out;
}

export function chunkSections(
  sections: ExtractedSection[],
  options: ChunkOptions = {},
): ChunkDraft[] {
  const targetTokens = options.targetTokens ?? 500;
  const overlapTokens = options.overlapTokens ?? 60;
  const maxTokens = options.maxTokens ?? 700;
  const units = toUnits(sections, maxTokens);

  const chunks: ChunkDraft[] = [];
  let cur: Unit[] = [];
  const tokensOf = (list: Unit[]): number => list.reduce((n, u) => n + u.tokens, 0);
  const hasBody = (list: Unit[]): boolean => list.some((u) => !u.overlap && !u.isHeading);

  const emit = (list: Unit[]): void => {
    const text = list
      .map((u) => u.text)
      .join('\n\n')
      .trim();
    if (!text) return;
    const pages = list.map((u) => u.page).filter((p): p is number => p !== null);
    const firstNew = list.find((u) => !u.overlap) ?? list[0]!;
    chunks.push({
      ordinal: chunks.length,
      text,
      tokenEstimate: estimateTextTokens(text),
      pageFrom: pages.length ? Math.min(...pages) : null,
      pageTo: pages.length ? Math.max(...pages) : null,
      heading: firstNew.heading,
    });
  };

  const flush = (): void => {
    // a heading never ends a chunk: it moves to the start of the next one
    const trailing: Unit[] = [];
    while (cur.length > 1 && cur[cur.length - 1]!.isHeading) trailing.unshift(cur.pop()!);
    emit(cur);
    cur = [...overlapUnits(cur, overlapTokens), ...trailing];
  };

  for (const unit of units) {
    if (hasBody(cur) && tokensOf(cur) + unit.tokens > targetTokens) flush();
    if (!hasBody(cur) && tokensOf(cur) + unit.tokens > maxTokens)
      cur = cur.filter((u) => !u.overlap);
    cur.push(unit);
  }
  if (cur.some((u) => !u.overlap)) emit(cur);
  return chunks;
}
