import { PII_KINDS, type PiiKind } from '@thinkflow/shared';

export { PII_KINDS, type PiiKind };

/** Where a span came from: native regex/validator, the Presidio sidecar or a column rule. */
export type SpanSource = 'native' | 'presidio' | 'column';

/** A detected piece of personal data inside a text: `text.slice(start, end)`. */
export interface Span {
  start: number;
  end: number;
  kind: PiiKind;
  /** 0..1 confidence; used to resolve overlaps and to drop weak guesses. */
  score: number;
  source: SpanSource;
}

/** One detector per entity. `find` never throws and returns spans in no particular order. */
export interface Detector {
  kind: PiiKind;
  find(text: string): Span[];
}

/** Matches a token written by the tokenizer: `[CPF_1]`, `[NOME_12]`. Global: reset `lastIndex` or use matchAll. */
export const TOKEN_RE = new RegExp(`\\[(?:${PII_KINDS.join('|')})_\\d+\\]`, 'g');

/** True when `value` is exactly one token. */
export function isToken(value: string): boolean {
  return new RegExp(`^${TOKEN_RE.source}$`).test(value);
}

/** Longest possible token (`[SEGREDO_` + up to 8 digits + `]`), used by the stream restorer. */
export const MAX_TOKEN_LENGTH = 24;
