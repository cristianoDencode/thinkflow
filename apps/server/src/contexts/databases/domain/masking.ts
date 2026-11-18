import type { PiiKind, Span } from '../../privacy/domain/pii';
import { detectAll } from '../../privacy/domain/detect';
import {
  normalizeName,
  sensitiveKindByName,
  type MaskKind,
} from '../../privacy/domain/column-names';
export { normalizeName, sensitiveKindByName, type MaskKind };

/**
 * Masking of personal data before anything reaches the AI. Pure functions: detection by column
 * name (with e-Cidade style names such as `z01_cgccpf`) and by value (CPF, CNPJ, e-mail, phone).
 *
 * Value detection is deliberately permissive (format only, no check digit — fail closed) and is
 * complemented by the validated detectors of the `privacy` context (`detectAll`: CPF/CNPJ with
 * check digits, alphanumeric CNPJ, CNS, cards, phones, plates, person names...). The re-exports
 * below let callers reach those detectors from here. The reversible-token firewall is the next
 * step; this file stays the partial-masking fallback.
 */
export { detectAll } from '../../privacy/domain/detect';
export {
  isValidCard,
  isValidCnh,
  isValidCnpj,
  isValidCns,
  isValidCpf,
  isValidPis,
  isValidRenavam,
  isValidTitulo,
} from '../../privacy/domain/detectors';
export interface MaskingConfig {
  /** Extra column names always masked. */
  sensitiveColumns: readonly string[];
  /** Column names never masked (win over the automatic detection). */
  revealColumns: readonly string[];
}

const inList = (list: readonly string[], name: string): boolean => {
  const n = normalizeName(name);
  return list.some((c) => normalizeName(c) === n);
};

/** Masking kind for a column, honoring the connection's overrides; null when it can be shown. */
export function sensitiveKind(name: string, cfg: MaskingConfig): MaskKind | null {
  if (inList(cfg.revealColumns, name)) return null;
  const byName = sensitiveKindByName(name);
  if (byName) return byName;
  return inList(cfg.sensitiveColumns, name) ? 'generic' : null;
}

export function isSensitiveColumn(name: string, cfg: MaskingConfig): boolean {
  return sensitiveKind(name, cfg) !== null;
}

/* ------------------------------ values ------------------------------ */

const CPF_RE = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/;
const CNPJ_RE = /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^(?:\+?55\s?)?(?:\(\d{2}\)\s?|\d{2}\s)9?\d{4}-?\d{4}$/;
const EMBEDDED_RES: [RegExp, PiiKind][] = [
  [/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, 'CNPJ'],
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, 'CPF'],
  [/[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}/g, 'EMAIL'],
];

/** Partial-masking style for a kind found by the `privacy` detectors. */
function maskKindOf(kind: PiiKind): MaskKind {
  switch (kind) {
    case 'EMAIL':
      return 'email';
    case 'NOME':
      return 'name';
    case 'SEGREDO':
      return 'secret';
    case 'ENDERECO':
    case 'VALOR':
      return 'generic';
    default:
      return 'digits';
  }
}

/** Mask kind inferred from the value itself, or null when it does not look personal. */
export function valueKind(value: unknown): MaskKind | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (CPF_RE.test(v) || CNPJ_RE.test(v) || PHONE_RE.test(v)) return 'digits';
  if (EMAIL_RE.test(v)) return 'email';
  // validated detectors: bare/alphanumeric documents, cards, plates... when they cover the whole value
  const spans = v.length > 0 ? detectAll(v, { names: false }) : [];
  const only = spans.length === 1 ? spans[0] : undefined;
  if (only && only.start === 0 && only.end === v.length) return maskKindOf(only.kind);
  return null;
}

/** CPF (11 digits, formatted or not), CNPJ (14), e-mail or Brazilian phone number. */
export function looksSensitiveValue(value: unknown): boolean {
  return valueKind(value) !== null;
}

const stars = (n: number): string => '*'.repeat(Math.max(n, 0));

function maskDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return maskGeneric(raw);
  if (digits.length <= 4) return stars(digits.length);
  return `${digits.slice(0, 2)}${stars(digits.length - 4)}${digits.slice(-2)}`;
}

function maskEmail(raw: string): string {
  const at = raw.lastIndexOf('@');
  if (at <= 0) return maskGeneric(raw);
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const dot = domain.indexOf('.');
  const host = dot === -1 ? domain : domain.slice(0, dot);
  const tail = dot === -1 ? '' : domain.slice(dot);
  return `${local[0]}***@${host[0] ?? ''}***${tail}`;
}

function maskName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((w) => `${w[0]}${stars(Math.min(w.length - 1, 3))}`)
    .join(' ');
}

function maskGeneric(raw: string): string {
  const v = raw.trim();
  if (v.length <= 4) return stars(v.length);
  return `${v.slice(0, 2)}${stars(Math.min(v.length - 4, 8))}${v.slice(-2)}`;
}

/**
 * Masks one cell. `kind` comes from the column name; without it the kind is inferred from the
 * value. `null`/`undefined` stay `null`.
 */
export function maskValue(value: unknown, kind?: MaskKind): string | null {
  if (value === null || value === undefined) return null;
  const raw =
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  if (raw === '') return '';
  const k: MaskKind = kind ?? valueKind(raw) ?? 'generic';
  switch (k) {
    case 'secret':
      return '••••';
    case 'digits':
      return maskDigits(raw);
    case 'email':
      return EMAIL_RE.test(raw.trim()) ? maskEmail(raw.trim()) : maskGeneric(raw);
    case 'name':
      return typeof value === 'string' ? maskName(raw) : maskGeneric(raw);
    default:
      return maskGeneric(raw);
  }
}

/**
 * Masks personal data that appears inside free text: formatted CPF/CNPJ and e-mail by pattern,
 * plus everything the validated detectors of the `privacy` context find (bare CPF, phones,
 * cards, person names...).
 */
export function scrubText(text: string): string {
  const extra: Span[] = [];
  for (const [re, kind] of EMBEDDED_RES) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      extra.push({ start, end: start + m[0].length, kind, score: 0.99, source: 'native' });
    }
  }
  let out = '';
  let pos = 0;
  for (const s of detectAll(text, { extra })) {
    const raw = text.slice(s.start, s.end);
    out += text.slice(pos, s.start) + (maskValue(raw, maskKindOf(s.kind)) ?? raw);
    pos = s.end;
  }
  return out + text.slice(pos);
}
