import type { Detector } from '../pii';
import { allSame, bounded, eachMatch, hasContextBefore, onlyDigits, span } from './util';

function dv(digits: string, weights: readonly number[], uf: number): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += Number(digits[i]) * (weights[i] ?? 0);
  let r = sum % 11;
  if (r === 10) r = 0;
  if (r === 0 && (uf === 1 || uf === 2)) r = 1; // SP and MG rule
  return r;
}

/** Título de eleitor: 12 digits = 8 sequence + 2 UF (01-28) + 2 check digits. */
export function isValidTitulo(value: string): boolean {
  const d = onlyDigits(value);
  if (d.length !== 12 || allSame(d)) return false;
  const uf = Number(d.slice(8, 10));
  if (uf < 1 || uf > 28) return false;
  const dv1 = dv(d.slice(0, 8), [2, 3, 4, 5, 6, 7, 8, 9], uf);
  if (dv1 !== Number(d[10])) return false;
  return dv(`${d.slice(8, 10)}${dv1}`, [7, 8, 9], uf) === Number(d[11]);
}

const CONTEXT = 'titulo de eleitor|titulo eleitoral|titulo|eleitor|inscricao eleitoral';

export const tituloDetector: Detector = {
  kind: 'TITULO',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    eachMatch(new RegExp(bounded('\\d{4}[ .]?\\d{4}[ .]?\\d{4}')), text, (m, start, end) => {
      if (!isValidTitulo(m[0])) return;
      const spaced = /[ .]/.test(m[0]);
      const ctx = hasContextBefore(text, start, CONTEXT);
      if (!spaced && !ctx) return; // a bare 12-digit run is too ambiguous without the word
      out.push(span(start, end, 'TITULO', ctx ? 0.97 : 0.75));
    });
    return out;
  },
};
