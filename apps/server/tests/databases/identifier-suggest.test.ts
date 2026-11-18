import { describe, expect, it } from 'vitest';
import {
  editDistance,
  GOOD_SUGGESTION,
  similarity,
  suggest,
} from '../../src/contexts/databases/domain/identifier-suggest';

const cgmColumns = [
  'z01_numcgm',
  'z01_nome',
  'z01_nomecomple',
  'z01_ender',
  'z01_cgccpf',
  'z01_munic',
  'z01_email',
];

describe('editDistance', () => {
  it('counts insertions, substitutions and adjacent transpositions as one edit', () => {
    expect(editDistance('nome', 'nomee')).toBe(1);
    expect(editDistance('nome', 'nmoe')).toBe(1);
    expect(editDistance('abc', 'xyz')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
  });
});

describe('suggest', () => {
  it('puts the near miss first: z01_nomee → z01_nome', () => {
    const [first] = suggest('z01_nomee', cgmColumns);
    expect(first?.name).toBe('z01_nome');
    expect(first!.score).toBeGreaterThan(GOOD_SUGGESTION);
  });

  it('does not rank unrelated columns of the same legacy prefix as good matches', () => {
    expect(similarity('z01_nomee', 'z01_numcgm')).toBeLessThan(GOOD_SUGGESTION);
  });

  it('finds names that contain or are contained in the wanted one', () => {
    const [first] = suggest('arrecadacao', ['arrecad', 'arrecant', 'cgm', 'iptubase']);
    expect(first?.name).toBe('arrecad');
  });

  it('matches reordered words', () => {
    const [first] = suggest('contribuinte_nome', ['nome_contribuinte', 'cgm']);
    expect(first?.name).toBe('nome_contribuinte');
  });

  it('returns nothing for invented names with no resemblance (the dictionary takes over)', () => {
    const best = suggest('valor_terreno', ['cgm', 'iptubase', 'arrecad'])[0];
    expect(best?.score ?? 0).toBeLessThan(GOOD_SUGGESTION);
  });

  it('limits to k results and ignores case', () => {
    expect(suggest('Z01_NOME', cgmColumns, 2)).toHaveLength(2);
    expect(suggest('z01_nome', cgmColumns)[0]).toMatchObject({ name: 'z01_nome', score: 1 });
  });
});
