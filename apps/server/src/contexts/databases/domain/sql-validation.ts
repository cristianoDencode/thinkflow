import type { PgCatalogColumn, PgCatalogSnapshot, PgCatalogTable } from './ports';
import type { ColumnRef, SqlReferences, TableRef } from './sql-references';

/**
 * Checks the tables/columns a SQL names against a catalog snapshot and words the findings in
 * pt-BR. Messages carry IDENTIFIERS only (table/column names, types): never a value from the
 * SQL's literals or from the data.
 */

export const tableKey = (schema: string, name: string): string => `${schema}.${name}`;

/** System schemas are never validated (pg_catalog is searched implicitly, information_schema…). */
const isSystemSchema = (schema: string): boolean =>
  schema === 'information_schema' || schema.startsWith('pg_');

/** Always present in any table, never listed in the catalog columns. */
const SYSTEM_COLUMNS = new Set(['ctid', 'oid', 'xmin', 'xmax', 'cmin', 'cmax', 'tableoid']);

export interface CatalogView {
  searchPath: string[];
  /** Schemas that own at least one table of the snapshot. */
  schemas: string[];
  table(schema: string, name: string): PgCatalogTable | undefined;
  /** Every table named `name`, in any schema. */
  tablesNamed(name: string): PgCatalogTable[];
  /** All tables (for similarity search). */
  tables: PgCatalogTable[];
  /** Columns loaded for the table; undefined = not loaded (the check is skipped). */
  columns(table: PgCatalogTable): PgCatalogColumn[] | undefined;
}

export function buildCatalogView(
  snapshot: PgCatalogSnapshot,
  columns: Map<string, PgCatalogColumn[]>,
): CatalogView {
  const byKey = new Map<string, PgCatalogTable>();
  const byName = new Map<string, PgCatalogTable[]>();
  const schemas = new Set<string>();
  for (const t of snapshot.tables) {
    byKey.set(tableKey(t.schema, t.name), t);
    schemas.add(t.schema);
    const list = byName.get(t.name);
    if (list) list.push(t);
    else byName.set(t.name, [t]);
  }
  return {
    searchPath: snapshot.searchPath,
    schemas: [...schemas].sort(),
    tables: snapshot.tables,
    table: (schema, name) => byKey.get(tableKey(schema, name)),
    tablesNamed: (name) => byName.get(name) ?? [],
    columns: (t) => columns.get(tableKey(t.schema, t.name)),
  };
}

export type TableResolution =
  | { status: 'ok'; table: PgCatalogTable }
  | { status: 'skip' }
  | { status: 'missing'; reason: 'table' | 'schema'; elsewhere: PgCatalogTable[] };

/** Finds the catalog table a reference points to, the way Postgres resolves names. */
export function resolveTable(view: CatalogView, ref: TableRef): TableResolution {
  if (ref.cte) return { status: 'skip' };
  if (ref.schema !== null) {
    if (isSystemSchema(ref.schema)) return { status: 'skip' };
    if (!view.schemas.includes(ref.schema))
      return { status: 'missing', reason: 'schema', elsewhere: view.tablesNamed(ref.name) };
    const hit = view.table(ref.schema, ref.name);
    if (hit) return { status: 'ok', table: hit };
    return { status: 'missing', reason: 'table', elsewhere: view.tablesNamed(ref.name) };
  }
  for (const schema of view.searchPath) {
    if (isSystemSchema(schema)) continue;
    const hit = view.table(schema, ref.name);
    if (hit) return { status: 'ok', table: hit };
  }
  // pg_tables, pg_class… live in the implicit pg_catalog
  if (ref.name.startsWith('pg_')) return { status: 'skip' };
  return { status: 'missing', reason: 'table', elsewhere: view.tablesNamed(ref.name) };
}

export type ValidationIssue =
  | {
      kind: 'table';
      /** Schema as written, null when unqualified. */
      schema: string | null;
      name: string;
      reason: 'table' | 'schema';
      /** Same table name in other schemas of the database. */
      elsewhere: PgCatalogTable[];
      /** Schemas that do exist (for `reason: 'schema'`). */
      schemas: string[];
    }
  | {
      kind: 'column';
      table: PgCatalogTable;
      column: string;
      /** The reference as written (`c.z01_nomee`). */
      written: string;
    };

/** Scope chain of a query block: itself, its parent… (correlated subqueries see outer aliases). */
function scopeChain(refs: SqlReferences, scope: number): number[] {
  const chain: number[] = [];
  let current: number | null = scope;
  while (current !== null && chain.length <= refs.scopes.length) {
    chain.push(current);
    current = refs.scopes.find((s) => s.id === current)?.parent ?? null;
  }
  return chain;
}

function findInScope(
  refs: SqlReferences,
  scope: number,
  match: (t: TableRef) => boolean,
): TableRef | undefined {
  for (const id of scopeChain(refs, scope)) {
    const hit = refs.tables.find((t) => t.scope === id && match(t));
    if (hit) return hit;
  }
  return undefined;
}

/** The table a column reference points to: `[alias, col]` or `[schema, table, col]`. */
export function tableOfColumn(
  refs: SqlReferences,
  ref: ColumnRef,
): { table: TableRef; column: string } | undefined {
  const p = ref.parts;
  if (p.length >= 3) {
    const [schema, name, column] = p as [string, string, string];
    const hit = findInScope(
      refs,
      ref.scope,
      (t) => t.alias === null && t.name === name && t.schema === schema,
    );
    if (hit) return { table: hit, column };
  }
  const [qualifier, column] = p as [string, string];
  const hit = findInScope(refs, ref.scope, (t) =>
    t.alias !== null ? t.alias === qualifier : t.name === qualifier,
  );
  return hit ? { table: hit, column } : undefined;
}

/** Tables that must have their columns loaded to check the qualified column references. */
export function tablesNeedingColumns(refs: SqlReferences, view: CatalogView): PgCatalogTable[] {
  const out = new Map<string, PgCatalogTable>();
  for (const c of refs.columns) {
    const hit = tableOfColumn(refs, c);
    if (!hit) continue;
    const resolved = resolveTable(view, hit.table);
    if (resolved.status === 'ok')
      out.set(tableKey(resolved.table.schema, resolved.table.name), resolved.table);
  }
  return [...out.values()];
}

export function validateReferences(refs: SqlReferences, view: CatalogView): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const push = (key: string, issue: ValidationIssue) => {
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  for (const t of refs.tables) {
    const res = resolveTable(view, t);
    if (res.status !== 'missing') continue;
    push(`t:${t.schema ?? ''}.${t.name}`, {
      kind: 'table',
      schema: t.schema,
      name: t.name,
      reason: res.reason,
      elsewhere: res.elsewhere,
      schemas: view.schemas,
    });
  }

  for (const c of refs.columns) {
    const target = tableOfColumn(refs, c);
    if (!target) continue;
    const res = resolveTable(view, target.table);
    if (res.status !== 'ok') continue;
    const columns = view.columns(res.table);
    if (!columns) continue;
    const wanted = target.column;
    if (SYSTEM_COLUMNS.has(wanted) || columns.some((col) => col.name === wanted)) continue;
    push(`c:${tableKey(res.table.schema, res.table.name)}.${wanted}`, {
      kind: 'column',
      table: res.table,
      column: wanted,
      written: c.parts.join('.'),
    });
  }
  return issues;
}

/* ----------------------------- wording ----------------------------- */

export interface IssueNotes {
  /** Similar names from the catalog, best first. */
  suggestions: string[];
  /** Same name found in another table of the query / another schema. */
  elsewhere: string[];
  /** Matches from the data dictionary, already filtered to what exists in the database. */
  dictionary: string[];
}

export interface DescribedIssue {
  issue: ValidationIssue;
  notes: IssueNotes;
}

export interface ColumnList {
  table: string;
  columns: PgCatalogColumn[];
}

export const MAX_LISTED_COLUMNS = 40;

export const qualifiedName = (t: { schema: string; name: string }): string =>
  `${t.schema}.${t.name}`;

const joinNames = (names: string[]): string => names.join(', ');

/** "Parecidas: a, b." for the AI; "Você quis dizer: a, b?" for the analyst. */
export function suggestionPhrase(names: string[], audience: 'ai' | 'analyst'): string {
  return audience === 'analyst'
    ? `Você quis dizer: ${joinNames(names)}?`
    : `Parecidas: ${joinNames(names)}.`;
}

/** "tabela "x" não existe." — the finding alone, without suggestions. */
function issueHeadline(issue: ValidationIssue): string {
  if (issue.kind === 'table') {
    if (issue.reason === 'schema')
      return `schema "${issue.schema}" não existe ou não está liberado (tabela "${issue.name}"). Schemas disponíveis: ${joinNames(issue.schemas.slice(0, 12))}.`;
    const shown = issue.schema ? `${issue.schema}.${issue.name}` : issue.name;
    return `tabela "${shown}" não existe.`;
  }
  const how = issue.written !== issue.column ? ` (usada como ${issue.written})` : '';
  return `coluna "${issue.column}" não existe em ${qualifiedName(issue.table)}${how}.`;
}

function describeIssue(d: DescribedIssue, audience: 'ai' | 'analyst'): string {
  const { issue, notes } = d;
  const parts: string[] = [`- ${issueHeadline(issue)}`];
  if (notes.elsewhere.length > 0)
    parts.push(
      issue.kind === 'table'
        ? `Existe em outro schema: ${joinNames(notes.elsewhere)}.`
        : `Existe em outra tabela da consulta: ${joinNames(notes.elsewhere)}.`,
    );
  if (notes.suggestions.length > 0) parts.push(suggestionPhrase(notes.suggestions, audience));
  if (notes.dictionary.length > 0)
    parts.push(`No dicionário de dados (MCP): ${notes.dictionary.join('; ')}.`);
  return parts.join(' ');
}

const MAX_ISSUE_SUGGESTIONS = 5;

/** A finding as data for the screen: the headline plus every name worth trying instead. */
export function structureIssue(d: DescribedIssue): { message: string; suggestions: string[] } {
  const names = [...d.notes.suggestions, ...d.notes.elsewhere, ...d.notes.dictionary];
  return {
    message: issueHeadline(d.issue),
    suggestions: [...new Set(names)].slice(0, MAX_ISSUE_SUGGESTIONS),
  };
}

export function formatColumnList(list: ColumnList): string {
  const shown = list.columns.slice(0, MAX_LISTED_COLUMNS);
  const rest = list.columns.length - shown.length;
  return `Colunas de ${list.table}: ${shown.map((c) => `${c.name} ${c.type}`).join(', ')}${rest > 0 ? ` (e mais ${rest})` : ''}`;
}

export const AI_VALIDATION_HEADER =
  'Validação da consulta (nada foi executado; esta tentativa não conta no limite de consultas):';
export const ANALYST_VALIDATION_HEADER =
  'A consulta não foi executada: há nomes que não existem no banco.';
export const AI_VALIDATION_FOOTER =
  'Corrija e chame executar_consulta de novo; não repita o mesmo nome.';

/** The message for the AI (`ai`) or for the analyst's result card (`analyst`, "Você quis dizer…?"). */
export function formatValidation(
  items: DescribedIssue[],
  columnLists: ColumnList[],
  audience: 'ai' | 'analyst',
  extraLines: string[] = [],
): string {
  const lines = [
    audience === 'ai' ? AI_VALIDATION_HEADER : ANALYST_VALIDATION_HEADER,
    ...items.map((d) => describeIssue(d, audience)),
    ...extraLines,
    ...columnLists.map(formatColumnList),
  ];
  if (audience === 'ai') lines.push(AI_VALIDATION_FOOTER);
  return lines.join('\n');
}
