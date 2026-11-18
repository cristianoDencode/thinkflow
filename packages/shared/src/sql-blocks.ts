/**
 * SQL code blocks of a Markdown answer ("Dados com IA"). The server validates them when the answer
 * ends and the web matches each rendered block to its result by `index`, so both sides use this
 * one extractor on the same text.
 */

export interface SqlBlock {
  /** Position among the SQL blocks of the text (0-based). */
  index: number;
  /** The code, without the fences. */
  sql: string;
  /** Offset of the opening fence in the text. */
  start: number;
  /** Language label as written (lower case), '' when the fence has none. */
  lang: string;
}

const SQL_LANGS = new Set(['sql', 'postgresql', 'postgres', 'pgsql', 'psql']);
const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^\n]*)$/;

/** First word of the code, ignoring comments and opening parentheses. */
function firstWord(code: string): string {
  const stripped = code.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/^[\s(]+/, '');
  return /^[A-Za-z]+/.exec(stripped)?.[0]?.toLowerCase() ?? '';
}

/** An unlabeled block counts as SQL only when it reads like a query. */
function looksLikeQuery(code: string): boolean {
  const word = firstWord(code);
  return word === 'select' || word === 'with';
}

/**
 * ```sql / ```postgresql / ```pgsql blocks, and unlabeled blocks that start with SELECT or WITH.
 * An unclosed fence runs to the end (as Markdown renders it).
 */
export function extractSqlBlocks(text: string): SqlBlock[] {
  const blocks: SqlBlock[] = [];
  let open: { char: string; length: number; start: number; lang: string; body: string[] } | null =
    null;
  let offset = 0;

  const close = () => {
    if (!open) return;
    const sql = open.body.join('\n').trim();
    const labeled = SQL_LANGS.has(open.lang);
    if (sql && (labeled ? firstWord(sql) !== '' : open.lang === '' && looksLikeQuery(sql)))
      blocks.push({ index: blocks.length, sql, start: open.start, lang: open.lang });
    open = null;
  };

  for (const line of text.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!open) {
      const m = FENCE.exec(clean);
      // a backtick fence's info string cannot hold backticks (inline code such as ```x``` )
      if (m && !(m[2]!.startsWith('`') && m[3]!.includes('`'))) {
        const lang = (m[3] ?? '').trim().split(/[\s{]/)[0]!.toLowerCase();
        open = { char: m[2]![0]!, length: m[2]!.length, start: lineStart, lang, body: [] };
      }
      continue;
    }
    const closing = FENCE.exec(clean);
    if (
      closing &&
      closing[2]![0] === open.char &&
      closing[2]!.length >= open.length &&
      (closing[3] ?? '').trim() === ''
    ) {
      close();
    } else {
      open.body.push(clean);
    }
  }
  close();
  return blocks;
}

/* ------------------------------ validation ------------------------------ */

/** ok = tables/columns confirmed; invalid = something does not exist or is refused; unchecked = could not tell. */
export type SqlValidationStatus = 'ok' | 'invalid' | 'unchecked';

export interface SqlValidationIssueDto {
  /** What is wrong, in pt-BR (identifiers only, e.g. `coluna "x" não existe em public.y`). */
  message: string;
  /** Similar names that do exist ("Você quis dizer…"), best first. */
  suggestions: string[];
}

/** Result of checking a SQL against the database WITHOUT running it. */
export interface SqlValidationDto {
  status: SqlValidationStatus;
  issues: SqlValidationIssueDto[];
  /** Why it was `unchecked` (pt-BR), otherwise null. */
  reason: string | null;
}

/** Result for the SQL block number `index` of an answer (see `extractSqlBlocks`). */
export interface SqlBlockValidationDto extends SqlValidationDto {
  index: number;
}
