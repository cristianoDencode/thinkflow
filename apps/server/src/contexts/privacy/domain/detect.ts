import { NATIVE_DETECTORS } from './detectors';
import { nameDetector } from './names';
import { TOKEN_RE, type PiiKind, type Span } from './pii';

export interface DetectOptions {
  /** Spans below this score are dropped (default 0.5). */
  minScore?: number;
  /** Restrict to these kinds (default: all). */
  kinds?: readonly PiiKind[];
  /** Run the person-name heuristic (default true). */
  names?: boolean;
  /** Spans found elsewhere (Presidio, column rules) to merge with the native ones. */
  extra?: readonly Span[];
}

export const DEFAULT_MIN_SCORE = 0.5;

/** Ranges of the text that already are tokens (`[CPF_1]`): never re-detected. */
export function tokenRanges(text: string): [number, number][] {
  return [...text.matchAll(TOKEN_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

/**
 * Resolves overlaps keeping the best span (higher score, then longer, then earlier) and returns
 * the survivors sorted by position. Spans that touch a token range are dropped.
 */
export function resolveSpans(spans: readonly Span[], text: string, minScore = 0): Span[] {
  const tokens = tokenRanges(text);
  const candidates = spans
    .filter((s) => s.end > s.start && s.score >= minScore)
    .filter((s) => !tokens.some(([a, b]) => s.start < b && s.end > a))
    .sort((a, b) => b.score - a.score || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: Span[] = [];
  for (const s of candidates) {
    if (!taken.some((t) => s.start < t.end && s.end > t.start)) taken.push(s);
  }
  return taken.sort((a, b) => a.start - b.start);
}

/**
 * Finds every piece of personal data in `text` (native detectors + name heuristic + `extra`
 * spans), overlap-free and sorted by position.
 */
export function detectAll(text: string, opts: DetectOptions = {}): Span[] {
  if (text.length === 0) return [];
  const kinds = opts.kinds ? new Set(opts.kinds) : null;
  const found: Span[] = [...(opts.extra ?? [])];
  for (const d of NATIVE_DETECTORS) if (!kinds || kinds.has(d.kind)) found.push(...d.find(text));
  if (opts.names !== false && (!kinds || kinds.has('NOME'))) found.push(...nameDetector.find(text));
  const filtered = kinds ? found.filter((s) => kinds.has(s.kind)) : found;
  return resolveSpans(filtered, text, opts.minScore ?? DEFAULT_MIN_SCORE);
}
