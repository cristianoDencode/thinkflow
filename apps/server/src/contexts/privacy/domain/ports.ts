import type { ColumnRuleAction, ColumnRuleOrigin, PiiKind } from '@thinkflow/shared';
import type { ColumnRef, ColumnRule } from './column-rule';
import type { Vault } from './vault';

export interface UpsertColumnRule extends ColumnRef {
  connectionId: string;
  action: ColumnRuleAction;
  kind: PiiKind | null;
  origin: ColumnRuleOrigin;
}

/** Persistence of the per-column AI rules of a database connection. */
export interface ColumnRuleRepository {
  list(connectionId: string): Promise<ColumnRule[]>;
  /** Inserts or replaces the rule for (connection, schema, table, column). */
  upsert(input: UpsertColumnRule): Promise<ColumnRule>;
  delete(connectionId: string, ruleId: string): Promise<void>;
  /**
   * Best rule for each reference, keyed by `columnRefKey(ref)`; references without a rule are
   * absent. Precedence: exact > (schema, *) > (*, table) > (*, *) — the last is the legacy
   * per-column-name list.
   */
  findFor(connectionId: string, refs: readonly ColumnRef[]): Promise<Map<string, ColumnRule>>;
}

/** Vault scopes: one vault per conversation/report/request, deleted together with its owner. */
export interface VaultStore {
  forScope(scopeId: string): Vault;
  /** Forgets every token of the scope (call it when the conversation/report is deleted). */
  deleteScope(scopeId: string): void;
  /** Copies every token of `fromScopeId` into `toScopeId` (same numbers), e.g. for a forked conversation. */
  copyScope(fromScopeId: string, toScopeId: string): void;
}
