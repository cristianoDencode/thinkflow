import type { Detector } from '../pii';
import { allSame, bounded, eachMatch, hasContextBefore, span } from './util';

const CONTEXT =
  'rg|r\\.g\\.?|identidade|registro geral|carteira de identidade|ci|documento de identidade';

/** RG (7-9 digits, optional X digit, dots/hyphen optional) — only with a nearby context word. */
export const rgDetector: Detector = {
  kind: 'RG',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    eachMatch(
      new RegExp(bounded('\\d{1,2}\\.?\\d{3}\\.?\\d{3}-?[\\dXx]|\\d{7,9}')),
      text,
      (m, start, end) => {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length < 7 || allSame(digits)) return;
        if (hasContextBefore(text, start, CONTEXT)) out.push(span(start, end, 'RG', 0.9));
      },
    );
    return out;
  },
};
