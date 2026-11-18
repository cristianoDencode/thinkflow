import { describe, expect, it } from 'vitest';
import { chunkSections, normalizeText } from '../../src/contexts/library/domain/chunker';

const words = (n: number, w = 'palavra'): string => Array.from({ length: n }, () => w).join(' ');
const sentence = (i: number): string => `Esta é a frase número ${i} do documento de teste.`;
const para = (n: number, from = 0): string =>
  Array.from({ length: n }, (_, i) => sentence(from + i)).join(' ');

describe('chunkSections', () => {
  it('keeps a small document in a single chunk', () => {
    const chunks = chunkSections([{ text: 'Um texto curto.' }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ ordinal: 0, text: 'Um texto curto.', pageFrom: null });
  });

  it('returns nothing for empty input', () => {
    expect(chunkSections([])).toEqual([]);
    expect(chunkSections([{ text: ' \n\n ' }])).toEqual([]);
  });

  it('splits long text within maxTokens, numbers ordinals and never emits empty chunks', () => {
    const text = Array.from({ length: 40 }, (_, i) => para(8, i * 8)).join('\n\n');
    const chunks = chunkSections([{ text }]);
    expect(chunks.length).toBeGreaterThan(2);
    chunks.forEach((c, i) => {
      expect(c.ordinal).toBe(i);
      expect(c.text.trim().length).toBeGreaterThan(0);
      expect(c.tokenEstimate).toBeLessThanOrEqual(700);
    });
  });

  it('repeats the tail of a chunk at the start of the next one (overlap)', () => {
    const text = Array.from({ length: 90 }, (_, i) => sentence(i)).join(' ');
    const paragraphs = text.match(/.{1,400}(\s|$)/g)!.join('\n\n');
    const chunks = chunkSections([{ text: paragraphs }]);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const lastSentence = chunks[i - 1]!.text.trim()
        .split(/(?<=\.)\s+/)
        .at(-1)!;
      expect(chunks[i]!.text.includes(lastSentence.slice(-30))).toBe(true);
    }
  });

  it('tracks a heading path and attaches it to the chunks below', () => {
    const md = [
      '# 3. Regras',
      'Texto geral das regras.',
      '## 3.2 Aprovação',
      'O prazo de aprovação é de 5 dias.',
    ].join('\n\n');
    const [chunk] = chunkSections([{ text: md }]);
    expect(chunk!.heading).toBe('3. Regras');
    const small = chunkSections([{ text: md }], { targetTokens: 12, overlapTokens: 0 });
    const last = small.at(-1)!;
    expect(last.heading).toBe('3. Regras > 3.2 Aprovação');
    expect(last.text).toContain('5 dias');
  });

  it('does not end a chunk with a lone heading', () => {
    const md = `${para(30)}\n\n## Título novo\n\n${para(3)}`;
    const chunks = chunkSections([{ text: md }], { targetTokens: 120, overlapTokens: 0 });
    for (const c of chunks.slice(0, -1))
      expect(c.text.trimEnd().split('\n').at(-1)).not.toMatch(/^#/);
    expect(chunks.some((c) => c.text.startsWith('## Título novo'))).toBe(true);
  });

  it('records the page range of each chunk', () => {
    const chunks = chunkSections(
      [
        { text: 'Página um.', page: 1 },
        { text: 'Página dois.', page: 2 },
        { text: para(60), page: 3 },
      ],
      { targetTokens: 100, overlapTokens: 0 },
    );
    expect(chunks[0]).toMatchObject({ pageFrom: 1, pageTo: 2 });
    expect(chunks.at(-1)!.pageTo).toBe(3);
    expect(chunks.every((c) => c.pageFrom !== null)).toBe(true);
  });

  it('uses the section heading as base context', () => {
    const [c] = chunkSections([{ text: 'Conteúdo.', heading: 'Capítulo 1' }]);
    expect(c!.heading).toBe('Capítulo 1');
  });

  it('splits a giant paragraph on sentences', () => {
    const chunks = chunkSections([{ text: para(300) }]);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeLessThanOrEqual(700);
      expect(c.text.endsWith('.')).toBe(true);
    }
  });

  it('hard-splits a blob without punctuation', () => {
    const chunks = chunkSections([{ text: words(2_000) }]);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.tokenEstimate).toBeLessThanOrEqual(700);
    expect(chunks.every((c) => !c.text.startsWith('palavrapalavra'))).toBe(true);
    const unbroken = chunkSections([{ text: 'x'.repeat(10_000) }]);
    expect(unbroken.length).toBeGreaterThan(2);
    for (const c of unbroken) expect(c.tokenEstimate).toBeLessThanOrEqual(700);
  });

  it('normalizes CRLF, control characters and blank runs', () => {
    const [c] = chunkSections([{ text: 'linha 1\r\nlinha 2\u0000   \r\n\r\n\r\n\r\nlinha 3\f' }]);
    expect(c!.text).toBe('linha 1\nlinha 2\n\nlinha 3');
    expect(normalizeText('a\u0007b\r\nc')).toBe('ab\nc');
  });
});
