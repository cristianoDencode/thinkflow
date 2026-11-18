/** Query building, hit selection and excerpting for the FTS5 (BM25) index. Pure functions only. */

export const PT_STOPWORDS: ReadonlySet<string> = new Set(
  `a o as os um uma uns umas de da do das dos em na no nas nos por para pra com sem sob sobre entre ate apos
  ante contra desde durante e ou mas nem que se como quando onde porque pois porem logo entao
  qual quais quem cujo cuja quanto quantos quanta quantas este esta estes estas esse essa esses essas
  isto isso aquilo aquele aquela aqueles aquelas meu minha meus minhas seu sua seus suas nosso nossa
  ele ela eles elas eu tu voce voces nos me te lhe lhes mim ti si
  ser sou eh era eram foi foram sera serao seja sejam sendo sido estar esta estao estou estava estavam
  estive esteve ter tem tinha tinham teve tenho temos haver ha havia houve ha fazer faz fez fazem
  ir vai vao foi pode podem poder deve devem dever
  muito muita muitos muitas pouco pouca mais menos tao tambem ainda ja so apenas todo toda todos todas
  algum alguma alguns algumas nenhum nenhuma outro outra outros outras mesmo mesma cada qualquer
  aqui ali la ca bem mal sim nao the and of to in is are was be for on with that this it an or at by
  from as what which how who`
    .split(/\s+/)
    .filter(Boolean),
);

const MAX_TERMS = 12;

/** Lowercases one UTF-16 unit and drops its diacritic (keeps string length stable). */
function foldChar(c: string): string {
  return c.toLowerCase().normalize('NFD')[0] ?? c;
}

/** Lowercase + accent-insensitive form with the same length as the input (for index math). */
export function foldText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += foldChar(text[i]!);
  return out;
}

export interface FtsQuery {
  /** MATCH expression: every term double-quoted (so user input can't inject FTS operators), OR-joined. */
  query: string;
  /** Folded term/prefix strings, used to highlight excerpts. */
  terms: string[];
}

export function buildFtsQuery(question: string): FtsQuery | null {
  const tokens = question
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !PT_STOPWORDS.has(t));
  const seen = new Set<string>();
  const parts: string[] = [];
  const terms: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    const stem = token.length >= 6 ? token.slice(0, Math.max(5, token.length - 3)) : null;
    parts.push(stem ? `"${stem}"*` : `"${token}"`);
    terms.push(stem ?? token);
    if (parts.length >= MAX_TERMS) break;
  }
  return parts.length ? { query: parts.join(' OR '), terms } : null;
}

/** A chunk returned by the index, `score` being bm25 (lower is better). */
export interface RawHit {
  chunkId: number;
  documentId: string;
  ordinal: number;
  text: string;
  heading: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  score: number;
}

export interface SelectedHit {
  documentId: string;
  ordinalFrom: number;
  ordinalTo: number;
  text: string;
  heading: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  score: number;
}

function minOf(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b);
}
function maxOf(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.max(a, b);
}

/** Joins two consecutive chunks, dropping the overlap the chunker repeated at the start of `b`. */
export function joinAdjacent(a: string, b: string): string {
  const limit = Math.min(a.length, b.length, 600);
  for (let len = limit; len >= 20; len--) {
    if (a.endsWith(b.slice(0, len))) return `${a}${b.slice(len)}`;
  }
  return `${a}\n\n${b}`;
}

/**
 * `raw` is ordered by bm25 ascending (best first). Caps hits per document, merges adjacent
 * chunks of the same document into one hit and keeps the best `k`.
 */
export function selectHits(
  raw: RawHit[],
  options: { k: number; perDocument?: number },
): SelectedHit[] {
  const perDocument = options.perDocument ?? 3;
  const counts = new Map<string, number>();
  const kept: RawHit[] = [];
  for (const hit of raw) {
    const n = counts.get(hit.documentId) ?? 0;
    if (n >= perDocument) continue;
    counts.set(hit.documentId, n + 1);
    kept.push(hit);
  }

  const byDoc = new Map<string, RawHit[]>();
  for (const hit of kept) byDoc.set(hit.documentId, [...(byDoc.get(hit.documentId) ?? []), hit]);

  const merged: SelectedHit[] = [];
  for (const [documentId, hits] of byDoc) {
    let current = null as SelectedHit | null;
    for (const hit of [...hits].sort((x, y) => x.ordinal - y.ordinal)) {
      if (current && hit.ordinal === current.ordinalTo + 1) {
        current = {
          ...current,
          ordinalTo: hit.ordinal,
          text: joinAdjacent(current.text, hit.text),
          pageFrom: minOf(current.pageFrom, hit.pageFrom),
          pageTo: maxOf(current.pageTo, hit.pageTo),
          score: Math.min(current.score, hit.score),
        };
        continue;
      }
      if (current) merged.push(current);
      current = {
        documentId,
        ordinalFrom: hit.ordinal,
        ordinalTo: hit.ordinal,
        text: hit.text,
        heading: hit.heading,
        pageFrom: hit.pageFrom,
        pageTo: hit.pageTo,
        score: hit.score,
      };
    }
    if (current) merged.push(current);
  }
  return merged.sort((x, y) => x.score - y.score).slice(0, options.k);
}

/** Largest window of `maxChars` (starting at a sentence or a term occurrence) with the most terms. */
export function makeExcerpt(text: string, terms: string[], maxChars = 1_400): string {
  if (text.length <= maxChars) return text;
  const inner = Math.max(maxChars - 2, 1); // room for the ellipsis marks
  const folded = foldText(text);

  const occurrences: number[] = [];
  for (const term of new Set(terms)) {
    if (!term) continue;
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length))
      occurrences.push(at);
  }

  const starts = new Set<number>([0]);
  for (const m of text.matchAll(/(?<=[.!?…\n])\s+/g)) starts.add(m.index + m[0].length);
  for (const at of occurrences) {
    const back = text.lastIndexOf(' ', Math.max(at - 80, 0));
    starts.add(back < 0 ? 0 : back + 1);
  }

  let bestStart = 0;
  let bestCount = -1;
  for (const start of [...starts].sort((a, b) => a - b)) {
    if (start >= text.length) continue;
    const end = start + inner;
    const count = occurrences.filter((o) => o >= start && o < end).length;
    if (count > bestCount) {
      bestCount = count;
      bestStart = start;
    }
  }

  let end = bestStart + inner;
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > bestStart + inner / 2) end = space;
  } else {
    end = text.length;
  }
  const body = text.slice(bestStart, end).trim();
  return `${bestStart > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}
