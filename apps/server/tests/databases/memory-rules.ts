import type { ColumnRuleDto } from '@thinkflow/shared';
import {
  columnRefKey,
  normalizeIdent,
  WILDCARD,
  type ColumnRef,
  type ColumnRule,
} from '../../src/contexts/privacy/domain/column-rule';
import type {
  ColumnRuleRepository,
  UpsertColumnRule,
} from '../../src/contexts/privacy/domain/ports';

/** In-memory `ColumnRuleRepository` for unit tests (same precedence as the SQLite one). */
export class MemoryColumnRuleRepository implements ColumnRuleRepository {
  rules: ColumnRuleDto[] = [];
  private n = 0;

  async list(connectionId: string): Promise<ColumnRule[]> {
    return this.rules.filter((r) => r.connectionId === connectionId);
  }

  async upsert(input: UpsertColumnRule): Promise<ColumnRule> {
    const schema = normalizeIdent(input.schema) || WILDCARD;
    const table = normalizeIdent(input.table) || WILDCARD;
    const column = normalizeIdent(input.column);
    const existing = this.rules.find(
      (r) =>
        r.connectionId === input.connectionId &&
        r.schema === schema &&
        r.table === table &&
        r.column === column,
    );
    const rule: ColumnRuleDto = {
      id: existing?.id ?? `rule-${++this.n}`,
      connectionId: input.connectionId,
      schema,
      table,
      column,
      action: input.action,
      kind: input.action === 'tokenize' ? input.kind : null,
      origin: input.origin,
      updatedAt: 1,
    };
    this.rules = [...this.rules.filter((r) => r !== existing), rule];
    return rule;
  }

  async delete(connectionId: string, ruleId: string): Promise<void> {
    this.rules = this.rules.filter((r) => !(r.connectionId === connectionId && r.id === ruleId));
  }

  async findFor(
    connectionId: string,
    refs: readonly ColumnRef[],
  ): Promise<Map<string, ColumnRule>> {
    const out = new Map<string, ColumnRule>();
    for (const ref of refs) {
      let best: ColumnRule | undefined;
      let bestScore = 0;
      for (const rule of this.rules) {
        if (rule.connectionId !== connectionId) continue;
        const schemaOk = rule.schema === WILDCARD || rule.schema === normalizeIdent(ref.schema);
        const tableOk = rule.table === WILDCARD || rule.table === normalizeIdent(ref.table);
        if (!schemaOk || !tableOk || rule.column !== normalizeIdent(ref.column)) continue;
        const score = 1 + (rule.schema === WILDCARD ? 0 : 2) + (rule.table === WILDCARD ? 0 : 1);
        if (score > bestScore) {
          best = rule;
          bestScore = score;
        }
      }
      if (best) out.set(columnRefKey(ref), best);
    }
    return out;
  }
}
