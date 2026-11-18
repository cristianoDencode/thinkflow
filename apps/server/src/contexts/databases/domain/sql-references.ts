import { LexError, tokenize, type Token } from './sql-guard';

/**
 * Lexical extraction of the tables and qualified columns a SELECT names, so they can be checked
 * against the catalog BEFORE the statement runs. It is deliberately conservative: whatever it is
 * not sure about (function calls in FROM, subquery aliases, CTEs, unqualified columns…) is simply
 * not reported, and Postgres' own analysis (`EXPLAIN`) is the final word for those.
 */
export interface TableRef {
  /** Schema as written (`public` in `public.cgm`), null when unqualified. */
  schema: string | null;
  /** Table name as Postgres reads it: lower-cased when unquoted, exact when `"quoted"`. */
  name: string;
  alias: string | null;
  /** A `WITH` name or other relation that is not a catalog table: never validated. */
  cte: boolean;
  /** Query block (SELECT) where it appears; see `scopes`. */
  scope: number;
  /** Offset in the SQL text. */
  pos: number;
}

export interface ColumnRef {
  /**
   * Name parts as written: `[alias, column]` or `[schema, table, column]` (a trailing extra part,
   * e.g. a composite field, is kept and resolved by the validator).
   */
  parts: string[];
  scope: number;
  pos: number;
}

export interface SqlReferences {
  tables: TableRef[];
  columns: ColumnRef[];
  /** Names defined by `WITH name AS (...)`: they are not catalog tables. */
  cteNames: string[];
  /** Query blocks; `parent` is the enclosing one (correlated subqueries see its aliases). */
  scopes: { id: number; parent: number | null }[];
}

const EMPTY: SqlReferences = { tables: [], columns: [], cteNames: [], scopes: [] };

/** Words that end the FROM list of a query block. */
const FROM_TERMINATORS = new Set([
  'where',
  'group',
  'order',
  'having',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'window',
  'fetch',
  'for',
  'returning',
  'select',
]);

/** Cannot be a table alias (they continue/close the table expression). */
const NOT_AN_ALIAS = new Set([
  ...FROM_TERMINATORS,
  'on',
  'using',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'outer',
  'lateral',
  'tablesample',
  'as',
  'with',
  'from',
]);

/** Functions whose parentheses may hold a `FROM` that is not a table list. */
const FROM_INSIDE_FUNCTIONS = new Set(['extract', 'substring', 'trim', 'overlay', 'position']);

const isName = (t: Token | undefined): t is Token & { kind: 'word' | 'qident' } =>
  t?.kind === 'word' || t?.kind === 'qident';

const isPunct = (t: Token | undefined, value: string): boolean =>
  t?.kind === 'punct' && t.value === value;

const isWord = (t: Token | undefined, ...values: string[]): boolean =>
  t?.kind === 'word' && values.includes(t.value);

interface Frame {
  scope: number;
  /** `FROM` inside this frame is not a table list (extract/substring/trim… or `[...]`). */
  noFrom: boolean;
  /** Commas continue a FROM list. */
  fromActive: boolean;
  /** The next token starts a table expression. */
  expectTable: boolean;
}

/** Names of the CTEs: `[WITH [RECURSIVE]|,] name [(cols)] AS [[NOT] MATERIALIZED] (SELECT|...`. */
function collectCteNames(tokens: Token[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (!isName(t)) continue;
    const prev = tokens[i - 1];
    if (!(isWord(prev, 'with', 'recursive') || isPunct(prev, ','))) continue;
    let j = i + 1;
    if (isPunct(tokens[j], '(')) {
      let depth = 0;
      for (; j < tokens.length; j += 1) {
        if (isPunct(tokens[j], '(')) depth += 1;
        else if (isPunct(tokens[j], ')') && --depth === 0) break;
      }
      j += 1;
    }
    if (!isWord(tokens[j], 'as')) continue;
    j += 1;
    if (isWord(tokens[j], 'not')) j += 1;
    if (isWord(tokens[j], 'materialized')) j += 1;
    if (isPunct(tokens[j], '(') && isWord(tokens[j + 1], 'select', 'with', 'values', 'table'))
      names.push(t.value);
  }
  return names;
}

export function extractReferences(sql: string): SqlReferences {
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch (err) {
    if (err instanceof LexError) return EMPTY;
    throw err;
  }
  if (tokens.length === 0) return EMPTY;

  const cteNames = collectCteNames(tokens);
  const cte = new Set(cteNames);
  const scopes: SqlReferences['scopes'] = [{ id: 0, parent: null }];
  const tables: TableRef[] = [];
  const columns: ColumnRef[] = [];
  const frames: Frame[] = [{ scope: 0, noFrom: false, fromActive: false, expectTable: false }];
  const top = (): Frame => frames[frames.length - 1]!;

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const frame = top();

    if (isPunct(t, '(')) {
      const next = tokens[i + 1];
      if (isWord(next, 'select', 'with', 'values')) {
        const id = scopes.length;
        scopes.push({ id, parent: frame.scope });
        frames.push({ scope: id, noFrom: false, fromActive: false, expectTable: false });
        frame.expectTable = false;
      } else {
        const before = tokens[i - 1];
        frames.push({
          scope: frame.scope,
          noFrom: before?.kind === 'word' && FROM_INSIDE_FUNCTIONS.has(before.value),
          fromActive: false,
          // `FROM (a JOIN b ON …)`: the parenthesis still starts a table expression
          expectTable: frame.expectTable,
        });
        frame.expectTable = false;
      }
      i += 1;
      continue;
    }
    if (isPunct(t, '[')) {
      frames.push({ scope: frame.scope, noFrom: true, fromActive: false, expectTable: false });
      i += 1;
      continue;
    }
    if (isPunct(t, ')') || isPunct(t, ']')) {
      if (frames.length > 1) frames.pop();
      i += 1;
      continue;
    }

    if (frame.expectTable) {
      const consumed = readTable(tokens, i, frame, tables, cte);
      frame.expectTable = false;
      if (consumed > 0) {
        i += consumed;
        continue;
      }
    }

    if (t.kind === 'word') {
      if (t.value === 'from') {
        const before = tokens[i - 1];
        if (!frame.noFrom && !isWord(before, 'distinct')) {
          frame.fromActive = true;
          frame.expectTable = true;
        }
        i += 1;
        continue;
      }
      if (t.value === 'join') {
        frame.fromActive = true;
        frame.expectTable = true;
        i += 1;
        continue;
      }
      if (FROM_TERMINATORS.has(t.value)) {
        frame.fromActive = false;
        i += 1;
        continue;
      }
    }
    if (isPunct(t, ',') && frame.fromActive) {
      frame.expectTable = true;
      i += 1;
      continue;
    }

    if (isName(t)) {
      const consumed = readQualifiedColumn(tokens, i, frame.scope, columns);
      i += consumed > 0 ? consumed : 1;
      continue;
    }
    i += 1;
  }
  return { tables, columns, cteNames, scopes };
}

/** Reads a dotted name starting at `i`: its parts and the index after it. */
function readDotted(tokens: Token[], i: number): { parts: string[]; end: number } {
  const parts: string[] = [];
  let j = i;
  for (let token = tokens[j]; isName(token); token = tokens[j]) {
    parts.push(token.value);
    if (isPunct(tokens[j + 1], '.') && isName(tokens[j + 2])) j += 2;
    else {
      j += 1;
      break;
    }
  }
  return { parts, end: j };
}

/**
 * `alias.column` / `schema.table.column` outside the FROM list. Returns the tokens consumed
 * (0 = not a qualified reference). Skips function calls, type casts and `alias.*`.
 */
function readQualifiedColumn(tokens: Token[], i: number, scope: number, out: ColumnRef[]): number {
  const before = tokens[i - 1];
  // `::schema.type`, `x.y` after another dot (already part of a chain), `$1.x`
  if (isPunct(before, '.') || isPunct(before, ':')) return 0;
  if (!isPunct(tokens[i + 1], '.')) return 0;
  const { parts, end } = readDotted(tokens, i);
  const after = tokens[end];
  if (parts.length < 2) return 0;
  // schema.function(…) or table.* : not a column
  if (isPunct(after, '(')) return end - i;
  if (isPunct(after, '.')) return end - i; // `.*` or a chain we do not understand
  if (parts.length > 4) return end - i;
  out.push({ parts, scope, pos: tokens[i]!.pos });
  return end - i;
}

/**
 * Table expression at `i` (right after FROM/JOIN/comma). Returns the tokens consumed, 0 when
 * nothing table-like starts here (subquery, parenthesized join, function…).
 */
function readTable(
  tokens: Token[],
  start: number,
  frame: Frame,
  out: TableRef[],
  cte: Set<string>,
): number {
  let i = start;
  while (isWord(tokens[i], 'only', 'lateral')) i += 1;
  if (!isName(tokens[i])) return i - start;
  const first = tokens[i]!;
  // ROWS FROM (…) is a function-ish construct
  if (isWord(first, 'rows') && isWord(tokens[i + 1], 'from')) return 0;
  const { parts, end } = readDotted(tokens, i);
  // function call in FROM (generate_series(…), unnest(…)): not a table
  if (isPunct(tokens[end], '(')) return end - start;
  let j = end;
  let alias: string | null = null;
  if (isWord(tokens[j], 'as')) {
    j += 1;
    const named = tokens[j];
    if (isName(named)) {
      alias = named.value;
      j += 1;
    }
  } else {
    const candidate = tokens[j];
    if (isName(candidate) && !(candidate.kind === 'word' && NOT_AN_ALIAS.has(candidate.value))) {
      alias = candidate.value;
      j += 1;
    }
  }
  const name = parts[parts.length - 1]!;
  const schema = parts.length >= 2 ? parts[parts.length - 2]! : null;
  const isCte = schema === null && cte.has(name);
  out.push({ schema, name, alias, cte: isCte, scope: frame.scope, pos: first.pos });
  return j - start;
}
