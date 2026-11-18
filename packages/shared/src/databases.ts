import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Database connections ("Database" in the user menu) + "Dados com IA" */
/* ------------------------------------------------------------------ */

export const DATABASE_LIMITS = {
  maxConnections: 50,
  /** Rows the screen receives per query (the AI never gets them all). */
  maxRows: 5000,
  defaultMaxRows: 1000,
  maxSampleRows: 100,
  defaultSampleRows: 20,
  maxStatementTimeoutSec: 300,
  defaultStatementTimeoutSec: 30,
  maxSqlChars: 100_000,
} as const;

export const databaseSslModeSchema = z.enum(['disable', 'require', 'verify-full']);
export type DatabaseSslMode = z.infer<typeof databaseSslModeSchema>;

/**
 * What the AI may see of the data:
 * - `schema`: structure only (tables, columns, types) + per-column statistics without text values;
 * - `masked`: also a small sample of rows, with sensitive columns partially masked (`10*******60`).
 * The analyst always sees the full result on screen.
 */
export const databaseAiAccessSchema = z.enum(['schema', 'masked']);
export type DatabaseAiAccess = z.infer<typeof databaseAiAccessSchema>;

const columnList = z.array(z.string().trim().min(1).max(128)).max(200).default([]);

export const databaseConnectionInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  database: z.string().trim().min(1).max(128),
  user: z.string().trim().min(1).max(128),
  password: z.string().max(1024).default(''),
  sslMode: databaseSslModeSchema.default('disable'),
  /** Schemas the AI may explore; empty = every schema except pg_* / information_schema. */
  schemas: columnList,
  aiAccess: databaseAiAccessSchema.default('schema'),
  sampleRows: z.coerce
    .number()
    .int()
    .min(1)
    .max(DATABASE_LIMITS.maxSampleRows)
    .default(DATABASE_LIMITS.defaultSampleRows),
  /** Extra column names always masked for the AI (besides the automatic detection). */
  sensitiveColumns: columnList,
  /** Column names never masked (overrides the automatic detection). */
  revealColumns: columnList,
  statementTimeoutSec: z.coerce
    .number()
    .int()
    .min(1)
    .max(DATABASE_LIMITS.maxStatementTimeoutSec)
    .default(DATABASE_LIMITS.defaultStatementTimeoutSec),
  maxRows: z.coerce
    .number()
    .int()
    .min(1)
    .max(DATABASE_LIMITS.maxRows)
    .default(DATABASE_LIMITS.defaultMaxRows),
  isDefault: z.boolean().default(false),
  /**
   * Optional MCP server with the system's data dictionary (tool `field_search`, e.g. e-Cidade's
   * "Mapeamento"); consulted only with identifier words when a SQL names a table/column that does
   * not exist. `null` = catalog suggestions only.
   */
  metadataMcpServerId: z.string().trim().min(1).max(100).nullable().default(null),
  /** Project/slug of that dictionary (one of the server's `list_projects`). */
  metadataMcpProject: z.string().trim().max(200).nullable().default(null),
});
export type DatabaseConnectionInput = z.input<typeof databaseConnectionInputSchema>;

/** Every field optional; an empty/absent password keeps the stored one. */
export const databaseConnectionUpdateSchema = databaseConnectionInputSchema
  .omit({ password: true })
  .partial()
  .extend({ password: z.string().max(1024).optional() });
export type DatabaseConnectionUpdateInput = z.input<typeof databaseConnectionUpdateSchema>;

export interface DatabaseConnectionDto {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  /** The password itself never leaves the server. */
  passwordSet: boolean;
  sslMode: DatabaseSslMode;
  schemas: string[];
  aiAccess: DatabaseAiAccess;
  sampleRows: number;
  sensitiveColumns: string[];
  revealColumns: string[];
  statementTimeoutSec: number;
  maxRows: number;
  isDefault: boolean;
  metadataMcpServerId: string | null;
  metadataMcpProject: string | null;
  createdAt: number;
  updatedAt: number;
}

/** An enabled MCP server that exposes the data-dictionary tools (`field_search`). */
export interface MetadataMcpServerDto {
  id: string;
  name: string;
}

export interface DatabaseTestResultDto {
  ok: boolean;
  /** pt-BR, for people. */
  message: string;
  latencyMs: number | null;
  serverVersion: string | null;
  currentUser: string | null;
  /** The login can write (superuser or INSERT/UPDATE/DELETE somewhere): Thinkflow still only reads. */
  canWrite: boolean | null;
}

export const directQuerySchema = z.object({
  sql: z.string().trim().min(1).max(DATABASE_LIMITS.maxSqlChars),
});
export type DirectQueryInput = z.infer<typeof directQuerySchema>;

/** Where a result column really comes from (resolved from the table/column OIDs, never the alias). */
export interface ColumnSourceDto {
  schema: string;
  table: string;
  column: string;
}

export interface QueryColumnDto {
  name: string;
  /** Postgres type name (e.g. `int4`, `numeric`, `date`, `text`). */
  type: string;
  /**
   * Table column the values come from (`null` = an expression: function, aggregate, literal).
   * Absent when the source is unknown (results stored before this field existed).
   */
  source?: ColumnSourceDto | null;
}

/** A query run in "Dados com IA" (by the AI or typed by the analyst). */
export interface QueryResultDto {
  id: string;
  sql: string;
  columns: QueryColumnDto[];
  /** Cell values as JSON (numbers/bigints/numerics may arrive as strings). */
  rows: unknown[][];
  /** Rows returned (at most `maxRows`). */
  rowCount: number;
  /** More rows existed than `maxRows`. */
  truncated: boolean;
  durationMs: number;
  source: 'ai' | 'direct';
  /** Why the AI ran it (the `objetivo` argument), if any. */
  purpose: string | null;
  /** The query failed (rows/columns empty). */
  error: string | null;
  /**
   * The failure is a name check ("table/column does not exist"): nothing reached the database for
   * execution and `error` carries the "did you mean…" suggestions.
   */
  validation?: boolean;
}

/** What is stored in the message: everything except the rows (they stay in the source DB). */
export type QueryResultMetaDto = Omit<QueryResultDto, 'rows'>;
