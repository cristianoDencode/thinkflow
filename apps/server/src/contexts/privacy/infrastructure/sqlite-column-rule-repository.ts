import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ColumnRuleAction, ColumnRuleOrigin, PiiKind } from '@thinkflow/shared';
import type { Db } from '../../../shared/infrastructure/db/client';
import { aiColumnRules } from '../../../shared/infrastructure/db/schema';
import type { Clock } from '../../../shared/kernel/clock';
import type { IdGenerator } from '../../../shared/kernel/ids';
import {
  WILDCARD,
  columnRefKey,
  normalizeIdent,
  type ColumnRef,
  type ColumnRule,
} from '../domain/column-rule';
import type { ColumnRuleRepository, UpsertColumnRule } from '../domain/ports';

type Row = typeof aiColumnRules.$inferSelect;

function toRule(r: Row): ColumnRule {
  return {
    id: r.id,
    connectionId: r.connectionId,
    schema: r.schemaName,
    table: r.tableName,
    column: r.columnName,
    action: r.action as ColumnRuleAction,
    kind: r.kind as PiiKind | null,
    origin: r.origin as ColumnRuleOrigin,
    updatedAt: r.updatedAt,
  };
}

export class SqliteColumnRuleRepository implements ColumnRuleRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async list(connectionId: string): Promise<ColumnRule[]> {
    return this.db
      .select()
      .from(aiColumnRules)
      .where(eq(aiColumnRules.connectionId, connectionId))
      .orderBy(
        asc(aiColumnRules.schemaName),
        asc(aiColumnRules.tableName),
        asc(aiColumnRules.columnName),
      )
      .all()
      .map(toRule);
  }

  async upsert(input: UpsertColumnRule): Promise<ColumnRule> {
    const key = {
      connectionId: input.connectionId,
      schemaName: normalizeIdent(input.schema) || WILDCARD,
      tableName: normalizeIdent(input.table) || WILDCARD,
      columnName: normalizeIdent(input.column),
    };
    const values = {
      action: input.action,
      kind: input.action === 'tokenize' ? input.kind : null,
      origin: input.origin,
      updatedAt: this.clock.now(),
    };
    this.db
      .insert(aiColumnRules)
      .values({ id: this.ids.next(), ...key, ...values })
      .onConflictDoUpdate({
        target: [
          aiColumnRules.connectionId,
          aiColumnRules.schemaName,
          aiColumnRules.tableName,
          aiColumnRules.columnName,
        ],
        set: values,
      })
      .run();
    const row = this.db
      .select()
      .from(aiColumnRules)
      .where(
        and(
          eq(aiColumnRules.connectionId, key.connectionId),
          eq(aiColumnRules.schemaName, key.schemaName),
          eq(aiColumnRules.tableName, key.tableName),
          eq(aiColumnRules.columnName, key.columnName),
        ),
      )
      .get();
    if (!row) throw new Error('Regra de coluna não encontrada após salvar');
    return toRule(row);
  }

  async delete(connectionId: string, ruleId: string): Promise<void> {
    this.db
      .delete(aiColumnRules)
      .where(and(eq(aiColumnRules.connectionId, connectionId), eq(aiColumnRules.id, ruleId)))
      .run();
  }

  async findFor(
    connectionId: string,
    refs: readonly ColumnRef[],
  ): Promise<Map<string, ColumnRule>> {
    const found = new Map<string, ColumnRule>();
    if (refs.length === 0) return found;
    const columns = [...new Set(refs.map((r) => normalizeIdent(r.column)))];
    // SQLite caps bound variables; column names are few, but chunk to stay safe
    const rules: ColumnRule[] = [];
    for (let i = 0; i < columns.length; i += 500) {
      rules.push(
        ...this.db
          .select()
          .from(aiColumnRules)
          .where(
            and(
              eq(aiColumnRules.connectionId, connectionId),
              inArray(aiColumnRules.columnName, columns.slice(i, i + 500)),
            ),
          )
          .all()
          .map(toRule),
      );
    }
    const bySpecificity = (rule: ColumnRule, ref: ColumnRef): number => {
      const schemaOk = rule.schema === WILDCARD || rule.schema === normalizeIdent(ref.schema);
      const tableOk = rule.table === WILDCARD || rule.table === normalizeIdent(ref.table);
      if (!schemaOk || !tableOk || rule.column !== normalizeIdent(ref.column)) return -1;
      // exact (4) > (schema, *) (3) > (*, table) (2) > (*, *) (1)
      return 1 + (rule.schema === WILDCARD ? 0 : 2) + (rule.table === WILDCARD ? 0 : 1);
    };
    for (const ref of refs) {
      let best: ColumnRule | undefined;
      let bestScore = 0;
      for (const rule of rules) {
        const score = bySpecificity(rule, ref);
        if (score > bestScore) {
          best = rule;
          bestScore = score;
        }
      }
      if (best) found.set(columnRefKey(ref), best);
    }
    return found;
  }
}
