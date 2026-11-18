import pg from 'pg';
import Cursor from 'pg-cursor';
import type { ColumnSourceDto, QueryColumnDto } from '@thinkflow/shared';
import type {
  PgCatalogColumn,
  PgCatalogSnapshot,
  PgColumnInfo,
  PgColumnSummary,
  PgConnectionParams,
  PgGateway,
  PgQueryResult,
  PgServerInfo,
  PgTableDetail,
  PgTableInfo,
} from '../domain/ports';

export interface PgPoolGatewayOptions {
  poolMax?: number;
  idleMs?: number;
  connectTimeoutMs?: number;
  /** How long a catalog snapshot (table names / columns of a table) is reused. Default 10 min. */
  catalogTtlMs?: number;
}

const { Pool, Client } = pg;

/** Estimated rows above which `count(distinct)` is skipped (too expensive). */
const DISTINCT_ROW_LIMIT = 5_000_000;
const CELL_BYTES_PREVIEW = 32;

const TYPE_NAMES: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  18: 'char',
  19: 'name',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  26: 'oid',
  114: 'json',
  142: 'xml',
  700: 'float4',
  701: 'float8',
  790: 'money',
  1000: '_bool',
  1005: '_int2',
  1007: '_int4',
  1009: '_text',
  1014: '_bpchar',
  1015: '_varchar',
  1016: '_int8',
  1021: '_float4',
  1022: '_float8',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1115: '_timestamp',
  1182: '_date',
  1184: 'timestamptz',
  1185: '_timestamptz',
  1186: 'interval',
  1231: '_numeric',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  2951: '_uuid',
  3802: 'jsonb',
  3807: '_jsonb',
};

/** Date/time types stay as the text Postgres sends (no timezone shifting through `Date`). */
const RAW_TEXT_OIDS = new Set([1082, 1083, 1114, 1184, 1266]);

const CURSOR_TYPES = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') =>
    RAW_TEXT_OIDS.has(oid)
      ? (value: string) => value
      : pg.types.getTypeParser(oid, format as 'text'),
} as unknown as pg.CustomTypesConfig;

interface QueryField {
  name: string;
  dataTypeID: number;
  /** OID of the source table (0 = not a plain table column). */
  tableID: number;
  /** Attribute number in the source table. */
  columnID: number;
}

interface PoolEntry {
  pool: pg.Pool;
  version: number;
}

type ErrorWithCode = Error & { code?: string; position?: string; phase?: 'validation' };

/** SQLSTATEs of `EXPLAIN` that mean "a name in the SQL does not exist / is ambiguous". */
const VALIDATION_CODES = new Set(['42703', '42P01', '42702', '42883']);
const EXPLAIN_PREFIX = 'EXPLAIN ';
const STARTS_WITH_EXPLAIN = /^\s*(?:\(\s*)*explain\b/i;
const CATALOG_TTL_MS = 10 * 60_000;
const MAX_TABLES_PER_COLUMNS_QUERY = 60;

interface CatalogEntry {
  version: number;
  schemasKey: string;
  at: number;
  snapshot: PgCatalogSnapshot;
}

/** Keeps the Postgres message (+ position/hint) and the error code on a plain `Error`. */
function toError(err: unknown): ErrorWithCode {
  if (err instanceof Error && (err as ErrorWithCode).name === 'AbortError') return err;
  const e = (err ?? {}) as {
    message?: string;
    code?: string;
    position?: string;
    hint?: string;
    phase?: 'validation';
    errors?: { code?: string; message?: string }[];
  };
  const inner = e.errors?.[0];
  const code = e.code ?? inner?.code;
  let message = e.message || inner?.message || code || 'erro desconhecido';
  if (e.position) message += ` (posição ${e.position})`;
  if (e.hint) message += ` Dica: ${e.hint}`;
  const out: ErrorWithCode = new Error(message);
  if (code) out.code = code;
  if (e.position) out.position = e.position;
  if (e.phase) out.phase = e.phase;
  return out;
}

function abortError(): Error {
  const e = new Error('Consulta cancelada.');
  e.name = 'AbortError';
  return e;
}

const quoteIdent = (id: string): string => `"${id.replace(/"/g, '""')}"`;

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function sslFor(mode: PgConnectionParams['sslMode']): pg.ClientConfig['ssl'] {
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'bigint':
      return value.toString();
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'string':
    case 'boolean':
      return value;
    case 'object': {
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
      if (Buffer.isBuffer(value)) {
        const head = value.subarray(0, CELL_BYTES_PREVIEW).toString('hex');
        return `\\x${head}${value.length > CELL_BYTES_PREVIEW ? `… (${value.length} bytes)` : ''}`;
      }
      if (Array.isArray(value)) return value.map(jsonSafe);
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
    }
    default:
      return String(value);
  }
}

const RELKIND: Record<string, PgTableInfo['kind']> = {
  r: 'table',
  v: 'view',
  m: 'materialized view',
  f: 'foreign table',
  p: 'partitioned table',
};

interface TableRef {
  oid: number;
  schema: string;
  name: string;
  kind: PgTableInfo['kind'];
  comment: string | null;
  estimatedRows: number | null;
}

/** Postgres adapter: one lazily created pool per connection; every operation is READ ONLY. */
export class PgPoolGateway implements PgGateway {
  private readonly pools = new Map<string, PoolEntry>();
  private readonly extraTypeNames = new Map<string, string>();
  private readonly sourceCache = new Map<string, ColumnSourceDto>();
  private readonly catalogs = new Map<string, CatalogEntry>();
  /** `${connectionId}\0${schema}.${table}` → columns. */
  private readonly columnCache = new Map<string, { at: number; columns: PgCatalogColumn[] }>();

  constructor(private readonly options: PgPoolGatewayOptions = {}) {}

  /* ------------------------------ pools ------------------------------ */

  private config(conn: PgConnectionParams): pg.PoolConfig {
    return {
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.user,
      password: conn.password,
      ssl: sslFor(conn.sslMode),
      application_name: 'thinkflow-dados',
      connectionTimeoutMillis: this.options.connectTimeoutMs ?? 10_000,
    };
  }

  private poolFor(conn: PgConnectionParams): pg.Pool {
    const cached = this.pools.get(conn.id);
    if (cached && cached.version === conn.version) return cached.pool;
    if (cached) void cached.pool.end().catch(() => undefined);
    const pool = new Pool({
      ...this.config(conn),
      max: this.options.poolMax ?? 4,
      idleTimeoutMillis: this.options.idleMs ?? 60_000,
      allowExitOnIdle: true,
    });
    // idle clients may break (server restart): never crash the process for that
    pool.on('error', () => undefined);
    this.pools.set(conn.id, { pool, version: conn.version });
    return pool;
  }

  async invalidate(connectionId: string): Promise<void> {
    const entry = this.pools.get(connectionId);
    this.pools.delete(connectionId);
    for (const key of [...this.sourceCache.keys()])
      if (key.startsWith(`${connectionId}:`)) this.sourceCache.delete(key);
    this.catalogs.delete(connectionId);
    for (const key of [...this.columnCache.keys()])
      if (key.startsWith(`${connectionId}\0`)) this.columnCache.delete(key);
    if (entry) await entry.pool.end().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(entries.map((e) => e.pool.end().catch(() => undefined)));
  }

  /** Cancels a running statement from a separate short-lived connection. */
  private async cancelBackend(conn: PgConnectionParams, pid: number): Promise<void> {
    const client = new Client({ ...this.config(conn), connectionTimeoutMillis: 5_000 });
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.query('select pg_cancel_backend($1)', [pid]);
    } catch {
      // best effort: the statement timeout still applies
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /**
   * Runs `work` inside `BEGIN TRANSACTION READ ONLY` with statement/idle timeouts and always rolls
   * back. A client whose rollback fails is destroyed instead of returned to the pool.
   */
  private async readOnly<T>(
    conn: PgConnectionParams,
    signal: AbortSignal | undefined,
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw abortError();
    let client: pg.PoolClient;
    try {
      client = await this.poolFor(conn).connect();
    } catch (err) {
      throw toError(err);
    }
    let destroy = false;
    let onAbort: (() => void) | undefined;
    try {
      const timeoutMs = Math.max(Math.trunc(conn.statementTimeoutSec), 1) * 1000;
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${timeoutMs + 30_000}`);
      if (signal) {
        const res = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const pid = res.rows[0]?.pid;
        if (pid !== undefined) {
          onAbort = () => void this.cancelBackend(conn, pid);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }
      }
      return await work(client);
    } catch (err) {
      if (signal?.aborted) throw abortError();
      throw toError(err);
    } finally {
      // stop listening BEFORE the rollback: a late cancel could hit the pid's next user
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      try {
        await client.query('ROLLBACK');
      } catch {
        destroy = true;
      }
      client.release(destroy);
    }
  }

  /* ------------------------------ test ------------------------------ */

  async test(conn: PgConnectionParams): Promise<PgServerInfo> {
    return this.readOnly(conn, undefined, async (client) => {
      const res = await client.query<{
        version: string;
        current_user: string;
        rolsuper: boolean | null;
        can_write: boolean;
      }>(
        `select version() as version, current_user as current_user,
                (select rolsuper from pg_roles where rolname = current_user) as rolsuper,
                exists(select 1 from information_schema.table_privileges
                        where grantee = current_user
                          and privilege_type in ('INSERT','UPDATE','DELETE')) as can_write`,
      );
      const row = res.rows[0];
      return {
        serverVersion: row?.version ?? '',
        currentUser: row?.current_user ?? conn.user,
        canWrite: Boolean(row?.rolsuper) || Boolean(row?.can_write),
      };
    });
  }

  /* ------------------------------ query ------------------------------ */

  async query(
    conn: PgConnectionParams,
    sql: string,
    opts: { maxRows: number; signal?: AbortSignal; explainFirst?: boolean },
  ): Promise<PgQueryResult> {
    return this.readOnly(conn, opts.signal, async (client) => {
      const started = Date.now();
      if (opts.explainFirst && !STARTS_WITH_EXPLAIN.test(sql)) await this.explain(client, sql);
      const cursor = client.query(new Cursor(sql, [], { rowMode: 'array', types: CURSOR_TYPES }));
      let read: { rows: unknown[][]; fields: QueryField[] };
      try {
        read = await new Promise((resolve, reject) => {
          cursor.read(opts.maxRows + 1, (err, rows, result) => {
            if (err) reject(err);
            else
              resolve({
                rows: rows as unknown[][],
                fields: (result?.fields ?? []) as QueryField[],
              });
          });
        });
      } finally {
        await cursor.close().catch(() => undefined);
      }
      const truncated = read.rows.length > opts.maxRows;
      const rows = (truncated ? read.rows.slice(0, opts.maxRows) : read.rows).map((r) =>
        r.map(jsonSafe),
      );
      const columns = await this.columnTypes(client, conn, read.fields);
      return { columns, rows, truncated, durationMs: Date.now() - started };
    });
  }

  async explainOnly(
    conn: PgConnectionParams,
    sql: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.readOnly(conn, opts.signal, (client) => this.explain(client, sql));
  }

  /**
   * `EXPLAIN` (no ANALYZE): Postgres parses and analyzes the statement and plans it, reading no
   * row. Name errors are marked `phase: 'validation'` so the caller can answer with suggestions
   * instead of counting a failed attempt. Positions are shifted back to the user's SQL.
   */
  private async explain(client: pg.PoolClient, sql: string): Promise<void> {
    try {
      await client.query(`${EXPLAIN_PREFIX}${sql}`);
    } catch (err) {
      const e = err as { code?: string; position?: string; phase?: string };
      if (e.position && /^\d+$/.test(e.position))
        e.position = String(Math.max(Number(e.position) - EXPLAIN_PREFIX.length, 1));
      if (e.code && VALIDATION_CODES.has(e.code)) e.phase = 'validation';
      throw err;
    }
  }

  /**
   * Resolves `(tableID, columnID)` of each result field to `schema.table.column` (`null` for
   * expressions: tableID 0). Cached per connection; one catalog query for all unknown pairs, inside
   * the same read-only transaction. A failed lookup leaves `source` undefined (never guessed).
   */
  private async columnSources(
    client: pg.PoolClient,
    conn: PgConnectionParams,
    fields: QueryField[],
  ): Promise<(ColumnSourceDto | null | undefined)[]> {
    const keyOf = (f: QueryField) => `${conn.id}:${f.tableID}:${f.columnID}`;
    const unknown = new Map<string, QueryField>();
    for (const f of fields) {
      if (!f.tableID || !f.columnID) continue;
      const key = keyOf(f);
      if (!this.sourceCache.has(key)) unknown.set(key, f);
    }
    if (unknown.size > 0) {
      const tables = [...unknown.values()].map((f) => f.tableID);
      const columns = [...unknown.values()].map((f) => f.columnID);
      try {
        const res = await client.query<{
          table_id: number;
          column_id: number;
          schema: string;
          table: string;
          column: string;
        }>(
          `select k.t::int as table_id, k.c::int as column_id, n.nspname::text as schema,
                  c.relname::text as "table", a.attname::text as "column"
             from unnest($1::oid[], $2::int2[]) as k(t, c)
             join pg_attribute a on a.attrelid = k.t and a.attnum = k.c
             join pg_class c on c.oid = a.attrelid
             join pg_namespace n on n.oid = c.relnamespace`,
          [tables, columns],
        );
        for (const r of res.rows) {
          this.sourceCache.set(`${conn.id}:${r.table_id}:${r.column_id}`, {
            schema: r.schema,
            table: r.table,
            column: r.column,
          });
        }
      } catch {
        // leave them unresolved: the classifier then treats the source as unknown
      }
    }
    return fields.map((f) => {
      if (!f.tableID || !f.columnID) return null;
      return this.sourceCache.get(keyOf(f));
    });
  }

  /** Maps type OIDs to names; unknown ones (enums, domains…) are looked up in `pg_type`. */
  private async columnTypes(
    client: pg.PoolClient,
    conn: PgConnectionParams,
    fields: QueryField[],
  ): Promise<QueryColumnDto[]> {
    const sources = await this.columnSources(client, conn, fields);
    const unknown = [
      ...new Set(
        fields
          .map((f) => f.dataTypeID)
          .filter((oid) => !TYPE_NAMES[oid] && !this.extraTypeNames.has(`${conn.id}:${oid}`)),
      ),
    ];
    if (unknown.length > 0) {
      try {
        const res = await client.query<{ oid: number; typname: string }>(
          'select oid::int as oid, typname from pg_type where oid = any($1::oid[])',
          [unknown],
        );
        for (const r of res.rows) this.extraTypeNames.set(`${conn.id}:${r.oid}`, r.typname);
      } catch {
        // fall back to oid:<n>
      }
    }
    return fields.map((f, i) => {
      const source = sources[i];
      return {
        name: f.name,
        type:
          TYPE_NAMES[f.dataTypeID] ??
          this.extraTypeNames.get(`${conn.id}:${f.dataTypeID}`) ??
          `oid:${f.dataTypeID}`,
        ...(source !== undefined ? { source } : {}),
      };
    });
  }

  /* ------------------------------ catalog ------------------------------ */

  /** SQL fragment restricting `nspname` to the allowed schemas; pushes its params. */
  private schemaFilter(schemas: string[], params: unknown[], column = 'n.nspname'): string {
    if (schemas.length > 0) {
      params.push(schemas);
      return `${column} = any($${params.length}::text[])`;
    }
    return `${column} not like 'pg\\_%' and ${column} <> 'information_schema'`;
  }

  async catalogSnapshot(
    conn: PgConnectionParams,
    opts: { schemas: string[]; refresh?: boolean; signal?: AbortSignal },
  ): Promise<PgCatalogSnapshot> {
    const ttl = this.options.catalogTtlMs ?? CATALOG_TTL_MS;
    const schemasKey = JSON.stringify([...opts.schemas].sort());
    const cached = this.catalogs.get(conn.id);
    if (
      !opts.refresh &&
      cached &&
      cached.version === conn.version &&
      cached.schemasKey === schemasKey &&
      Date.now() - cached.at < ttl
    )
      return cached.snapshot;
    const snapshot = await this.readOnly(conn, opts.signal, async (client) => {
      const params: unknown[] = [];
      const res = await client.query<{ schema: string; name: string; relkind: string }>(
        `select n.nspname::text as schema, c.relname::text as name, c.relkind::text as relkind
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r','v','m','f','p') and ${this.schemaFilter(opts.schemas, params)}
          order by n.nspname, c.relname`,
        params,
      );
      const path = await client.query<{ path: string[] }>(
        'select current_schemas(true)::text[] as path',
      );
      return {
        tables: res.rows.map((r) => ({
          schema: r.schema,
          name: r.name,
          kind: RELKIND[r.relkind] ?? ('table' as const),
        })),
        searchPath: path.rows[0]?.path ?? ['public'],
      };
    });
    this.catalogs.set(conn.id, { version: conn.version, schemasKey, at: Date.now(), snapshot });
    return snapshot;
  }

  async columnsOf(
    conn: PgConnectionParams,
    tables: { schema: string; name: string }[],
    opts: { refresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<Map<string, PgCatalogColumn[]>> {
    const ttl = this.options.catalogTtlMs ?? CATALOG_TTL_MS;
    const out = new Map<string, PgCatalogColumn[]>();
    const missing: { schema: string; name: string }[] = [];
    const wanted = new Map(tables.map((t) => [`${t.schema}.${t.name}`, t]));
    for (const [key, t] of wanted) {
      const hit = this.columnCache.get(`${conn.id}\0${key}`);
      if (!opts.refresh && hit && Date.now() - hit.at < ttl) out.set(key, hit.columns);
      else missing.push(t);
    }
    const todo = missing.slice(0, MAX_TABLES_PER_COLUMNS_QUERY);
    if (todo.length > 0) {
      const rows = await this.readOnly(conn, opts.signal, async (client) => {
        const res = await client.query<{
          schema: string;
          name: string;
          column: string;
          type: string;
        }>(
          `select n.nspname::text as schema, c.relname::text as name,
                  a.attname::text as "column", ty.typname::text as type
             from unnest($1::text[], $2::text[]) as k(sch, tbl)
             join pg_namespace n on n.nspname = k.sch
             join pg_class c on c.relnamespace = n.oid and c.relname = k.tbl
             join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
             join pg_type ty on ty.oid = a.atttypid
            order by n.nspname, c.relname, a.attnum`,
          [todo.map((t) => t.schema), todo.map((t) => t.name)],
        );
        return res.rows;
      });
      const grouped = new Map<string, PgCatalogColumn[]>();
      for (const r of rows) {
        const key = `${r.schema}.${r.name}`;
        const list = grouped.get(key);
        const column = { name: r.column, type: r.type };
        if (list) list.push(column);
        else grouped.set(key, [column]);
      }
      for (const [key, columns] of grouped) {
        this.columnCache.set(`${conn.id}\0${key}`, { at: Date.now(), columns });
        out.set(key, columns);
      }
    }
    return out;
  }

  async listTables(
    conn: PgConnectionParams,
    opts: { schemas: string[]; filter?: string; limit: number; signal?: AbortSignal },
  ): Promise<PgTableInfo[]> {
    return this.readOnly(conn, opts.signal, async (client) => {
      const params: unknown[] = [];
      const where = [
        `c.relkind in ('r','v','m','f','p')`,
        'not c.relispartition',
        this.schemaFilter(opts.schemas, params),
      ];
      const filter = opts.filter?.trim();
      if (filter) {
        params.push(`%${escapeLike(filter)}%`);
        const i = params.length;
        where.push(
          `(c.relname ilike $${i} or n.nspname ilike $${i} or coalesce(d.description, '') ilike $${i})`,
        );
      }
      params.push(opts.limit);
      const res = await client.query<{
        schema: string;
        name: string;
        relkind: string;
        comment: string | null;
        est: number | null;
      }>(
        `select n.nspname as schema, c.relname as name, c.relkind::text as relkind,
                d.description as comment, c.reltuples::float8 as est
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           left join pg_description d on d.objoid = c.oid and d.objsubid = 0
                and d.classoid = 'pg_class'::regclass
          where ${where.join(' and ')}
          order by n.nspname, c.relname
          limit $${params.length}`,
        params,
      );
      return res.rows.map((r) => ({
        schema: r.schema,
        name: r.name,
        kind: RELKIND[r.relkind] ?? 'table',
        comment: r.comment,
        estimatedRows: r.est !== null && r.est >= 0 ? Math.round(r.est) : null,
      }));
    });
  }

  private async resolveTable(
    client: pg.PoolClient,
    table: string,
    schemas: string[],
  ): Promise<TableRef | null> {
    const cleaned = table.trim().replace(/"/g, '');
    const dot = cleaned.indexOf('.');
    const schemaPart = dot === -1 ? null : cleaned.slice(0, dot);
    const namePart = dot === -1 ? cleaned : cleaned.slice(dot + 1);
    if (!namePart) return null;
    const params: unknown[] = [namePart];
    const where = [
      `c.relkind in ('r','v','m','f','p')`,
      `(c.relname = $1 or lower(c.relname) = lower($1))`,
      this.schemaFilter(schemas, params),
    ];
    if (schemaPart) {
      params.push(schemaPart);
      where.push(`n.nspname = $${params.length}`);
    }
    const res = await client.query<{
      oid: number;
      schema: string;
      name: string;
      relkind: string;
      comment: string | null;
      est: number | null;
    }>(
      `select c.oid::int as oid, n.nspname as schema, c.relname as name, c.relkind::text as relkind,
              obj_description(c.oid, 'pg_class') as comment, c.reltuples::float8 as est
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where ${where.join(' and ')}
        order by (c.relname = $1) desc, (n.nspname = 'public') desc, n.nspname
        limit 1`,
      params,
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      oid: r.oid,
      schema: r.schema,
      name: r.name,
      kind: RELKIND[r.relkind] ?? 'table',
      comment: r.comment,
      estimatedRows: r.est !== null && r.est >= 0 ? Math.round(r.est) : null,
    };
  }

  async describeTable(
    conn: PgConnectionParams,
    table: string,
    opts: { schemas: string[]; signal?: AbortSignal },
  ): Promise<PgTableDetail | null> {
    return this.readOnly(conn, opts.signal, async (client) => {
      const ref = await this.resolveTable(client, table, opts.schemas);
      if (!ref) return null;

      const cols = await client.query<{
        name: string;
        type: string;
        nullable: boolean;
        def: string | null;
        comment: string | null;
      }>(
        `select a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type,
                not a.attnotnull as nullable, pg_get_expr(ad.adbin, ad.adrelid) as def,
                col_description(a.attrelid, a.attnum) as comment
           from pg_attribute a
           left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
          where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped
          order by a.attnum`,
        [ref.oid],
      );
      const columns: PgColumnInfo[] = cols.rows.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        defaultValue: c.def,
        comment: c.comment,
      }));

      const cons = await client.query<{
        contype: string;
        cols: string[];
        ref_schema: string | null;
        ref_table: string | null;
        ref_cols: string[] | null;
      }>(
        `select c.contype::text as contype,
                (select array_agg(a.attname::text order by k.ord)
                   from unnest(c.conkey) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols,
                rn.nspname as ref_schema, rc.relname as ref_table,
                (select array_agg(a.attname::text order by k.ord)
                   from unnest(c.confkey) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as ref_cols
           from pg_constraint c
           left join pg_class rc on rc.oid = c.confrelid
           left join pg_namespace rn on rn.oid = rc.relnamespace
          where c.conrelid = $1::oid and c.contype in ('p', 'f')
          order by c.contype desc, c.conname`,
        [ref.oid],
      );
      const primaryKey = cons.rows.find((r) => r.contype === 'p')?.cols ?? [];
      const foreignKeys = cons.rows
        .filter((r) => r.contype === 'f' && r.ref_table)
        .map((r) => ({
          columns: r.cols ?? [],
          references: {
            schema: r.ref_schema ?? '',
            table: r.ref_table ?? '',
            columns: r.ref_cols ?? [],
          },
        }));

      const idx = await client.query<{ name: string; definition: string }>(
        `select ic.relname::text as name, pg_get_indexdef(i.indexrelid) as definition
           from pg_index i join pg_class ic on ic.oid = i.indexrelid
          where i.indrelid = $1::oid
          order by i.indisprimary desc, ic.relname
          limit 30`,
        [ref.oid],
      );

      return {
        schema: ref.schema,
        name: ref.name,
        kind: ref.kind,
        comment: ref.comment,
        estimatedRows: ref.estimatedRows,
        columns,
        primaryKey,
        foreignKeys,
        indexes: idx.rows,
      };
    });
  }

  async columnSummary(
    conn: PgConnectionParams,
    table: string,
    column: string,
    opts: { schemas: string[]; signal?: AbortSignal },
  ): Promise<PgColumnSummary | null> {
    return this.readOnly(conn, opts.signal, async (client) => {
      const ref = await this.resolveTable(client, table, opts.schemas);
      if (!ref) return null;
      const col = await client.query<{ name: string; type: string; category: string }>(
        `select a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type,
                t.typcategory::text as category
           from pg_attribute a join pg_type t on t.oid = a.atttypid
          where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped
            and (a.attname = $2 or lower(a.attname) = lower($2))
          order by (a.attname = $2) desc
          limit 1`,
        [ref.oid, column.trim()],
      );
      const c = col.rows[0];
      if (!c) return null;

      const q = quoteIdent(c.name);
      const withDistinct = (ref.estimatedRows ?? 0) <= DISTINCT_ROW_LIMIT;
      const withRange = c.category === 'N' || c.category === 'D';
      const select = [
        'count(*)::text as total',
        `count(${q})::text as non_null`,
        withDistinct
          ? `count(distinct ${q})::text as distinct_count`
          : 'null::text as distinct_count',
        withRange ? `min(${q})::text as min` : 'null::text as min',
        withRange ? `max(${q})::text as max` : 'null::text as max',
      ];
      const res = await client.query<{
        total: string;
        non_null: string;
        distinct_count: string | null;
        min: string | null;
        max: string | null;
      }>(`select ${select.join(', ')} from ${quoteIdent(ref.schema)}.${quoteIdent(ref.name)}`);
      const r = res.rows[0];
      const total = Number(r?.total ?? 0);
      return {
        schema: ref.schema,
        table: ref.name,
        column: c.name,
        type: c.type,
        total,
        nulls: total - Number(r?.non_null ?? 0),
        distinct: r?.distinct_count != null ? Number(r.distinct_count) : null,
        min: r?.min ?? null,
        max: r?.max ?? null,
      };
    });
  }
}
