import { DATABASE_LIMITS } from '@thinkflow/shared';

/**
 * First line of defence for SQL that reaches a connection ("Dados com IA"): a pure lexical check
 * that only lets a single read-only statement through. The second line is the database itself —
 * every statement runs in a READ ONLY transaction — so this guard may be conservative.
 */
export type SqlGuardResult = { ok: true; sql: string } | { ok: false; reason: string };

const ALLOWED_FIRST = new Set(['select', 'with', 'values', 'table', 'explain']);

const FORBIDDEN_KEYWORDS = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'truncate',
  'drop',
  'alter',
  'create',
  'grant',
  'revoke',
  'copy',
  'call',
  'do',
  'set',
  'reset',
  'lock',
  'vacuum',
  'analyze',
  'analyse',
  'cluster',
  'reindex',
  'refresh',
  'listen',
  'notify',
  'unlisten',
  'begin',
  'start',
  'commit',
  'rollback',
  'savepoint',
  'release',
  'prepare',
  'execute',
  'deallocate',
  'discard',
  'security',
  'import',
  'load',
  'checkpoint',
  'comment',
  'into',
]);

const FORBIDDEN_FUNCTIONS = new Set([
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'set_config',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'nextval',
  'setval',
  'txid_current',
]);
const FORBIDDEN_FUNCTION_PREFIXES = ['lo_', 'dblink', 'pg_sleep', 'pg_advisory_', 'pg_ls_'];

export type Token =
  | { kind: 'word'; value: string; pos: number }
  | { kind: 'qident'; value: string; pos: number }
  | { kind: 'string'; pos: number }
  | { kind: 'punct'; value: string; pos: number };

const isIdentStart = (c: string): boolean => /[A-Za-z_\u0080-￿]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(c);

export class LexError extends Error {}

/** Splits SQL into tokens, skipping comments and the contents of strings/quoted identifiers. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      if (depth > 0) throw new LexError('comentário /* */ não foi fechado');
    } else if (c === "'") {
      const prev = sql[i - 1];
      const beforePrev = sql[i - 2];
      // E'...' strings accept backslash escapes
      const escapeString =
        (prev === 'e' || prev === 'E') && (!beforePrev || !isIdentPart(beforePrev));
      const start = i;
      i += 1;
      let closed = false;
      while (i < n) {
        const ch = sql[i]!;
        if (escapeString && ch === '\\') {
          i += 2;
        } else if (ch === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i += 1;
            closed = true;
            break;
          }
        } else i += 1;
      }
      if (!closed) throw new LexError('texto entre aspas simples não foi fechado');
      tokens.push({ kind: 'string', pos: start });
    } else if (c === '"') {
      const start = i;
      i += 1;
      let value = '';
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i += 1;
            closed = true;
            break;
          }
        } else {
          value += sql[i];
          i += 1;
        }
      }
      if (!closed) throw new LexError('identificador entre aspas duplas não foi fechado');
      tokens.push({ kind: 'qident', value, pos: start });
    } else if (c === '$') {
      const prev = sql[i - 1];
      const tag = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i));
      if (tag && !(prev && isIdentPart(prev))) {
        const delimiter = tag[0];
        const end = sql.indexOf(delimiter, i + delimiter.length);
        if (end === -1) throw new LexError(`bloco ${delimiter} não foi fechado`);
        tokens.push({ kind: 'string', pos: i });
        i = end + delimiter.length;
      } else {
        // positional parameter ($1) or stray dollar: not an identifier on its own
        tokens.push({ kind: 'punct', value: '$', pos: i });
        i += 1;
      }
    } else if (isIdentStart(c)) {
      const start = i;
      i += 1;
      while (i < n && isIdentPart(sql[i]!)) i += 1;
      tokens.push({ kind: 'word', value: sql.slice(start, i).toLowerCase(), pos: start });
    } else if (/[0-9]/.test(c)) {
      // numbers (including 1e10, 0x1F, 1_000): consumed so that suffixes are not read as words
      const start = i;
      i += 1;
      while (i < n && /[0-9A-Za-z_.]/.test(sql[i]!)) i += 1;
      tokens.push({ kind: 'punct', value: sql.slice(start, i), pos: start });
    } else {
      tokens.push({ kind: 'punct', value: c, pos: i });
      i += 1;
    }
  }
  return tokens;
}

const reject = (reason: string): SqlGuardResult => ({ ok: false, reason });

export function checkReadOnlySql(input: string): SqlGuardResult {
  const sql = input.trim();
  if (!sql) return reject('a consulta está vazia');
  if (sql.length > DATABASE_LIMITS.maxSqlChars)
    return reject(`a consulta passa de ${DATABASE_LIMITS.maxSqlChars} caracteres`);

  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch (err) {
    return reject(err instanceof LexError ? err.message : 'não foi possível analisar a consulta');
  }

  let body = sql;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === 'punct' && last.value === ';') {
    body = sql.slice(0, last.pos).trim();
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length === 0) return reject('a consulta está vazia (só comentários)');
  if (tokens.some((t) => t.kind === 'punct' && t.value === ';'))
    return reject('só é permitida uma instrução por vez (remova o ";" do meio)');

  const firstIdx = tokens.findIndex((t) => !(t.kind === 'punct' && t.value === '('));
  const first = tokens[firstIdx];
  if (first?.kind === 'word' && FORBIDDEN_KEYWORDS.has(first.value)) {
    return reject(`o comando ${first.value.toUpperCase()} não é permitido (somente leitura)`);
  }
  if (!first || first.kind !== 'word' || !ALLOWED_FIRST.has(first.value)) {
    return reject('a consulta precisa começar com SELECT, WITH, VALUES, TABLE ou EXPLAIN');
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    const after = tokens[i + 1];
    const before = tokens[i - 1];
    const isCall = after?.kind === 'punct' && after.value === '(';

    if (t.kind === 'word') {
      const qualified = before?.kind === 'punct' && before.value === '.';
      if (!qualified && FORBIDDEN_KEYWORDS.has(t.value)) {
        return reject(
          `o comando ${t.value.toUpperCase()} não é permitido (somente leitura; se for nome de coluna ou tabela, coloque entre aspas duplas)`,
        );
      }
      if (t.value === 'for' && after?.kind === 'word') {
        const afterNext = tokens[i + 2];
        if (
          after.value === 'share' ||
          after.value === 'update' ||
          after.value === 'no' ||
          (after.value === 'key' && afterNext?.kind === 'word' && afterNext.value === 'share')
        ) {
          return reject('cláusulas de bloqueio (FOR UPDATE / FOR SHARE) não são permitidas');
        }
      }
    }
    if ((t.kind === 'word' || t.kind === 'qident') && isCall) {
      const name = t.value.toLowerCase();
      if (
        FORBIDDEN_FUNCTIONS.has(name) ||
        FORBIDDEN_FUNCTION_PREFIXES.some((p) => name.startsWith(p))
      ) {
        return reject(`a função ${name} não é permitida (somente leitura)`);
      }
    }
  }

  return { ok: true, sql: body };
}

/** Hint appended to rejections shown to the AI. */
export const READ_ONLY_HINT =
  'Só consultas de leitura são permitidas: uma única instrução SELECT/WITH/VALUES/TABLE/EXPLAIN (sem ANALYZE).';
