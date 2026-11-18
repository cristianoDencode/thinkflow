import type { Detector } from '../pii';
import { eachMatch, hasContextBefore, span } from './util';

const CONTEXT = 'placa|veiculo|automovel|carro|moto';

// Old: ABC-1234 / ABC1234; Mercosul: ABC1D23. Uppercase only, not glued to other letters/digits.
const RULES = [
  { re: /(?<![A-Za-z0-9])[A-Z]{3}-\d{4}(?![A-Za-z0-9])/, score: 0.85 },
  { re: /(?<![A-Za-z0-9])[A-Z]{3}\d{4}(?![A-Za-z0-9])/, score: 0.6 },
  { re: /(?<![A-Za-z0-9])[A-Z]{3}\d[A-Z]\d{2}(?![A-Za-z0-9])/, score: 0.85 },
];

export const plateDetector: Detector = {
  kind: 'PLACA',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    for (const rule of RULES) {
      eachMatch(rule.re, text, (_m, start, end) => {
        const ctx = hasContextBefore(text, start, CONTEXT);
        out.push(span(start, end, 'PLACA', ctx ? 0.95 : rule.score));
      });
    }
    return out;
  },
};
