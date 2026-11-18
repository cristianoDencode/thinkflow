import type { Detector } from '../pii';
import { eachMatch, hasContextBefore, onlyDigits, span } from './util';

/** Luhn checksum over a digit string. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Payment card number: 13-19 digits, Luhn-valid, not all equal. */
export function isValidCard(value: string): boolean {
  const d = onlyDigits(value);
  return d.length >= 13 && d.length <= 19 && !/^(\d)\1+$/.test(d) && luhn(d);
}

/** Issuer prefixes (Visa, Mastercard, Amex, Elo, Hipercard, Diners, Discover, JCB). */
const ISSUER = /^(?:4|5[0-5]|2[2-7]|3[0-9]|6011|65|636|50|60|62|38)/;

const CONTEXT = 'cartao|card|credito|debito|visa|master|mastercard|elo|amex|hipercard|pan';

const PATTERNS = [
  '\\d{4}[ -]\\d{4}[ -]\\d{4}[ -]\\d{1,7}', // 4-4-4-N
  '\\d{4}[ -]\\d{6}[ -]\\d{5}', // Amex 4-6-5
  '\\d{13,19}', // bare
];

export const cardDetector: Detector = {
  kind: 'CARTAO',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    for (const p of PATTERNS) {
      eachMatch(
        new RegExp(`(?<!\\d|\\d[ .\\-/])(?:${p})(?!\\d|[ .\\-/]\\d)`),
        text,
        (m, start, end) => {
          if (!isValidCard(m[0])) return;
          const spaced = /[ -]/.test(m[0]);
          const ctx = hasContextBefore(text, start, CONTEXT);
          const issuer = ISSUER.test(onlyDigits(m[0]));
          if (!spaced && !ctx && !issuer) return;
          // Bare Luhn-valid runs are weak (1 in 10 random numbers): keep them below CPF/CNPJ/CNS.
          out.push(span(start, end, 'CARTAO', ctx ? 0.95 : spaced ? 0.9 : 0.6));
        },
      );
    }
    return out;
  },
};
