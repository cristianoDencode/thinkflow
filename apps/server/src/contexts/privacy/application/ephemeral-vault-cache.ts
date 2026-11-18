import { createHash } from 'node:crypto';
import { InMemoryVault, type Vault } from '../domain/vault';

export interface EphemeralVaultCacheOptions {
  /** A scope is forgotten this long after its last use (default 2 h). */
  ttlMs?: number;
  /** Most scopes kept at once; the least recently used one goes first (default 200). */
  maxScopes?: number;
  now?: () => number;
}

/**
 * In-memory vaults for callers that have no persistent scope (external /v1 clients such as
 * Claude Code): the same client keeps its tokens between requests, so `[CPF_1]` stays `[CPF_1]`
 * through a long session, and everything is forgotten after the TTL or a restart. Scope keys are
 * hashed so API keys are never kept in memory as map keys.
 */
export class EphemeralVaultCache {
  private readonly entries = new Map<string, { vault: Vault; lastUsed: number }>();
  private readonly ttlMs: number;
  private readonly maxScopes: number;
  private readonly now: () => number;

  constructor(options: EphemeralVaultCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 2 * 60 * 60 * 1000;
    this.maxScopes = options.maxScopes ?? 200;
    this.now = options.now ?? Date.now;
  }

  get(key: string): Vault {
    const now = this.now();
    this.evict(now);
    const id = createHash('sha256').update(key).digest('hex');
    const known = this.entries.get(id);
    const vault = known?.vault ?? new InMemoryVault();
    // re-insert: Map iteration order doubles as the LRU order
    this.entries.delete(id);
    this.entries.set(id, { vault, lastUsed: now });
    while (this.entries.size > this.maxScopes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return vault;
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.lastUsed <= this.ttlMs) break; // ordered by last use
      this.entries.delete(id);
    }
  }
}
