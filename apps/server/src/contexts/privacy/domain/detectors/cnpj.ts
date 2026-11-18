import type { Detector } from '../pii';
import { allSame, eachMatch, hasContextBefore, span } from './util';

const W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** Value of one CNPJ char: ASCII code - 48 (digits 0-9, letters A=17 ... Z=42). */
const charValue = (c: string): number => c.charCodeAt(0) - 48;

function checkDigit(chars: string, weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += charValue(chars[i] ?? '0') * (weights[i] ?? 0);
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}

/** Strips `. / -` and uppercases. */
export function normalizeCnpj(value: string): string {
  return value.replace(/[.\-/\s]/g, '').toUpperCase();
}

/**
 * CNPJ with valid check digits: the classic 14 digits or the 2026 alphanumeric format (12
 * chars `[0-9A-Z]` + 2 numeric DVs; each char weighs ASCII code - 48).
 */
export function isValidCnpj(value: string): boolean {
  const c = normalizeCnpj(value);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || allSame(c)) return false;
  return checkDigit(c, W1) === Number(c[12]) && checkDigit(c.slice(0, 13), W2) === Number(c[13]);
}

const CONTEXT = 'cnpj|cgc|cadastro nacional da pessoa juridica';
// Not glued to other alphanumerics (alphanumeric CNPJ) nor to a longer formatted number.
const RE =
  /(?<![0-9A-Za-z]|\d[.\-/])[0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}\/?[0-9A-Z]{4}-?\d{2}(?![0-9A-Za-z]|[.\-/]\d)/;

export const cnpjDetector: Detector = {
  kind: 'CNPJ',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    eachMatch(RE, text, (m, start, end) => {
      if (!isValidCnpj(m[0])) return;
      const formatted = /[./-]/.test(m[0]);
      const hasLetter = /[A-Z]/.test(m[0]);
      const ctx = hasContextBefore(text, start, CONTEXT);
      // A bare string with letters is too easily an internal id: demand the "CNPJ" context.
      if (hasLetter && !formatted && !ctx) return;
      out.push(span(start, end, 'CNPJ', ctx ? 0.99 : formatted ? 0.95 : 0.85));
    });
    return out;
  },
};
