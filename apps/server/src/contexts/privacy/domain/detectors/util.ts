import type { PiiKind, Span } from '../pii';

/** Lowercase, accent-free copy (same length is NOT guaranteed: use only on small windows). */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export const onlyDigits = (s: string): string => s.replace(/\D/g, '');

export function allSame(s: string): boolean {
  return s.length > 0 && [...s].every((c) => c === s[0]);
}

/** Digit run not glued to other digits (nor to `digits + separator`, e.g. a longer formatted number). */
export const NO_DIGIT_BEFORE = '(?<!\\d|\\d[.\\-/])';
export const NO_DIGIT_AFTER = '(?!\\d|[.\\-/]\\d)';

/** Wraps a pattern so it cannot start or end glued to other digits. */
export function bounded(source: string): string {
  return `${NO_DIGIT_BEFORE}(?:${source})${NO_DIGIT_AFTER}`;
}

/**
 * True when one of the Portuguese context `words` (a regex source, accent-free, lowercase) ends
 * the ~40 chars before `start`, with at most ~25 non-digit chars between them and the value:
 * `"CPF do titular: 123..."`.
 */
export function hasContextBefore(text: string, start: number, words: string): boolean {
  const window = fold(text.slice(Math.max(0, start - 50), start));
  return new RegExp(`(?:^|[^a-z0-9])(?:${words})(?![a-z0-9])(?:[^0-9\\n]{0,25})$`).test(window);
}

export function span(
  start: number,
  end: number,
  kind: PiiKind,
  score: number,
  source: Span['source'] = 'native',
): Span {
  return { start, end, kind, score, source };
}

/** Runs `re` (made global) over `text` and calls `visit` for every match. */
export function eachMatch(
  re: RegExp,
  text: string,
  visit: (m: RegExpExecArray, start: number, end: number) => void,
): void {
  const g = re.global ? re : new RegExp(re.source, `${re.flags}g`);
  g.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    if (m[0].length === 0) {
      g.lastIndex++;
      continue;
    }
    visit(m, m.index, m.index + m[0].length);
  }
}

/** Weighted sum of the digits of `digits` (left to right) with the given weights. */
export function weightedSum(digits: string, weights: readonly number[]): number {
  let sum = 0;
  const n = Math.min(digits.length, weights.length);
  for (let i = 0; i < n; i++) sum += Number(digits[i]) * (weights[i] ?? 0);
  return sum;
}
