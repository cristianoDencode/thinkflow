import type { Detector } from '../pii';
import { eachMatch, span } from './util';

const RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

export const emailDetector: Detector = {
  kind: 'EMAIL',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    eachMatch(RE, text, (_m, start, end) => {
      // trailing "." / "-" belong to the sentence, not to the address
      let e = end;
      while (e > start && /[.\-_]/.test(text[e - 1] ?? '')) e--;
      out.push(span(start, e, 'EMAIL', 0.95));
    });
    return out;
  },
};
