import { PII_KINDS, type PiiKind } from './pii';

/**
 * Reversible token store of one scope (a conversation, a report or a single request): the same
 * (kind, normalized value) always yields the same token inside the scope, and the token can be
 * turned back into the real value. Implementations are synchronous on purpose (in-memory or
 * better-sqlite3), so the tokenizer and the stream restorer stay simple.
 */
export interface Vault {
  /** Token (`[CPF_1]`) for the value; creates it on first sight. */
  tokenFor(kind: PiiKind, value: string): string;
  /** Real value behind a token, or undefined when the token is unknown to this scope. */
  valueOf(token: string): string | undefined;
  /** Every (token, kind, value) of the scope: the firewall uses it to re-tokenize known values. */
  entries(): Iterable<VaultEntry>;
}

export interface VaultEntry {
  token: string;
  kind: PiiKind;
  value: string;
}

const KIND_SET: ReadonlySet<string> = new Set(PII_KINDS);

export function formatToken(kind: PiiKind, n: number): string {
  return `[${kind}_${n}]`;
}

/** `[CPF_12]` → `{ kind: 'CPF', n: 12 }`, or null when it is not a well-formed token. */
export function parseToken(token: string): { kind: PiiKind; n: number } | null {
  const m = /^\[([A-Z]+)_(\d+)\]$/.exec(token);
  if (!m || !KIND_SET.has(m[1] as string)) return null;
  return { kind: m[1] as PiiKind, n: Number(m[2]) };
}

const foldLower = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Canonical form of a value for deduplication: "123.456.789-09" and "12345678909" are the same
 * CPF; "JOAO DA SILVA" and "João da Silva" the same name. The vault keeps the first form seen
 * as the value restored for the analyst.
 */
export function normalizeForVault(kind: PiiKind, value: string): string {
  switch (kind) {
    case 'CPF':
    case 'CNS':
    case 'PIS':
    case 'TITULO':
    case 'CNH':
    case 'CARTAO':
    case 'CEP':
      return value.replace(/\D/g, '');
    case 'RENAVAM':
      return value.replace(/\D/g, '').padStart(11, '0');
    case 'CNPJ':
    case 'RG':
    case 'PLACA':
      return value.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    case 'TELEFONE': {
      const d = value.replace(/\D/g, '');
      return d.length >= 12 && d.startsWith('55') ? d.slice(2) : d;
    }
    case 'EMAIL':
      return value.trim().toLowerCase();
    case 'NOME':
    case 'ENDERECO':
    case 'VALOR':
      return foldLower(value);
    case 'SEGREDO':
      return value;
  }
}

/** Vault in memory: the scope of one request (or a test). */
export class InMemoryVault implements Vault {
  private readonly byKey = new Map<string, string>();
  private readonly byToken = new Map<string, string>();
  private readonly counters = new Map<PiiKind, number>();

  tokenFor(kind: PiiKind, value: string): string {
    const key = `${kind}\u0000${normalizeForVault(kind, value)}`;
    const known = this.byKey.get(key);
    if (known) return known;
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const token = formatToken(kind, n);
    this.byKey.set(key, token);
    this.byToken.set(token, value);
    return token;
  }

  valueOf(token: string): string | undefined {
    return this.byToken.get(token);
  }

  entries(): Iterable<VaultEntry> {
    const out: VaultEntry[] = [];
    for (const [token, value] of this.byToken) {
      const parsed = parseToken(token);
      if (parsed) out.push({ token, kind: parsed.kind, value });
    }
    return out;
  }

  get size(): number {
    return this.byToken.size;
  }
}
