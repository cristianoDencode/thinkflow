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

/** Check digit of the first `digits.length` digits (9 → DV1, 10 → DV2), weights counting down from length+1. */
function dv(digits: string): number {
  const weights = Array.from({ length: digits.length }, (_, i) => digits.length + 1 - i);
  const r = (weightedSum(digits, weights) * 10) % 11;
  return r === 10 ? 0 : r;
}

/** CPF with valid check digits (11 digits, not all equal). Accepts formatted or bare input. */
export function isValidCpf(value: string): boolean {
  const d = onlyDigits(value);
  if (d.length !== 11 || allSame(d)) return false;
  return dv(d.slice(0, 9)) === Number(d[9]) && dv(d.slice(0, 10)) === Number(d[10]);
}

const CONTEXT = 'cpf|cadastro de pessoa fisica';

export const cpfDetector: Detector = {
  kind: 'CPF',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    eachMatch(new RegExp(bounded('\\d{3}\\.?\\d{3}\\.?\\d{3}-?\\d{2}')), text, (m, start, end) => {
      if (!isValidCpf(m[0])) return;
      const formatted = /[.-]/.test(m[0]);
      const ctx = hasContextBefore(text, start, CONTEXT);
      out.push(span(start, end, 'CPF', ctx ? 0.99 : formatted ? 0.95 : 0.8));
    });
    return out;
  },
};
