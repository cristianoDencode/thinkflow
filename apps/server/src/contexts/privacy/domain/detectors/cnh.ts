import type { Detector } from '../pii';
import { allSame, bounded, eachMatch, hasContextBefore, span } from './util';

/** CNH (carteira de habilitação): 11 digits, two check digits. */
export function isValidCnh(value: string): boolean {
  const d = value.replace(/\D/g, '');
  if (d.length !== 11 || allSame(d)) return false;
  let v = 0;
  for (let i = 0, j = 9; i < 9; i++, j--) v += Number(d[i]) * j;
  let dv1 = v % 11;
  let dsc = 0;
  if (dv1 >= 10) {
    dv1 = 0;
    dsc = 2;
  }
  v = 0;
  for (let i = 0, j = 1; i < 9; i++, j++) v += Number(d[i]) * j;
  const x = v % 11;
  let dv2 = x >= 10 ? 0 : x - dsc;
  if (dv2 < 0) dv2 += 11;
  return dv1 === Number(d[9]) && dv2 === Number(d[10]);
}

const CONTEXT = 'cnh|habilitacao|carteira de motorista|carteira de habilitacao|registro da cnh';

export const cnhDetector: Detector = {
  kind: 'CNH',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    // Bare 11 digits only: always requires the context word.
    eachMatch(new RegExp(bounded('\\d{11}')), text, (m, start, end) => {
      if (!isValidCnh(m[0]) || !hasContextBefore(text, start, CONTEXT)) return;
      out.push(span(start, end, 'CNH', 0.97));
    });
    return out;
  },
};
