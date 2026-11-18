import { describe, expect, it } from 'vitest';
import { detectAll } from '../../src/contexts/privacy/domain/detect';
import { TOKEN_RE } from '../../src/contexts/privacy/domain/pii';
import { restore, tokenize, tokenizeValue } from '../../src/contexts/privacy/domain/tokenizer';
import {
  InMemoryVault,
  formatToken,
  normalizeForVault,
  parseToken,
} from '../../src/contexts/privacy/domain/vault';

const SAMPLE =
  'Contribuinte JOAO DA SILVA (CPF 529.982.247-25, e-mail joao@exemplo.com.br) ligou do (11) 99999-8888.';

describe('detectAll', () => {
  it('finds name, cpf, email and phone without overlaps', () => {
    const kinds = detectAll(SAMPLE).map((s) => s.kind);
    expect(kinds).toEqual(['NOME', 'CPF', 'EMAIL', 'TELEFONE']);
  });
  it('resolves overlaps preferring the higher score', () => {
    // valid CNPJ that is also Luhn-valid: the CNPJ (0.85) wins over the bare card (0.6)
    const text = '11222333000181';
    const spans = detectAll(text);
    expect(spans.map((s) => s.kind)).toEqual(['CNPJ']);
  });
  it('skips ranges that already are tokens and respects kinds/minScore/names', () => {
    expect(detectAll('[CPF_1] e [NOME_2]')).toEqual([]);
    expect(detectAll(SAMPLE, { kinds: ['CPF'] }).map((s) => s.kind)).toEqual(['CPF']);
    expect(detectAll('JOAO DA SILVA', { names: false })).toEqual([]);
    expect(detectAll('52998224725', { minScore: 0.9 })).toEqual([]);
  });
  it('merges extra spans (e.g. Presidio) with the native ones', () => {
    const text = 'Mora em Santa Rita, CPF 529.982.247-25';
    const extra = [
      { start: 8, end: 18, kind: 'ENDERECO' as const, score: 0.8, source: 'presidio' as const },
    ];
    expect(detectAll(text, { extra }).map((s) => [s.kind, s.source])).toEqual([
      ['ENDERECO', 'presidio'],
      ['CPF', 'native'],
    ]);
  });
});

describe('vault', () => {
  it('gives the same token to the same normalized value', () => {
    const v = new InMemoryVault();
    expect(v.tokenFor('CPF', '529.982.247-25')).toBe('[CPF_1]');
    expect(v.tokenFor('CPF', '52998224725')).toBe('[CPF_1]');
    expect(v.tokenFor('CPF', '111.444.777-35')).toBe('[CPF_2]');
    expect(v.tokenFor('NOME', 'JOAO DA SILVA')).toBe('[NOME_1]');
    expect(v.tokenFor('NOME', 'João da Silva')).toBe('[NOME_1]');
    expect(v.tokenFor('EMAIL', 'A@B.com')).toBe('[EMAIL_1]');
    expect(v.tokenFor('EMAIL', 'a@b.com')).toBe('[EMAIL_1]');
  });
  it('keeps the first form seen as the restored value', () => {
    const v = new InMemoryVault();
    v.tokenFor('NOME', 'JOAO DA SILVA');
    v.tokenFor('NOME', 'João da Silva');
    expect(v.valueOf('[NOME_1]')).toBe('JOAO DA SILVA');
    expect(v.valueOf('[NOME_9]')).toBeUndefined();
  });
  it('counts per kind and treats kinds separately', () => {
    const v = new InMemoryVault();
    expect(v.tokenFor('CPF', '1')).toBe('[CPF_1]');
    expect(v.tokenFor('RG', '1')).toBe('[RG_1]');
    expect(v.tokenFor('CPF', '2')).toBe('[CPF_2]');
  });
  it('normalizes phones with and without +55 and plates', () => {
    expect(normalizeForVault('TELEFONE', '+55 (11) 99999-8888')).toBe('11999998888');
    expect(normalizeForVault('TELEFONE', '(11) 99999-8888')).toBe('11999998888');
    expect(normalizeForVault('PLACA', 'abc-1234')).toBe('ABC1234');
    expect(normalizeForVault('RENAVAM', '639884962')).toBe('00639884962');
  });
  it('formats and parses tokens', () => {
    expect(formatToken('CNPJ', 3)).toBe('[CNPJ_3]');
    expect(parseToken('[CNPJ_3]')).toEqual({ kind: 'CNPJ', n: 3 });
    expect(parseToken('[FOO_3]')).toBeNull();
    expect(parseToken('CPF_1')).toBeNull();
  });
});

describe('tokenize / restore', () => {
  it('replaces personal data by tokens and restores the original', () => {
    const v = new InMemoryVault();
    const out = tokenize(SAMPLE, v);
    expect(out).toBe(
      'Contribuinte [NOME_1] (CPF [CPF_1], e-mail [EMAIL_1]) ligou do [TELEFONE_1].',
    );
    expect(out).not.toMatch(/529|joao@|99999/);
    expect(restore(out, v)).toBe(SAMPLE);
  });
  it('reuses tokens for repeated values across texts', () => {
    const v = new InMemoryVault();
    expect(tokenize('CPF 529.982.247-25', v)).toBe('CPF [CPF_1]');
    expect(tokenize('de novo 52998224725', v)).toBe('de novo [CPF_1]');
  });
  it('never tokenizes twice', () => {
    const v = new InMemoryVault();
    const once = tokenize(SAMPLE, v);
    expect(tokenize(once, v)).toBe(once);
    // spans pointing inside an existing token are ignored
    const text = 'x [CPF_1] y';
    expect(
      tokenize(text, v, [{ start: 3, end: 8, kind: 'NOME', score: 1, source: 'native' }]),
    ).toBe(text);
  });
  it('applies given spans (column rules) instead of detecting', () => {
    const v = new InMemoryVault();
    const out = tokenize('Maria Souza mora ali', v, [
      { start: 0, end: 11, kind: 'NOME', score: 1, source: 'column' },
    ]);
    expect(out).toBe('[NOME_1] mora ali');
  });
  it('leaves unknown tokens and ordinary brackets alone on restore', () => {
    const v = new InMemoryVault();
    v.tokenFor('CPF', '529.982.247-25');
    expect(restore('[CPF_1] [CPF_7] [x] [1, 2]', v)).toBe('529.982.247-25 [CPF_7] [x] [1, 2]');
  });
  it('supports a value mapper (JSON escaping)', () => {
    const v = new InMemoryVault();
    v.tokenFor('NOME', 'O "Zé"');
    expect(restore('{"a":"[NOME_1]"}', v, (s) => JSON.stringify(s).slice(1, -1))).toBe(
      '{"a":"O \\"Zé\\""}',
    );
  });
  it('tokenizeValue tokenizes a whole cell once', () => {
    const v = new InMemoryVault();
    expect(tokenizeValue('Rua das Flores, 10', 'ENDERECO', v)).toBe('[ENDERECO_1]');
    expect(tokenizeValue('[ENDERECO_1]', 'ENDERECO', v)).toBe('[ENDERECO_1]');
    expect(tokenizeValue('', 'ENDERECO', v)).toBe('');
    expect(tokenizeValue('  Rua das Flores, 10 ', 'ENDERECO', v)).toBe('[ENDERECO_1]');
  });
  it('TOKEN_RE matches every kind', () => {
    const all =
      'CPF CNPJ CNS PIS TITULO CNH RENAVAM CARTAO EMAIL TELEFONE CEP RG PLACA NOME ENDERECO VALOR SEGREDO'
        .split(' ')
        .map((k) => `[${k}_1]`);
    expect(all.join(' ').match(TOKEN_RE)).toEqual(all);
  });
});
