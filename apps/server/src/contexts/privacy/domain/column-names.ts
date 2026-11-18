import type { PiiKind } from './pii';

/**
 * Sensitivity of a column judged by its NAME only (e-Cidade style names such as `z01_cgccpf` included).
 * Used with the real source column of a query result, never with an alias.
 */
export type MaskKind = 'digits' | 'email' | 'name' | 'secret' | 'generic';

/** Lowercase + no accents. */
export function normalizeName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

const DIGIT_TOKENS = new Set([
  'cpf',
  'cnpj',
  'cgc',
  'cgccpf',
  'cpfcnpj',
  'cnpjcpf',
  'rg',
  'pis',
  'pasep',
  'nis',
  'nit',
  'fone',
  'telefone',
  'telef',
  'tel',
  'celular',
  'cel',
  'whatsapp',
  'cep',
  'cartao',
  'card',
  'agencia',
  'iban',
  'inscricao',
  'cnh',
]);
const EMAIL_TOKENS = new Set(['email', 'mail']);
const NAME_TOKENS = new Set([
  'nome',
  'razao',
  'fantasia',
  'mae',
  'pai',
  'conjuge',
  'responsavel',
  'sobrenome',
]);
const SECRET_TOKENS = new Set(['senha', 'password', 'passwd', 'pwd', 'hash', 'token', 'secret']);
const GENERIC_TOKENS = new Set([
  'endereco',
  'ender',
  'logradouro',
  'rua',
  'complemento',
  'bairro',
  'nasc',
  'nascimento',
  'conta',
  'tituloeleitor',
]);

/** Substrings of the compact name (no separators) that give it away. */
const DIGIT_PARTS = ['cpf', 'cnpj', 'cgc', 'telefone', 'celular', 'whatsapp', 'pasep'];
const EMAIL_PARTS = ['email'];
const SECRET_PARTS = ['senha', 'password', 'passwd'];
const NAME_PARTS = ['razaosocial', 'nomefantasia', 'nomemae', 'nomepai'];
const GENERIC_PARTS = [
  'endereco',
  'logradouro',
  'nascimento',
  'datanasc',
  'tituloeleitor',
  'nascim',
  'dtnasc',
];

/** Tokens that make `conta`/`nome` ambiguous in public-accounting databases. */
const NOT_PERSONAL_HINTS = new Set(['contabil', 'contabeis', 'receita', 'despesa', 'plano']);

function tokensOf(name: string): string[] {
  return (
    normalizeName(name)
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      // drop table-prefix tokens like `z01`, `k00`, `e60`
      .filter((t) => !/^[a-z]{1,3}\d{1,3}$/.test(t))
  );
}

/** Kind of masking a column name calls for, or null when the name is not sensitive. */
export function sensitiveKindByName(name: string): MaskKind | null {
  const tokens = tokensOf(name);
  if (tokens.length === 0) return null;
  const compact = tokens.join('');
  const has = (set: Set<string>): boolean => tokens.some((t) => set.has(t));
  const hasPart = (parts: string[]): boolean => parts.some((p) => compact.includes(p));

  if (has(SECRET_TOKENS) || hasPart(SECRET_PARTS)) return 'secret';
  if (has(EMAIL_TOKENS) || hasPart(EMAIL_PARTS)) return 'email';
  if (has(DIGIT_TOKENS) || hasPart(DIGIT_PARTS)) return 'digits';
  if (has(NAME_TOKENS) || hasPart(NAME_PARTS)) {
    return tokens.some((t) => NOT_PERSONAL_HINTS.has(t)) ? null : 'name';
  }
  if (has(GENERIC_TOKENS) || hasPart(GENERIC_PARTS)) {
    return tokens.some((t) => NOT_PERSONAL_HINTS.has(t)) ? null : 'generic';
  }
  return null;
}

/** Token kind a name-detected column should be tokenized with. */
export function piiKindOfMask(kind: MaskKind, name: string): PiiKind {
  switch (kind) {
    case 'email':
      return 'EMAIL';
    case 'name':
      return 'NOME';
    case 'secret':
      return 'SEGREDO';
    case 'generic':
      return /ender|logradouro|rua|bairro|complemento/.test(normalizeName(name))
        ? 'ENDERECO'
        : 'VALOR';
    case 'digits': {
      const n = normalizeName(name);
      if (/cnpj|cgc/.test(n) && !/cpf/.test(n)) return 'CNPJ';
      if (/cpf/.test(n) && !/cnpj|cgc/.test(n)) return 'CPF';
      if (/fone|celular|whatsapp|\btel/.test(n)) return 'TELEFONE';
      if (/cep/.test(n)) return 'CEP';
      if (/\brg\b|_rg|rg_/.test(n)) return 'RG';
      if (/pis|pasep|nis|nit/.test(n)) return 'PIS';
      if (/cnh/.test(n)) return 'CNH';
      if (/cart/.test(n)) return 'CARTAO';
      return 'VALOR';
    }
  }
}
