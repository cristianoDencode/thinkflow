import { and, eq } from 'drizzle-orm';
import type { PiiKind } from '@thinkflow/shared';
import type { SecretBox } from '../../../shared/infrastructure/crypto';
import type { Db } from '../../../shared/infrastructure/db/client';
import { piiVault } from '../../../shared/infrastructure/db/schema';
import { systemClock, type Clock } from '../../../shared/kernel/clock';
import type { VaultStore } from '../domain/ports';
import {
  formatToken,
  normalizeForVault,
  parseToken,
  type Vault,
  type VaultEntry,
} from '../domain/vault';

/**
 * Vault of one scope (a conversation, a report...) persisted in SQLite. Values are AES-256-GCM
 * ciphertext; deduplication uses an HMAC of the normalized value (`SecretBox.blindIndex`), so the
 * clear value never touches an index. better-sqlite3 is synchronous, which keeps the `Vault`
 * contract synchronous too.
 */
export class SqliteVault implements Vault {
  /** Decrypted rows of the scope, kept for `entries()`; dropped whenever this instance inserts. */
  private entryCache: VaultEntry[] | null = null;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
    readonly scopeId: string,
    private readonly clock: Clock = systemClock,
  ) {}

  tokenFor(kind: PiiKind, value: string): string {
    const valueHash = this.secrets.blindIndex(
      'pii-vault',
      `${kind}\u0000${normalizeForVault(kind, value)}`,
    );
    return this.db.transaction((tx) => {
      const known = tx
        .select({ token: piiVault.token })
        .from(piiVault)
        .where(and(eq(piiVault.scopeId, this.scopeId), eq(piiVault.valueHash, valueHash)))
        .get();
      if (known) return known.token;
      let max = 0;
      for (const row of tx
        .select({ token: piiVault.token })
        .from(piiVault)
        .where(and(eq(piiVault.scopeId, this.scopeId), eq(piiVault.kind, kind)))
        .all()) {
        max = Math.max(max, parseToken(row.token)?.n ?? 0);
      }
      const token = formatToken(kind, max + 1);
      this.entryCache = null;
      tx.insert(piiVault)
        .values({
          scopeId: this.scopeId,
          token,
          kind,
          valueCipher: this.secrets.encrypt(value),
          valueHash,
          createdAt: this.clock.now(),
        })
        .run();
      return token;
    });
  }

  valueOf(token: string): string | undefined {
    const row = this.db
      .select({ valueCipher: piiVault.valueCipher })
      .from(piiVault)
      .where(and(eq(piiVault.scopeId, this.scopeId), eq(piiVault.token, token)))
      .get();
    if (!row) return undefined;
    try {
      return this.secrets.decrypt(row.valueCipher);
    } catch {
      return undefined; // secret rotated: the token stays opaque
    }
  }

  entries(): Iterable<VaultEntry> {
    if (this.entryCache) return this.entryCache;
    const out: VaultEntry[] = [];
    for (const row of this.db
      .select()
      .from(piiVault)
      .where(eq(piiVault.scopeId, this.scopeId))
      .all()) {
      const parsed = parseToken(row.token);
      if (!parsed) continue;
      try {
        out.push({
          token: row.token,
          kind: parsed.kind,
          value: this.secrets.decrypt(row.valueCipher),
        });
      } catch {
        // secret rotated: the token stays opaque
      }
    }
    this.entryCache = out;
    return out;
  }

  /** Forgets every token of this vault's scope. */
  deleteScope(): void {
    this.db.delete(piiVault).where(eq(piiVault.scopeId, this.scopeId)).run();
  }
}

/** Hands out the vault of each scope and deletes a scope together with its owner. */
export class SqliteVaultStore implements VaultStore {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
    private readonly clock: Clock = systemClock,
  ) {}

  forScope(scopeId: string): SqliteVault {
    return new SqliteVault(this.db, this.secrets, scopeId, this.clock);
  }

  deleteScope(scopeId: string): void {
    this.db.delete(piiVault).where(eq(piiVault.scopeId, scopeId)).run();
  }

  copyScope(fromScopeId: string, toScopeId: string): void {
    if (fromScopeId === toScopeId) return;
    this.db.transaction((tx) => {
      const rows = tx.select().from(piiVault).where(eq(piiVault.scopeId, fromScopeId)).all();
      if (rows.length === 0) return;
      for (let i = 0; i < rows.length; i += 500) {
        tx.insert(piiVault)
          .values(rows.slice(i, i + 500).map((r) => ({ ...r, scopeId: toScopeId })))
          .onConflictDoNothing()
          .run();
      }
    });
  }
}
