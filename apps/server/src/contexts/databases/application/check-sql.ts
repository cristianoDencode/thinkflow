import type { SqlValidationDto, SqlValidationIssueDto } from '@thinkflow/shared';
import { AI_VALIDATION_FOOTER, AI_VALIDATION_HEADER } from '../domain/sql-validation';
import { checkReadOnlySql } from '../domain/sql-guard';
import { friendlyConnectError, queryErrorMessage } from './pg-errors';
import { isNameError, validationContext, type RunQueryDeps } from './run-query';
import { checkReferences, diagnoseDatabaseError, type ValidationFailure } from './validate-sql';

/** One SQL check must not hold the answer for longer than this (on top of the connection's statement timeout). */
export const CHECK_SQL_TIMEOUT_MS = 20_000;

const STARTS_WITH_EXPLAIN = /^\s*(?:\(\s*)*explain\b/i;
/** A real SQLSTATE (node network errors such as EPIPE/ECONNRESET are not). */
const SQLSTATE = /^(?:[0-9]{2}|P0|XX|HV|F0)[0-9A-Z]{3}$/;
/** Connection exception, invalid authorization, invalid catalog, starting up, too many connections. */
const CONNECTION_STATE = /^(?:08|28|3D|53)|^57P03$/;
/** Parameters ($1) and untyped placeholders: the SQL is a template, not something to judge. */
const PLACEHOLDER_STATES = new Set(['42P02', '42P18']);

export interface CheckSqlOutcome {
  validation: SqlValidationDto;
  /** Name findings worded for the AI (identifiers only, scrubbed); null unless a name is wrong. */
  aiText: string | null;
  /** The database could not be reached: the next check of the same turn would fail the same way. */
  unreachable: boolean;
}

const unchecked = (reason: string, unreachable = false): CheckSqlOutcome => ({
  validation: { status: 'unchecked', issues: [], reason },
  aiText: null,
  unreachable,
});

const invalid = (
  issues: SqlValidationIssueDto[],
  aiText: string | null = null,
): CheckSqlOutcome => ({
  validation: { status: 'invalid', issues, reason: null },
  aiText,
  unreachable: false,
});

function fromFailure(failure: ValidationFailure): CheckSqlOutcome {
  const aiText = failure.aiText
    .replace(AI_VALIDATION_HEADER, '')
    .replace(AI_VALIDATION_FOOTER, '')
    .trim();
  return invalid(failure.issues, aiText || null);
}

/**
 * Checks a SQL against the database WITHOUT running it: read-only guard, static references against
 * the catalog, then Postgres' own analysis (`EXPLAIN`, never ANALYZE) in a rolled-back read-only
 * transaction. Never reads a row and never throws except when `signal` (the caller's) aborts.
 *
 * - `sql` runs in the database (privacy tokens already restored);
 * - `referenceSql` is what names are read from and echoed back (tokens kept; defaults to `sql`).
 */
export async function checkSqlWithoutRunning(
  deps: RunQueryDeps,
  req: {
    sql: string;
    referenceSql?: string;
    source: 'ai' | 'direct';
    signal?: AbortSignal;
  },
): Promise<CheckSqlOutcome> {
  const guard = checkReadOnlySql(req.sql);
  if (!guard.ok)
    return invalid([{ message: `Consulta recusada: ${guard.reason}.`, suggestions: [] }]);

  const timeout = AbortSignal.timeout(CHECK_SQL_TIMEOUT_MS);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const ctx = validationContext(deps, req.source, signal);
  const checkedSql = req.referenceSql?.trim() || guard.sql;
  const params = deps.connection.toParams();

  try {
    const failure = await checkReferences(ctx, checkedSql);
    if (failure) return fromFailure(failure);
    // an EXPLAIN of an EXPLAIN is a syntax error (and EXPLAIN ANALYZE would run): static check only
    if (!STARTS_WITH_EXPLAIN.test(guard.sql))
      await deps.gateway.explainOnly(params, guard.sql, { signal });
    return {
      validation: { status: 'ok', issues: [], reason: null },
      aiText: null,
      unreachable: false,
    };
  } catch (err) {
    if (req.signal?.aborted) throw err instanceof Error ? err : new Error('aborted');
    if (timeout.aborted) return unchecked('A conferência no banco demorou demais e foi cancelada.');
    const code = (err as { code?: unknown } | null)?.code;
    const state = typeof code === 'string' ? code : '';
    if (isNameError(err))
      return fromFailure(
        await diagnoseDatabaseError(ctx, checkedSql, { message: err.message, code: err.code }),
      );
    if (!SQLSTATE.test(state) || CONNECTION_STATE.test(state))
      return unchecked(friendlyConnectError(err, params), true);
    if (PLACEHOLDER_STATES.has(state))
      return unchecked('A consulta usa parâmetros ($1…) e não pôde ser conferida no banco.');
    if (state.startsWith('42'))
      return invalid([
        { message: queryErrorMessage(err, params.statementTimeoutSec), suggestions: [] },
      ]);
    return unchecked(queryErrorMessage(err, params.statementTimeoutSec));
  }
}
