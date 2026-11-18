import type { QueryResultDto } from '@thinkflow/shared';
import type { DatabaseConnection } from '../domain/database-connection';
import type { MetadataLookup, PgGateway } from '../domain/ports';
import { checkReadOnlySql } from '../domain/sql-guard';
import { queryErrorMessage } from './pg-errors';
import {
  checkReferences,
  diagnoseDatabaseError,
  type ValidationContext,
  type ValidationFailure,
} from './validate-sql';

export interface RunQueryDeps {
  connection: DatabaseConnection;
  gateway: PgGateway;
  newId(): string;
  /** Optional data dictionary used for name suggestions (see `MetadataLookup`). */
  metadata?: MetadataLookup | undefined;
  /** Strips personal data from AI-bound validation text and from dictionary terms. */
  scrub?: (text: string) => string;
}

export interface RunQueryOutcome {
  result: QueryResultDto;
  /** The SQL guard refused it: Postgres was never contacted. */
  rejectedByGuard: boolean;
  /**
   * A table/column in the SQL does not exist: nothing was executed. `result.error` holds the
   * analyst's wording ("Você quis dizer…?"); `aiError` the identifier-only text for the AI.
   */
  validation: boolean;
  aiError?: string;
  /** SQLSTATE of a database error, when known. */
  errorCode?: string;
}

/** Context of the name checks: the analyst's own SQL is not limited to the schemas the AI may explore. */
export function validationContext(
  deps: RunQueryDeps,
  source: 'ai' | 'direct',
  signal?: AbortSignal,
): ValidationContext {
  const { connection } = deps;
  return {
    gateway: deps.gateway,
    params: connection.toParams(),
    schemas: source === 'direct' ? [] : connection.schemas,
    metadata:
      deps.metadata && connection.metadataMcpServerId && connection.metadataMcpProject
        ? {
            lookup: deps.metadata,
            target: {
              serverId: connection.metadataMcpServerId,
              project: connection.metadataMcpProject,
            },
          }
        : null,
    ...(deps.scrub ? { scrub: deps.scrub } : {}),
    ...(signal ? { signal } : {}),
  };
}

export function isNameError(err: unknown): err is Error & { code: string } {
  const e = err as { phase?: string; code?: unknown } | null;
  return e?.phase === 'validation' && typeof e.code === 'string';
}

/**
 * Guard → gateway → `QueryResultDto`. Never throws: failures land in `result.error` (pt-BR).
 * Shared by the analyst's "Executar SQL" and the AI's `executar_consulta`.
 */
export async function runGuardedQuery(
  deps: RunQueryDeps,
  req: {
    sql: string;
    source: 'ai' | 'direct';
    purpose: string | null;
    signal?: AbortSignal;
    /**
     * The SQL as the AI wrote it (tokens instead of real values): the names are checked on this
     * text, so a value restored into a quoted identifier never reaches a message.
     */
    referenceSql?: string;
  },
): Promise<RunQueryOutcome> {
  const base = {
    id: deps.newId(),
    sql: req.sql,
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    durationMs: 0,
    source: req.source,
    purpose: req.purpose,
  };
  const guard = checkReadOnlySql(req.sql);
  if (!guard.ok) {
    return {
      result: { ...base, error: `Consulta recusada: ${guard.reason}.` },
      rejectedByGuard: true,
      validation: false,
    };
  }
  const { connection } = deps;
  const started = Date.now();
  const checkedSql = req.referenceSql?.trim() || guard.sql;
  const ctx = validationContext(deps, req.source, req.signal);
  const notRun = (failure: ValidationFailure): RunQueryOutcome => ({
    result: {
      ...base,
      sql: guard.sql,
      durationMs: Date.now() - started,
      error: failure.analystText,
      validation: true,
    },
    rejectedByGuard: false,
    validation: true,
    aiError: failure.aiText,
  });

  // 1) static check of the names against the catalog (no row is read)
  const failure = await checkReferences(ctx, checkedSql).catch(() => null);
  if (failure) return notRun(failure);

  try {
    // 2) Postgres' own analysis (EXPLAIN) runs first, in the same read-only transaction
    const out = await deps.gateway.query(connection.toParams(), guard.sql, {
      maxRows: connection.maxRows,
      explainFirst: true,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    return {
      result: {
        ...base,
        sql: guard.sql,
        columns: out.columns,
        rows: out.rows,
        rowCount: out.rows.length,
        truncated: out.truncated,
        durationMs: out.durationMs,
        error: null,
      },
      rejectedByGuard: false,
      validation: false,
    };
  } catch (err) {
    if (isNameError(err) && !req.signal?.aborted)
      return notRun(
        await diagnoseDatabaseError(ctx, checkedSql, { message: err.message, code: err.code }),
      );
    const timeoutSec = connection.toParams().statementTimeoutSec;
    const code = (err as { code?: unknown } | null)?.code;
    return {
      result: {
        ...base,
        sql: guard.sql,
        durationMs: Date.now() - started,
        error: queryErrorMessage(err, timeoutSec),
      },
      rejectedByGuard: false,
      validation: false,
      ...(typeof code === 'string' ? { errorCode: code } : {}),
    };
  }
}
