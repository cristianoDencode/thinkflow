import { GOOD_SUGGESTION, suggest, type Suggestion } from '../domain/identifier-suggest';
import type {
  MetadataLookup,
  MetadataTarget,
  PgCatalogColumn,
  PgCatalogSnapshot,
  PgCatalogTable,
  PgConnectionParams,
  PgGateway,
} from '../domain/ports';
import { extractReferences, type SqlReferences } from '../domain/sql-references';
import {
  buildCatalogView,
  formatValidation,
  qualifiedName,
  resolveTable,
  structureIssue,
  suggestionPhrase,
  tableKey,
  validateReferences,
  type CatalogView,
  type ColumnList,
  type DescribedIssue,
  type IssueNotes,
  type ValidationIssue,
} from '../domain/sql-validation';
import { sanitizeErrorForAi } from './pg-errors';

/** Name checks before a SQL runs: static (catalog) + Postgres' own analysis, with suggestions. */
export interface ValidationContext {
  gateway: PgGateway;
  params: PgConnectionParams;
  /** Schemas the catalog covers (empty = every non-system schema). */
  schemas: string[];
  /** Optional data dictionary consulted when the catalog has no good suggestion. */
  metadata?: { lookup: MetadataLookup; target: MetadataTarget } | null;
  /** Removes personal data from AI-bound text and from what is sent to the dictionary. */
  scrub?: (text: string) => string;
  signal?: AbortSignal;
}

/** The same finding worded for the AI (identifiers only) and for the analyst's result card. */
export interface ValidationFailure {
  aiText: string;
  analystText: string;
  /** The same findings as data (headline + names to try), for the screen. */
  issues: { message: string; suggestions: string[] }[];
}

const MAX_SUGGESTIONS = 3;
const MAX_DICTIONARY_ITEMS = 4;
const MAX_DICTIONARY_CALLS = 3;
const MAX_COLUMN_LISTS = 3;
const DICTIONARY_LIMIT = 6;

interface Loaded {
  snapshot: PgCatalogSnapshot;
  view: CatalogView;
}

/** Catalog + columns of every table the SQL resolves to (cached by the gateway). */
async function load(
  ctx: ValidationContext,
  refs: SqlReferences,
  refresh: boolean,
): Promise<Loaded> {
  const snapshot = await ctx.gateway.catalogSnapshot(ctx.params, {
    schemas: ctx.schemas,
    refresh,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const bare = buildCatalogView(snapshot, new Map());
  const wanted = new Map<string, PgCatalogTable>();
  for (const t of refs.tables) {
    const res = resolveTable(bare, t);
    if (res.status === 'ok') wanted.set(tableKey(res.table.schema, res.table.name), res.table);
  }
  const columns =
    wanted.size > 0
      ? await ctx.gateway.columnsOf(ctx.params, [...wanted.values()], {
          refresh,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
      : new Map<string, PgCatalogColumn[]>();
  return { snapshot, view: buildCatalogView(snapshot, columns) };
}

/** Tables of the query that the catalog knows (with their aliases for wording). */
function queryTables(refs: SqlReferences, view: CatalogView): PgCatalogTable[] {
  const out = new Map<string, PgCatalogTable>();
  for (const t of refs.tables) {
    const res = resolveTable(view, t);
    if (res.status === 'ok') out.set(tableKey(res.table.schema, res.table.name), res.table);
  }
  return [...out.values()];
}

/** Table names to suggest from; the entry of the search path wins when a name repeats. */
function tableNameIndex(view: CatalogView, onlySchema: string | null): Map<string, PgCatalogTable> {
  const rank = (t: PgCatalogTable) => {
    const at = view.searchPath.indexOf(t.schema);
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  const index = new Map<string, PgCatalogTable>();
  for (const t of view.tables) {
    if (onlySchema && t.schema !== onlySchema) continue;
    const prev = index.get(t.name);
    if (!prev || rank(t) < rank(prev)) index.set(t.name, t);
  }
  return index;
}

/** How a table is named in a suggestion: bare when Postgres would find it by itself. */
function shownTable(view: CatalogView, t: PgCatalogTable): string {
  return view.searchPath.includes(t.schema) ? t.name : qualifiedName(t);
}

function cleanSuggestions(list: Suggestion[]): string[] {
  return list.map((s) => s.name);
}

class Dictionary {
  private calls = 0;
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(private readonly ctx: ValidationContext) {}

  get enabled(): boolean {
    return !!this.ctx.metadata;
  }

  /** The term goes out only when it holds no personal data (it is an identifier, never a value). */
  private clean(term: string): string | null {
    if (!this.ctx.scrub) return term;
    return this.ctx.scrub(term) === term ? term : null;
  }

  private once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit) return hit as Promise<T>;
    const next = run();
    this.cache.set(key, next);
    return next;
  }

  async fields(term: string) {
    const meta = this.ctx.metadata;
    const safe = this.clean(term);
    if (!meta || !safe || this.calls >= MAX_DICTIONARY_CALLS) return [];
    this.calls += 1;
    return this.once(`f:${safe}`, () =>
      meta.lookup
        .findFields(meta.target, safe, {
          limit: DICTIONARY_LIMIT,
          ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
        })
        .catch(() => []),
    );
  }

  async tables(term: string) {
    const meta = this.ctx.metadata;
    const safe = this.clean(term);
    if (!meta || !safe || this.calls >= MAX_DICTIONARY_CALLS) return [];
    this.calls += 1;
    return this.once(`t:${safe}`, () =>
      meta.lookup
        .findTables(meta.target, safe, {
          limit: DICTIONARY_LIMIT,
          ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
        })
        .catch(() => []),
    );
  }
}

/** Dictionary tables → `schema.table (description)`, only those that exist in the database. */
async function dictionaryTables(
  dict: Dictionary,
  view: CatalogView,
  term: string,
  onlySchema: string | null,
): Promise<string[]> {
  const out: string[] = [];
  for (const m of await dict.tables(term)) {
    const found = view
      .tablesNamed(m.table)
      .filter((t) => !onlySchema || t.schema === onlySchema)
      .sort((a, b) => view.searchPath.indexOf(a.schema) - view.searchPath.indexOf(b.schema));
    const t = found.find((c) => view.searchPath.includes(c.schema)) ?? found[0];
    if (!t) continue;
    const label = `${shownTable(view, t)}${m.description ? ` (${m.description})` : ''}`;
    if (!out.includes(label)) out.push(label);
    if (out.length >= MAX_DICTIONARY_ITEMS) break;
  }
  return out;
}

/** Dictionary columns → `table.column (label)`, only those that exist in the database. */
async function dictionaryFields(
  ctx: ValidationContext,
  dict: Dictionary,
  view: CatalogView,
  inQuery: PgCatalogTable[],
  term: string,
): Promise<string[]> {
  const matches = await dict.fields(term);
  if (matches.length === 0) return [];
  const candidates = new Map<string, PgCatalogTable>();
  for (const m of matches) {
    const found = view.tablesNamed(m.table);
    const t =
      found.find((c) =>
        inQuery.some((q) => tableKey(q.schema, q.name) === tableKey(c.schema, c.name)),
      ) ??
      found.find((c) => view.searchPath.includes(c.schema)) ??
      found[0];
    if (t) candidates.set(tableKey(t.schema, t.name), t);
  }
  if (candidates.size === 0) return [];
  const loaded = await ctx.gateway
    .columnsOf(ctx.params, [...candidates.values()].slice(0, DICTIONARY_LIMIT), {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    .catch(() => new Map<string, PgCatalogColumn[]>());
  const out: string[] = [];
  for (const m of matches) {
    const found = view.tablesNamed(m.table);
    const t = found.find((c) => candidates.get(tableKey(c.schema, c.name)) === c);
    const columns = t ? loaded.get(tableKey(t.schema, t.name)) : undefined;
    if (!t || !columns?.some((c) => c.name === m.column)) continue;
    const label = `${shownTable(view, t)}.${m.column}${m.label ? ` (${m.label})` : ''}`;
    if (!out.includes(label)) out.push(label);
    if (out.length >= MAX_DICTIONARY_ITEMS) break;
  }
  return out;
}

async function describe(
  ctx: ValidationContext,
  refs: SqlReferences,
  loaded: Loaded,
  issues: ValidationIssue[],
): Promise<DescribedIssue[]> {
  const { view } = loaded;
  const dict = new Dictionary(ctx);
  const inQuery = queryTables(refs, view);
  let names: Map<string, PgCatalogTable> | null = null;
  const out: DescribedIssue[] = [];

  for (const issue of issues) {
    const notes: IssueNotes = { suggestions: [], elsewhere: [], dictionary: [] };
    if (issue.kind === 'table') {
      notes.elsewhere = issue.elsewhere.slice(0, MAX_SUGGESTIONS).map(qualifiedName);
      if (issue.reason === 'table' && notes.elsewhere.length === 0) {
        const onlySchema =
          issue.schema && view.schemas.includes(issue.schema) ? issue.schema : null;
        names = onlySchema
          ? tableNameIndex(view, onlySchema)
          : (names ?? tableNameIndex(view, null));
        const best = suggest(issue.name, names.keys(), MAX_SUGGESTIONS);
        notes.suggestions = best.map((s) => {
          const t = names!.get(s.name);
          return t ? shownTable(view, t) : s.name;
        });
        if ((best[0]?.score ?? 0) < GOOD_SUGGESTION && dict.enabled)
          notes.dictionary = await dictionaryTables(dict, view, issue.name, onlySchema);
      }
    } else {
      const columns = view.columns(issue.table) ?? [];
      const best = suggest(
        issue.column,
        columns.map((c) => c.name),
        MAX_SUGGESTIONS,
      );
      notes.suggestions = cleanSuggestions(best);
      notes.elsewhere = inQuery
        .filter(
          (t) => tableKey(t.schema, t.name) !== tableKey(issue.table.schema, issue.table.name),
        )
        .filter((t) => view.columns(t)?.some((c) => c.name === issue.column))
        .map((t) => `${shownTable(view, t)}.${issue.column}`)
        .slice(0, MAX_SUGGESTIONS);
      if ((best[0]?.score ?? 0) < GOOD_SUGGESTION && notes.elsewhere.length === 0 && dict.enabled)
        notes.dictionary = await dictionaryFields(ctx, dict, view, inQuery, issue.column);
    }
    out.push({ issue, notes });
  }
  return out;
}

function columnLists(view: CatalogView, tables: PgCatalogTable[]): ColumnList[] {
  const out: ColumnList[] = [];
  for (const t of tables) {
    const columns = view.columns(t);
    if (columns && columns.length > 0) out.push({ table: qualifiedName(t), columns });
    if (out.length >= MAX_COLUMN_LISTS) break;
  }
  return out;
}

const rethrowAbort = (ctx: ValidationContext, err: unknown): void => {
  if (ctx.signal?.aborted) throw err instanceof Error ? err : new Error('aborted');
};

/**
 * Checks every table and qualified column of `sql` against the catalog. `null` = nothing wrong
 * (or nothing we can tell: validation is best effort and never blocks a query by itself failing).
 * Cached catalog data may be stale (a table created minutes ago), so a finding is confirmed
 * against a fresh catalog before it is reported.
 */
export async function checkReferences(
  ctx: ValidationContext,
  sql: string,
): Promise<ValidationFailure | null> {
  try {
    const refs = extractReferences(sql);
    if (refs.tables.length === 0) return null;
    let loaded = await load(ctx, refs, false);
    if (validateReferences(refs, loaded.view).length === 0) return null;
    loaded = await load(ctx, refs, true);
    const issues = validateReferences(refs, loaded.view);
    if (issues.length === 0) return null;

    const items = await describe(ctx, refs, loaded, issues);
    const lists = columnLists(
      loaded.view,
      items.flatMap((d) => (d.issue.kind === 'column' ? [d.issue.table] : [])),
    );
    const ai = formatValidation(items, lists, 'ai');
    return {
      aiText: ctx.scrub ? ctx.scrub(ai) : ai,
      analystText: formatValidation(items, lists, 'analyst'),
      issues: items.map(structureIssue),
    };
  } catch (err) {
    rethrowAbort(ctx, err);
    return null;
  }
}

/** The identifier a Postgres name error talks about (English or pt-BR server messages). */
function offender(message: string, code: string): string | null {
  const patterns: Record<string, RegExp[]> = {
    '42703': [
      /column\s+"?([^"\s]+)"?\s+does not exist/i,
      /coluna\s+"?([^"\s]+)"?\s+n[ãa]o existe/i,
    ],
    '42P01': [
      /relation\s+"?([^"\s]+)"?\s+does not exist/i,
      /rela[çc][ãa]o\s+"?([^"\s]+)"?\s+n[ãa]o existe/i,
    ],
    '42702': [
      /column reference\s+"?([^"\s]+)"?\s+is ambiguous/i,
      /refer[êe]ncia a coluna\s+"?([^"\s]+)"?\s+[ée] amb[ií]gua/i,
    ],
  };
  for (const re of patterns[code] ?? []) {
    const m = re.exec(message);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Words a name error Postgres raised during `EXPLAIN` (an unqualified column the static check could
 * not place, a relation it missed…) with the same kind of suggestions. Never throws.
 */
export async function diagnoseDatabaseError(
  ctx: ValidationContext,
  sql: string,
  error: { message: string; code: string },
): Promise<ValidationFailure> {
  const lines: { ai: string[]; analyst: string[] } = { ai: [], analyst: [] };
  const hints: string[] = [];
  let lists: ColumnList[] = [];
  try {
    const refs = extractReferences(sql);
    const loaded = await load(ctx, refs, false);
    const { view } = loaded;
    const inQuery = queryTables(refs, view);
    const wantedRaw = offender(error.message, error.code);
    const wanted = wantedRaw ? (wantedRaw.split('.').pop() ?? wantedRaw) : null;
    const dict = new Dictionary(ctx);

    if (wanted && error.code === '42703') {
      const byColumn = new Map<string, PgCatalogTable[]>();
      for (const t of inQuery)
        for (const c of view.columns(t) ?? []) {
          const list = byColumn.get(c.name);
          if (list) list.push(t);
          else byColumn.set(c.name, [t]);
        }
      const best = suggest(wanted, byColumn.keys(), MAX_SUGGESTIONS);
      const shown = best.map((s) => {
        const owners = byColumn.get(s.name) ?? [];
        return `${s.name} (em ${owners.map((t) => shownTable(view, t)).join(', ')})`;
      });
      if (shown.length > 0) {
        lines.ai.push(suggestionPhrase(shown, 'ai'));
        lines.analyst.push(suggestionPhrase(shown, 'analyst'));
        hints.push(...shown);
      }
      const owner = best[0]
        ? byColumn.get(best[0].name)?.[0]
        : inQuery.length === 1
          ? inQuery[0]
          : undefined;
      lists = columnLists(view, owner ? [owner] : []);
      if ((best[0]?.score ?? 0) < GOOD_SUGGESTION && dict.enabled) {
        const found = await dictionaryFields(ctx, dict, view, inQuery, wanted);
        if (found.length > 0) {
          const line = `No dicionário de dados (MCP): ${found.join('; ')}.`;
          hints.push(...found);
          lines.ai.push(line);
          lines.analyst.push(line);
        }
      }
    } else if (wanted && error.code === '42P01') {
      const names = tableNameIndex(view, null);
      const best = suggest(wanted, names.keys(), MAX_SUGGESTIONS);
      const shown = best.map((s) => {
        const t = names.get(s.name);
        return t ? shownTable(view, t) : s.name;
      });
      if (shown.length > 0) {
        lines.ai.push(suggestionPhrase(shown, 'ai'));
        lines.analyst.push(suggestionPhrase(shown, 'analyst'));
        hints.push(...shown);
      }
      if ((best[0]?.score ?? 0) < GOOD_SUGGESTION && dict.enabled) {
        const found = await dictionaryTables(dict, view, wanted, null);
        if (found.length > 0) {
          const line = `No dicionário de dados (MCP): ${found.join('; ')}.`;
          hints.push(...found);
          lines.ai.push(line);
          lines.analyst.push(line);
        }
      }
    } else if (wanted && error.code === '42702') {
      const owners = inQuery.filter((t) => view.columns(t)?.some((c) => c.name === wanted));
      if (owners.length > 1) {
        const line = `A coluna "${wanted}" existe em ${owners.map((t) => shownTable(view, t)).join(', ')}: qualifique com o alias da tabela (alias.${wanted}).`;
        lines.ai.push(line);
        lines.analyst.push(line);
      }
    }
  } catch (err) {
    rethrowAbort(ctx, err);
  }

  const build = (audience: 'ai' | 'analyst'): string => {
    const message =
      audience === 'ai' ? sanitizeErrorForAi(error.message, error.code) : error.message;
    return formatValidation([], lists, audience, [`- ${message}`, ...lines[audience]]);
  };
  const ai = build('ai');
  return {
    aiText: ctx.scrub ? ctx.scrub(ai) : ai,
    analystText: build('analyst'),
    issues: [{ message: error.message, suggestions: [...new Set(hints)].slice(0, 5) }],
  };
}
