import type { DatabaseSslMode, QueryColumnDto } from '@thinkflow/shared';

/** Everything the gateway needs to reach one Postgres connection (password already decrypted). */
export interface PgConnectionParams {
  /** Connection id: key of the pool cache. */
  id: string;
  /** Changes on every edit: a different value discards the cached pool. */
  version: number;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: DatabaseSslMode;
  statementTimeoutSec: number;
}

export interface PgQueryResult {
  columns: QueryColumnDto[];
  /** At most `maxRows` rows; values JSON-safe (bigint/numeric as strings, dates as ISO strings). */
  rows: unknown[][];
  /** More than `maxRows` rows existed. */
  truncated: boolean;
  durationMs: number;
}

export interface PgTableInfo {
  schema: string;
  name: string;
  kind: 'table' | 'view' | 'materialized view' | 'foreign table' | 'partitioned table';
  comment: string | null;
  /** Planner estimate (`pg_class.reltuples`), null when unknown. */
  estimatedRows: number | null;
}

export interface PgColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  comment: string | null;
}

export interface PgTableDetail extends PgTableInfo {
  columns: PgColumnInfo[];
  primaryKey: string[];
  foreignKeys: {
    columns: string[];
    references: { schema: string; table: string; columns: string[] };
  }[];
  indexes: { name: string; definition: string }[];
}

export interface PgColumnSummary {
  schema: string;
  table: string;
  column: string;
  type: string;
  total: number;
  nulls: number;
  /** null when too expensive / not computed. */
  distinct: number | null;
  /** Only for numeric and date/time columns (text values are never summarized). */
  min: string | null;
  max: string | null;
}

/** A relation of the catalog (names only: columns are loaded on demand, see `columnsOf`). */
export interface PgCatalogTable {
  schema: string;
  name: string;
  kind: PgTableInfo['kind'];
}

export interface PgCatalogSnapshot {
  /** Tables, views, materialized/foreign/partitioned tables of the allowed schemas. */
  tables: PgCatalogTable[];
  /** `current_schemas(true)` of the session: how Postgres resolves unqualified names. */
  searchPath: string[];
}

export interface PgCatalogColumn {
  name: string;
  /** Postgres type name (`int4`, `varchar`…). */
  type: string;
}

export interface PgServerInfo {
  serverVersion: string;
  currentUser: string;
  /** Superuser, or INSERT/UPDATE/DELETE privilege on any table. */
  canWrite: boolean;
}

/**
 * Port to Postgres. EVERY statement runs inside `BEGIN TRANSACTION READ ONLY` with
 * `statement_timeout`, and the transaction is always rolled back: the database refuses writes
 * even when the login could write. Errors are thrown as `Error` with a pt-BR-friendly message.
 */
export interface PgGateway {
  test(conn: PgConnectionParams): Promise<PgServerInfo>;
  /** `sql` already passed the SQL guard. */
  query(
    conn: PgConnectionParams,
    sql: string,
    opts: {
      maxRows: number;
      signal?: AbortSignal;
      /**
       * Runs `EXPLAIN <sql>` first, in the same transaction: Postgres parses and analyzes the
       * statement without reading a row. Name errors (42703/42P01/42702/42883) are thrown with
       * `phase: 'validation'`; any other EXPLAIN error is thrown as it is.
       */
      explainFirst?: boolean;
    },
  ): Promise<PgQueryResult>;
  /**
   * Parses and plans `sql` (`EXPLAIN`, never executed) in a read-only transaction that is rolled
   * back. Resolves when Postgres accepts it. Name errors (42703/42P01/42702/42883) are thrown with
   * `phase: 'validation'`; any other error is thrown as it is (connection failures have no
   * 5-character SQLSTATE `code`). `sql` already passed the SQL guard.
   */
  explainOnly(
    conn: PgConnectionParams,
    sql: string,
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
  /**
   * Table names of the allowed schemas + the session's search path. Cached per connection
   * (10 min, cleared by `invalidate`); `refresh` bypasses the cache.
   */
  catalogSnapshot(
    conn: PgConnectionParams,
    opts: { schemas: string[]; refresh?: boolean; signal?: AbortSignal },
  ): Promise<PgCatalogSnapshot>;
  /**
   * Columns of the given tables, loaded on demand (an e-Cidade database has thousands of tables)
   * and cached. Keyed by `schema.name`; tables that do not exist are absent.
   */
  columnsOf(
    conn: PgConnectionParams,
    tables: { schema: string; name: string }[],
    opts?: { refresh?: boolean; signal?: AbortSignal },
  ): Promise<Map<string, PgCatalogColumn[]>>;
  /** Tables/views of the allowed schemas (`schemas` empty = all but pg_* / information_schema). */
  listTables(
    conn: PgConnectionParams,
    opts: { schemas: string[]; filter?: string; limit: number; signal?: AbortSignal },
  ): Promise<PgTableInfo[]>;
  /** `table` may be `schema.name` or just `name` (searched in the allowed schemas). */
  describeTable(
    conn: PgConnectionParams,
    table: string,
    opts: { schemas: string[]; signal?: AbortSignal },
  ): Promise<PgTableDetail | null>;
  columnSummary(
    conn: PgConnectionParams,
    table: string,
    column: string,
    opts: { schemas: string[]; signal?: AbortSignal },
  ): Promise<PgColumnSummary | null>;
  /** Drops the cached pool of a connection (edited or deleted). */
  invalidate(connectionId: string): Promise<void>;
  closeAll(): Promise<void>;
}

/** What the data dictionary (an MCP server such as e-Cidade's "Mapeamento") knows about a column. */
export interface MetadataFieldMatch {
  /** Schema in the dictionary (may differ from the database's). */
  schema: string | null;
  table: string;
  column: string;
  /** Business label of the column ("Nome/Razão Social"). */
  label: string | null;
  tableLabel: string | null;
}

export interface MetadataTableMatch {
  schema: string | null;
  table: string;
  /** Business description of the table. */
  description: string | null;
}

/** Which dictionary to ask: an MCP server of the app and one of its projects. */
export interface MetadataTarget {
  serverId: string;
  project: string;
}

/**
 * Port to an optional data dictionary. ONLY identifier words (table/column names) are ever sent
 * to it, never data values. Every method degrades to an empty answer when the server is down.
 */
export interface MetadataLookup {
  /** Columns whose dictionary label matches `term` (words of an identifier, e.g. `nome contribuinte`). */
  findFields(
    target: MetadataTarget,
    term: string,
    opts: { limit: number; signal?: AbortSignal },
  ): Promise<MetadataFieldMatch[]>;
  /** Tables whose name/description match `term`. */
  findTables(
    target: MetadataTarget,
    term: string,
    opts: { limit: number; signal?: AbortSignal },
  ): Promise<MetadataTableMatch[]>;
  /** Projects of the dictionary server (`list_projects`). */
  listProjects(serverId: string, signal?: AbortSignal): Promise<string[]>;
  /** Enabled MCP servers that expose a dictionary (tool `field_search`). */
  listServers(signal?: AbortSignal): Promise<{ id: string; name: string }[]>;
}
