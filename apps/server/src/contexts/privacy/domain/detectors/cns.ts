import type { Detector } from '../pii';
import { bounded, eachMatch, hasContextBefore, onlyDigits, span, weightedSum } from './util';

const WEIGHTS = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

/** Cartão Nacional de Saúde (cartão SUS): 15 digits. Starts 1/2 (derived from PIS) or 7/8/9 (provisional). */
export function isValidCns(value: string): boolean {
  const d = onlyDigits(value);
  if (!/^\d{15}$/.test(d)) return false;
  const first = d[0] as string;
  if (first === '7' || first === '8' || first === '9') {
    return weightedSum(d, WEIGHTS) % 11 === 0;
  }
  if (first === '1' || first === '2') {
    const pis = d.slice(0, 11);
    const sum = weightedSum(pis, WEIGHTS);
    let dvCalc = 11 - (sum % 11);
    if (dvCalc === 11) dvCalc = 0;
    const expected =
      dvCalc === 10
        ? `${pis}001${11 - ((sum + 2) % 11) === 11 ? 0 : 11 - ((sum + 2) % 11)}`
        : `${pis}000${dvCalc}`;
    return expected === d;
  }
  return false;
}

const CONTEXT = 'cns|cartao sus|cartao nacional de saude|cartao do sus|sus';

export const cnsDetector: Detector = {
  kind: 'CNS',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    eachMatch(
      new RegExp(bounded('\\d{3}[ .]?\\d{4}[ .]?\\d{4}[ .]?\\d{4}')),
      text,
      (m, start, end) => {
        if (!isValidCns(m[0])) return;
        out.push(span(start, end, 'CNS', hasContextBefore(text, start, CONTEXT) ? 0.99 : 0.85));
      },
    );
    return out;
  },
};
