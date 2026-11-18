import prenomes from '../data/prenomes.json';
import type { Detector, Span } from './pii';
import { fold } from './detectors/util';

/** Brazilian first names (IBGE + curated), lowercase and accent-free. */
const FIRST_NAMES: ReadonlySet<string> = new Set(prenomes as string[]);

/** Particles allowed between the parts of a name: "João da Silva", "Maria de Lourdes e Souza". */
const CONNECTORS = new Set(['da', 'de', 'do', 'dos', 'das', 'e']);

/** Words that are first names but far more often places/things in registries. */
const NOT_NAMES = new Set(['natal', 'israel', 'jordan', 'santiago', 'assis']);

export function isFirstName(word: string): boolean {
  const w = fold(word);
  return FIRST_NAMES.has(w) && !NOT_NAMES.has(w);
}

const MAX_WORDS = 8;
const WORD_RE = /\p{L}+(?:['’-]\p{L}+)*/gu;

type WordShape = 'name' | 'connector' | 'other';

interface Word {
  text: string;
  start: number;
  end: number;
  shape: WordShape;
}

function shapeOf(word: string): WordShape {
  const lower = word.toLowerCase();
  // connectors are written lowercase ("da") or, inside ALL CAPS text, uppercase ("DA")
  if (CONNECTORS.has(lower) && (word === lower || word === word.toUpperCase())) return 'connector';
  // Capitalized ("Silva", "D'Ávila") or ALL CAPS ("SILVA", "JOAO"); not "McDonald"/"iPhone".
  const letters = word.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return 'other';
  if (letters === letters.toUpperCase()) return 'name';
  const head = letters.slice(0, 1);
  const tail = letters.slice(1);
  const capitalized = head === head.toUpperCase() && tail === tail.toLowerCase();
  return capitalized ? 'name' : 'other';
}

/** Words that follow each other separated only by blanks (no punctuation, no line break). */
function groupRuns(text: string): Word[][] {
  const runs: Word[][] = [];
  let run: Word[] = [];
  let prevEnd = -1;
  for (const m of text.matchAll(WORD_RE)) {
    const start = m.index ?? 0;
    const w: Word = {
      text: m[0],
      start,
      end: start + m[0].length,
      shape: shapeOf(m[0]),
    };
    const gap = prevEnd < 0 ? '' : text.slice(prevEnd, start);
    const adjacent = prevEnd >= 0 && /^[ \t\u00a0]+$/.test(gap);
    if (!adjacent && run.length > 0) {
      runs.push(run);
      run = [];
    }
    run.push(w);
    prevEnd = w.end;
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * Person-name heuristic: a sequence of at least two capitalized (or ALL CAPS) words, optionally
 * linked by da/de/do/dos/das/e, whose first word is a known Brazilian first name. Catches
 * "João da Silva", "Maria Aparecida Souza" and the uppercase "JOAO DA SILVA" of e-Cidade; it does
 * not touch "Rua das Flores" or "Brasil". It is a heuristic: a street named after a person
 * ("Avenida Pedro Álvares") may be tokenized too.
 */
export const nameDetector: Detector = {
  kind: 'NOME',
  find(text) {
    const out: Span[] = [];
    for (const run of groupRuns(text)) {
      let i = 0;
      while (i < run.length) {
        const first = run[i] as Word;
        if (first.shape !== 'name' || !isFirstName(first.text)) {
          i++;
          continue;
        }
        // extend over name words and connectors; a connector must be followed by a name word
        let last = i;
        for (let j = i + 1; j < run.length && j - i < MAX_WORDS; j++) {
          const w = run[j] as Word;
          if (w.shape === 'name') last = j;
          else if (w.shape === 'connector' && (run[j + 1] as Word | undefined)?.shape === 'name') {
            continue;
          } else break;
        }
        const count = run.slice(i, last + 1).filter((w) => w.shape === 'name').length;
        if (count >= 2) {
          out.push({
            start: first.start,
            end: (run[last] as Word).end,
            kind: 'NOME',
            score: count >= 3 ? 0.8 : 0.7,
            source: 'native',
          });
        }
        i = last + 1;
      }
    }
    return out;
  },
};
