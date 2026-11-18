import { describe, expect, it } from 'vitest';
import { StreamRestorer } from '../../src/contexts/privacy/domain/stream-restorer';
import { InMemoryVault } from '../../src/contexts/privacy/domain/vault';

function vault(): InMemoryVault {
  const v = new InMemoryVault();
  v.tokenFor('CPF', '529.982.247-25'); // [CPF_1]
  v.tokenFor('NOME', 'João da Silva'); // [NOME_1]
  v.tokenFor('EMAIL', 'joao@exemplo.com.br'); // [EMAIL_1]
  return v;
}

const run = (v: InMemoryVault, chunks: string[]): string => {
  const r = new StreamRestorer(v);
  return chunks.map((c) => r.push(c)).join('') + r.flush();
};

describe('StreamRestorer', () => {
  const SAMPLE =
    'Olá [NOME_1], seu CPF é [CPF_1] e o e-mail [EMAIL_1]. Veja [CPF_9] e [1, 2] [link](x).';
  const EXPECTED =
    'Olá João da Silva, seu CPF é 529.982.247-25 e o e-mail joao@exemplo.com.br. Veja [CPF_9] e [1, 2] [link](x).';

  it('restores in a single chunk', () => {
    expect(run(vault(), [SAMPLE])).toBe(EXPECTED);
  });

  it('restores when split at every possible boundary', () => {
    for (let i = 0; i <= SAMPLE.length; i++) {
      expect(run(vault(), [SAMPLE.slice(0, i), SAMPLE.slice(i)])).toBe(EXPECTED);
    }
  });

  it('restores when split at every pair of boundaries and char by char', () => {
    for (let i = 0; i <= SAMPLE.length; i += 2) {
      for (let j = i; j <= SAMPLE.length; j += 3) {
        expect(run(vault(), [SAMPLE.slice(0, i), SAMPLE.slice(i, j), SAMPLE.slice(j)])).toBe(
          EXPECTED,
        );
      }
    }
    expect(run(vault(), [...SAMPLE])).toBe(EXPECTED);
  });

  it('holds back only a possible token prefix', () => {
    const r = new StreamRestorer(vault());
    expect(r.push('texto [CP')).toBe('texto ');
    expect(r.push('F_1')).toBe('');
    expect(r.push('] fim')).toBe('529.982.247-25 fim');
    expect(r.push('lista [1, 2')).toBe('lista [1, 2');
    expect(r.push(' [x] [')).toBe(' [x] ');
    expect(r.flush()).toBe('[');
  });

  it('flush returns an unfinished token as plain text', () => {
    const r = new StreamRestorer(vault());
    expect(r.push('abc [CPF_')).toBe('abc ');
    expect(r.flush()).toBe('[CPF_');
    expect(r.flush()).toBe('');
  });

  it('gives up on a "[" that is not followed by a token within 24 chars', () => {
    const r = new StreamRestorer(vault());
    const long = '[CPF_123456789012345678901234567890';
    expect(r.push(long)).toBe(long);
  });

  it('applies the value mapper', () => {
    const v = vault();
    v.tokenFor('NOME', 'O "Zé"');
    const r = new StreamRestorer(v, (s) => JSON.stringify(s).slice(1, -1));
    expect(r.push('"[NOME_2]"')).toBe('"O \\"Zé\\""');
  });
});
