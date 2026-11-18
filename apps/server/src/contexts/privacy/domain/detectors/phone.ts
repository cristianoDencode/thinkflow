import type { Detector } from '../pii';
import { eachMatch, hasContextBefore, span } from './util';

/** Valid Brazilian area codes (DDD). */
const DDDS = new Set(
  (
    '11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 ' +
    '51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 ' +
    '93 94 95 96 97 98 99'
  ).split(' '),
);

export const isValidDdd = (ddd: string): boolean => DDDS.has(ddd);

const CONTEXT =
  'tel|telefone|fone|celular|cel|whatsapp|zap|contato|ligar|ligue|telef|fax|phone|mobile';
const NO_DIGIT_BEFORE = '(?<![\\d]|\\d[ .\\-])';
const NO_DIGIT_AFTER = '(?!\\d|[ .\\-]\\d)';
const wrap = (s: string): RegExp => new RegExp(`${NO_DIGIT_BEFORE}(?:${s})${NO_DIGIT_AFTER}`);

interface Rule {
  re: RegExp;
  /** Needs a context word before it. */
  needsContext: boolean;
  score: number;
  /** Index of the capture group with the DDD (if any). */
  ddd?: number;
}

const RULES: Rule[] = [
  // (11) 99999-8888 | (11)999998888 | +55 (11) 99999-8888
  {
    re: wrap('(?:\\+?55[ .\\-]?)?\\((\\d{2})\\)[ .\\-]?9?\\d{4}[ .\\-]?\\d{4}'),
    needsContext: false,
    score: 0.92,
    ddd: 1,
  },
  // +55 11 99999-8888 | +5511999998888
  {
    re: wrap('\\+55[ .\\-]?(\\d{2})[ .\\-]?9?\\d{4}[ .\\-]?\\d{4}'),
    needsContext: false,
    score: 0.92,
    ddd: 1,
  },
  // 11 99999-8888 | 11-99999-8888 (hyphen between the last blocks)
  { re: wrap('(\\d{2})[ .\\-]9?\\d{4}-\\d{4}'), needsContext: false, score: 0.75, ddd: 1 },
  // bare 11999998888 / 1133334444 with a context word
  { re: wrap('(\\d{2})9\\d{8}|(\\d{2})[2-5]\\d{7}'), needsContext: true, score: 0.85, ddd: 1 },
  // 99999-8888 | 3333-4444 without DDD, with a context word
  { re: wrap('9?\\d{4}-\\d{4}'), needsContext: true, score: 0.7 },
];

export const phoneDetector: Detector = {
  kind: 'TELEFONE',
  find(text) {
    const out = [] as ReturnType<Detector['find']>;
    for (const rule of RULES) {
      eachMatch(rule.re, text, (m, start, end) => {
        if (rule.ddd !== undefined) {
          const ddd = m[rule.ddd] ?? m[rule.ddd + 1];
          if (ddd && !isValidDdd(ddd)) return;
        }
        const ctx = hasContextBefore(text, start, CONTEXT);
        if (rule.needsContext && !ctx) return;
        out.push(span(start, end, 'TELEFONE', ctx ? Math.min(rule.score + 0.1, 0.97) : rule.score));
      });
    }
    return out;
  },
};
