export interface Suggestion {
  name: string;
  /** 0..1, higher is more similar. */
  score: number;
}

/** A suggestion at or above this is "good enough": no need to consult the data dictionary. */
export const GOOD_SUGGESTION = 0.6;

/** Optimal string alignment distance (Levenshtein + adjacent transposition). */
export function editDistance(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i += 1) {
    const row: number[] = [i];
    for (let j = 1; j <= m; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, prev2[j - 2]! + 1);
      row.push(best);
    }
    prev2 = prev;
    prev = row;
  }
  return prev[m]!;
}

/** Legacy table prefix (`z01_` in `z01_nome`): every column of a table shares it. */
const TABLE_PREFIX = /^[a-z]+\d+_/;

/** Meaningful words of an identifier (prefix and short fragments dropped). */
const words = (id: string): string[] =>
  id
    .replace(TABLE_PREFIX, '')
    .split(/[_\W]+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w));

/**
 * How alike two identifiers are: normalized edit distance, lifted when one contains the other
 * (`arrecad` ⊂ `arrecadacao`), when they share words (`nome_contribuinte` ~ `contribuinte_nome`)
 * and slightly when they share the legacy table prefix (`z01_`).
 */
export function similarity(wanted: string, candidate: string): number {
  let a = wanted.toLowerCase();
  let b = candidate.toLowerCase();
  if (a === b) return 1;
  // columns of one legacy table all share `z01_`: compare what comes after it
  const prefix = TABLE_PREFIX.exec(a)?.[0];
  const samePrefix = !!prefix && b.startsWith(prefix);
  if (samePrefix) {
    a = a.slice(prefix.length);
    b = b.slice(prefix.length);
  }
  const longest = Math.max(a.length, b.length);
  let score = 1 - editDistance(a, b) / longest;

  const shortest = Math.min(a.length, b.length);
  if (shortest >= 4 && (a.includes(b) || b.includes(a)))
    score = Math.max(score, 0.6 + 0.4 * (shortest / longest));

  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (wa.size > 0 && wb.size > 0) {
    let common = 0;
    for (const w of wa) if (wb.has(w)) common += 1;
    if (common > 0) score = Math.max(score, 0.5 + 0.5 * (common / new Set([...wa, ...wb]).size));
  }

  if (samePrefix) score += 0.05;
  return Math.min(score, 0.99);
}

/** Up to `k` candidates most similar to `wanted` (best first), dropping those below `minScore`. */
export function suggest(
  wanted: string,
  candidates: Iterable<string>,
  k = 3,
  minScore = 0.45,
): Suggestion[] {
  const w = wanted.toLowerCase();
  const out: Suggestion[] = [];
  for (const name of candidates) {
    // cheap pre-filter: very different lengths cannot be close edits (containment aside)
    if (Math.abs(name.length - w.length) > Math.max(w.length, name.length) * 0.7) continue;
    const score = similarity(w, name);
    if (score >= minScore) out.push({ name, score });
  }
  return out
    .sort(
      (x, y) => y.score - x.score || x.name.length - y.name.length || x.name.localeCompare(y.name),
    )
    .slice(0, k);
}
