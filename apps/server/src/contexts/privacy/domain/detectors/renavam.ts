import type { Detector } from '../pii';
import { allSame, bounded, eachMatch, hasContextBefore, span, weightedSum } from './util';

const WEIGHTS = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** RENAVAM: 9-11 digits (older ones are left-padded with zeros to 11), one check digit. */
export function isValidRenavam(value: string): boolean {
  const raw = value.replace(/\D/g, '');
  if (raw.length < 9 || raw.length > 11) return false;
  const d = raw.padStart(11, '0');
  if (allSame(d)) return false;
  let dv = (weightedSum(d.slice(0, 10), WEIGHTS) * 10) % 11;
  if (dv === 10) dv = 0;
  return dv === Number(d[10]);
}

const CONTEXT = 'renavam|registro nacional de veiculos';

export const renavamDetector: Detector = {
  kind: 'RENAVAM',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    eachMatch(new RegExp(bounded('\\d{9,11}')), text, (m, start, end) => {
      if (!isValidRenavam(m[0]) || !hasContextBefore(text, start, CONTEXT)) return;
      out.push(span(start, end, 'RENAVAM', 0.97));
    });
    return out;
  },
};
