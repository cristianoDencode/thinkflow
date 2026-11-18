import { MAX_TOKEN_LENGTH, PII_KINDS, TOKEN_RE } from './pii';
import type { Vault } from './vault';

const EXACT_TOKEN = new RegExp(`^${TOKEN_RE.source}$`);
const OPENERS = PII_KINDS.map((k) => `[${k}_`);

/** True when `s` (starting with `[`) could still grow into a token: `[`, `[CP`, `[CPF_`, `[CPF_1`. */
function couldBeTokenPrefix(s: string): boolean {
  if (s.length >= MAX_TOKEN_LENGTH) return false;
  return OPENERS.some((o) =>
    s.length <= o.length ? o.startsWith(s) : s.startsWith(o) && /^\d*$/.test(s.slice(o.length)),
  );
}

/**
 * Restores tokens in text that arrives in arbitrary chunks (SSE deltas). A token split across
 * chunks (`[CP` + `F_1] ok`) is held back until it completes; a `[` that cannot be a token (not
 * followed by KIND_n, or no `]` within 24 chars) is emitted right away, so ordinary text such as
 * `[1, 2]` or Markdown links only ever waits a couple of characters.
 */
export class StreamRestorer {
  private pending = '';

  constructor(
    private readonly vault: Vault,
    private readonly mapValue?: (value: string) => string,
  ) {}

  /** Feeds one chunk; returns the text that is safe to emit now. */
  push(chunk: string): string {
    const input = this.pending + chunk;
    this.pending = '';
    let out = '';
    let pos = 0;
    while (pos < input.length) {
      const open = input.indexOf('[', pos);
      if (open === -1) {
        out += input.slice(pos);
        break;
      }
      out += input.slice(pos, open);
      const close = input.indexOf(']', open);
      if (close !== -1 && close - open + 1 <= MAX_TOKEN_LENGTH) {
        const candidate = input.slice(open, close + 1);
        if (EXACT_TOKEN.test(candidate)) {
          const value = this.vault.valueOf(candidate);
          out += value === undefined ? candidate : this.mapValue ? this.mapValue(value) : value;
          pos = close + 1;
        } else {
          out += '[';
          pos = open + 1;
        }
        continue;
      }
      const tail = input.slice(open);
      if (close === -1 && couldBeTokenPrefix(tail)) {
        this.pending = tail;
        break;
      }
      out += '[';
      pos = open + 1;
    }
    return out;
  }

  /** End of stream: whatever was held back is not a token after all. */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest;
  }
}
