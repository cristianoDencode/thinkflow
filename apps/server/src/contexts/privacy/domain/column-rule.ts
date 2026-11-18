import type { ColumnRuleDto } from '@thinkflow/shared';

/** A persisted decision about what the AI sees of one column (see `ColumnRuleDto`). */
export type ColumnRule = ColumnRuleDto;

/** `*` as schema or table = the rule covers that column name in any schema/table. */
export const WILDCARD = '*';

/** Where a result column really comes from (resolved from the table/column OIDs, never the alias). */
export interface ColumnRef {
  schema: string;
  table: string;
  column: string;
}

/** Rule keys are case-insensitive (e-Cidade identifiers are lowercase; legacy lists were typed by hand). */
export const normalizeIdent = (s: string): string => s.trim().toLowerCase();

export const columnRefKey = (r: ColumnRef): string =>
  `${normalizeIdent(r.schema)}\u0000${normalizeIdent(r.table)}\u0000${normalizeIdent(r.column)}`;
