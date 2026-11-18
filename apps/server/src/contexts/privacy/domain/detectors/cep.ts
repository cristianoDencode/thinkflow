import type { Detector } from '../pii';
import { bounded, eachMatch, hasContextBefore, span } from './util';

const CONTEXT = 'cep|codigo postal|cod\\.? postal';

/** CEP (12345-678 or 12345678) — only with a nearby "CEP" word, since 8 digits are everywhere. */
export const cepDetector: Detector = {
  kind: 'CEP',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    eachMatch(new RegExp(bounded('\\d{5}-?\\d{3}')), text, (_m, start, end) => {
      if (hasContextBefore(text, start, CONTEXT)) out.push(span(start, end, 'CEP', 0.9));
    });
    return out;
  },
};
