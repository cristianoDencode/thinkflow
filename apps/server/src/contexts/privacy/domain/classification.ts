import type { ColumnRuleAction, PiiKind } from '@thinkflow/shared';
import type { ColumnRef } from './column-rule';

/** `unclassified` = text/json/other column nobody ever decided about: the analyst must review it. */
export type ColumnAction = ColumnRuleAction | 'unclassified';

/** Who decided: an analyst rule, an automatic rule, or the built-in default. */
export type ClassificationOrigin = 'analyst' | 'auto' | 'default';

export interface ColumnClassification {
  action: ColumnAction;
  /** Token kind when `tokenize` (null = generic `VALOR`). */
  kind: PiiKind | null;
  origin: ClassificationOrigin;
  /** The column's real source (null for an expression; the column's own name when the source is unknown). */
  ref: ColumnRef | null;
  /** The values come from an expression, not from a table column. */
  expression: boolean;
}

/** Columns the analyst has to look at before the AI gets any value. */
export function needsReview(c: ColumnClassification): boolean {
  return c.action === 'unclassified' || (c.action === 'tokenize' && c.origin === 'default');
}

/** What an undecided column becomes without a human: tokenized (the safe default). */
export function settle(c: ColumnClassification): ColumnClassification {
  return c.action === 'unclassified' ? { ...c, action: 'tokenize', kind: null } : c;
}
