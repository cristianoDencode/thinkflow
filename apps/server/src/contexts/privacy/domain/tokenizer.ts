import { detectAll, resolveSpans } from './detect';
import { TOKEN_RE, isToken, type PiiKind, type Span } from './pii';
import type { Vault } from './vault';

/**
 * Replaces personal data in `text` by reversible tokens. Without `spans` it runs `detectAll`.
 * Given spans are re-validated (overlaps resolved, existing tokens skipped), so a text is never
 * tokenized twice.
 */
export function tokenize(text: string, vault: Vault, spans?: readonly Span[]): string {
  const chosen = spans ? resolveSpans(spans, text) : detectAll(text);
  if (chosen.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const s of chosen) {
    out += text.slice(pos, s.start) + vault.tokenFor(s.kind, text.slice(s.start, s.end));
    pos = s.end;
  }
  return out + text.slice(pos);
}

/**
 * Tokenizes a whole cell/value of a known kind (column rules). Empty values and values that
 * already are a token are returned untouched.
 */
export function tokenizeValue(value: string, kind: PiiKind, vault: Vault): string {
  const v = value.trim();
  if (v === '' || isToken(v)) return value;
  return vault.tokenFor(kind, v);
}

/**
 * Turns tokens back into real values; tokens unknown to the vault are left as they are.
 * `mapValue` post-processes each restored value (e.g. JSON-escape it when restoring inside JSON).
 */
export function restore(text: string, vault: Vault, mapValue?: (value: string) => string): string {
  if (!text.includes('[')) return text;
  return text.replace(TOKEN_RE, (token) => {
    const value = vault.valueOf(token);
    if (value === undefined) return token;
    return mapValue ? mapValue(value) : value;
  });
}

export { TOKEN_RE };
