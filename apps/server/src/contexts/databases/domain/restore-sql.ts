import { TOKEN_RE } from '../../privacy/domain/pii';
import type { Vault } from '../../privacy/domain/vault';

const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Turns the tokens the AI writes in a SQL text (`WHERE cpf = '[CPF_1]'`) back into the real
 * values, so the query runs against the real data. The text is scanned so each value is placed
 * safely:
 * - inside a `'...'` literal the value gets its quotes doubled;
 * - outside any literal (the AI forgot the quotes) the value becomes a quoted literal, unless
 *   it is a plain number;
 * - inside `"..."` identifiers the value gets its double quotes doubled;
 * - inside comments tokens are left alone (a restored newline could end a `--` comment).
 * Unknown tokens are left as they are. The restored SQL goes to the database and the analyst's
 * screen only: the AI keeps seeing (and echoing) the tokenized text.
 */
export function restoreSql(sql: string, vault: Vault): string {
  if (!sql.includes('[')) return sql;
  type State = 'code' | 'string' | 'ident' | 'line' | 'block';
  let state: State = 'code';
  let out = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (state === 'code') {
      if (ch === "'") state = 'string';
      else if (ch === '"') state = 'ident';
      else if (ch === '-' && next === '-') state = 'line';
      else if (ch === '/' && next === '*') state = 'block';
      else if (ch === '[') {
        const token = matchToken(sql, i);
        const value = token ? vault.valueOf(token) : undefined;
        if (token && value !== undefined) {
          out += PLAIN_NUMBER.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
          i += token.length - 1;
          continue;
        }
      }
    } else if (state === 'string') {
      if (ch === "'") {
        if (next === "'") {
          out += "''";
          i += 1;
          continue;
        }
        state = 'code';
      } else if (ch === '[') {
        const token = matchToken(sql, i);
        const value = token ? vault.valueOf(token) : undefined;
        if (token && value !== undefined) {
          out += value.replace(/'/g, "''");
          i += token.length - 1;
          continue;
        }
      }
    } else if (state === 'ident') {
      if (ch === '"') {
        if (next === '"') {
          out += '""';
          i += 1;
          continue;
        }
        state = 'code';
      } else if (ch === '[') {
        const token = matchToken(sql, i);
        const value = token ? vault.valueOf(token) : undefined;
        if (token && value !== undefined) {
          out += value.replace(/"/g, '""');
          i += token.length - 1;
          continue;
        }
      }
    } else if (state === 'line') {
      if (ch === '\n') state = 'code';
    } else if (ch === '*' && next === '/') {
      state = 'code';
      out += '*/';
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function matchToken(text: string, at: number): string | null {
  const re = new RegExp(TOKEN_RE.source, 'y');
  re.lastIndex = at;
  const m = re.exec(text);
  return m ? m[0] : null;
}
