import type { Detector } from '../pii';
import {
  allSame,
  bounded,
  eachMatch,
  hasContextBefore,
  onlyDigits,
  span,
  weightedSum,
} from './util';

const WEIGHTS = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** PIS / PASEP / NIS / NIT: 11 digits, mod-11 check digit. */
export function isValidPis(value: string): boolean {
  const d = onlyDigits(value);
  if (d.length !== 11 || allSame(d)) return false;
  let dv = 11 - (weightedSum(d, WEIGHTS) % 11);
  if (dv >= 10) dv = 0;
  return dv === Number(d[10]);
}

const CONTEXT = 'pis|pasep|nis|nit|pis/pasep|pis-pasep|numero de inscricao social';

export const pisDetector: Detector = {
  kind: 'PIS',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    // Formatted (123.45678.90-1) is distinctive; a bare 11-digit run needs the context word,
    // otherwise 1 in 11 random numbers would pass the check digit.
    eachMatch(new RegExp(bounded('\\d{3}\\.?\\d{5}\\.?\\d{2}-?\\d')), text, (m, start, end) => {
      if (!isValidPis(m[0])) return;
      const formatted = /[.-]/.test(m[0]);
      const ctx = hasContextBefore(text, start, CONTEXT);
      if (!formatted && !ctx) return;
      out.push(span(start, end, 'PIS', ctx ? 0.97 : 0.8));
    });
    return out;
  },
};
