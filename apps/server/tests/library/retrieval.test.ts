import { describe, expect, it } from 'vitest';
import {
  buildFtsQuery,
  foldText,
  makeExcerpt,
  selectHits,
  type RawHit,
} from '../../src/contexts/library/domain/retrieval';

const hit = (documentId: string, ordinal: number, score: number, text = `t${ordinal}`): RawHit => ({
  chunkId: ordinal,
  documentId,
  ordinal,
  text,
  heading: null,
  pageFrom: ordinal + 1,
  pageTo: ordinal + 1,
  score,
});

describe('buildFtsQuery', () => {
  it('drops stopwords and short tokens, strips accents and quotes every term', () => {
    const q = buildFtsQuery('Qual é o prazo da aprovação de pagamentos?')!;
    expect(q.query).toBe('"prazo" OR "aprova"* OR "pagamen"*');
    expect(q.terms).toEqual(['prazo', 'aprova', 'pagamen']);
  });

  it('prefixes tokens of 6+ chars (len-3, at least 5)', () => {
    expect(buildFtsQuery('aprovacoes')!.query).toBe('"aprovac"*');
    expect(buildFtsQuery('regras')!.query).toBe('"regra"*');
    expect(buildFtsQuery('prazos')!.query).toBe('"praz"*'.replace('praz', 'prazo'));
    expect(buildFtsQuery('prazo')!.query).toBe('"prazo"');
  });

  it('neutralizes FTS operators and quotes in user input', () => {
    const q = buildFtsQuery('"a" OR b) NEAR -x:* foo*')!;
    expect(q.query).toMatch(/^("[a-z0-9]+"\*?)( OR "[a-z0-9]+"\*?)*$/);
    expect(q.query).not.toMatch(/[()\-:^]/);
    expect(q.terms).toContain('near');
  });

  it('dedupes terms and keeps at most 12', () => {
    expect(buildFtsQuery('prazo prazo PRAZO')!.terms).toEqual(['prazo']);
    const many = Array.from({ length: 30 }, (_, i) => `termo${i}x`).join(' ');
    expect(buildFtsQuery(many)!.terms).toHaveLength(12);
  });

  it('returns null when only stopwords remain', () => {
    expect(buildFtsQuery('o que é isso de a?')).toBeNull();
    expect(buildFtsQuery('???')).toBeNull();
  });
});

describe('selectHits', () => {
  it('caps hits per document, keeping the best ones', () => {
    const raw = [
      hit('a', 0, -9),
      hit('a', 5, -8),
      hit('a', 9, -7),
      hit('a', 20, -6),
      hit('b', 1, -1),
    ];
    const out = selectHits(raw, { k: 10 });
    expect(out.filter((h) => h.documentId === 'a')).toHaveLength(3);
    expect(out.map((h) => h.documentId)).toContain('b');
  });

  it('merges adjacent chunks of one document into a single hit', () => {
    const out = selectHits([hit('a', 3, -5, 'um'), hit('a', 4, -9, 'dois'), hit('a', 8, -2, 'x')], {
      k: 5,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      ordinalFrom: 3,
      ordinalTo: 4,
      score: -9,
      pageFrom: 4,
      pageTo: 5,
    });
    expect(out[0]!.text).toBe('um\n\ndois');
  });

  it('drops the overlap repeated between adjacent chunks', () => {
    const tail = 'a cauda repetida pelo chunker entre dois trechos vizinhos.';
    const out = selectHits(
      [hit('a', 0, -3, `inicio do primeiro. ${tail}`), hit('a', 1, -4, `${tail} fim do segundo.`)],
      { k: 5 },
    );
    expect(out[0]!.text).toBe(`inicio do primeiro. ${tail} fim do segundo.`);
  });

  it('keeps only the top k ordered by score', () => {
    const raw = ['a', 'b', 'c', 'd'].map((d, i) => hit(d, 0, -10 + i));
    expect(selectHits(raw, { k: 2 }).map((h) => h.documentId)).toEqual(['a', 'b']);
  });
});

describe('makeExcerpt', () => {
  const filler = (n: number): string =>
    Array.from({ length: n }, (_, i) => `Frase de enchimento número ${i} sem relação.`).join(' ');

  it('returns short text untouched', () => {
    expect(makeExcerpt('curto', ['x'])).toBe('curto');
  });

  it('picks the window holding the terms, with ellipsis on cut sides, within the limit', () => {
    const text = `${filler(80)} O prazo de APROVAÇÃO é de cinco dias úteis. ${filler(80)}`;
    const out = makeExcerpt(text, ['prazo', 'aprova'], 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(foldText(out)).toContain('prazo de aprova');
  });

  it('falls back to the start when no term occurs', () => {
    const out = makeExcerpt(filler(100), ['inexistente'], 200);
    expect(out.startsWith('Frase')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('finds terms inside a single very long sentence', () => {
    const text = `${'palavra '.repeat(600)}prazo ${'palavra '.repeat(600)}`;
    expect(makeExcerpt(text, ['prazo'], 200)).toContain('prazo');
  });
});
