import type { QueryResultDto } from '@thinkflow/shared';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Download,
  RefreshCw,
  Table2,
  TriangleAlert,
} from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/card';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { cn, formatNumber } from '../../lib/utils';
import type { UiQueryResult } from '../chat/types';
import { CopySqlButton, RunSqlButton } from './sql-code-block';
import { cellText, downloadText, isNumericType, sortedIndexes, toCsv, toTsv } from './query-utils';

export const PAGE_SIZE = 50;
/** Longer cell values are cut in the DOM (the full value stays in the tooltip, the CSV and the clipboard). */
const MAX_CELL_CHARS = 300;

type Sort = { column: number; direction: 'asc' | 'desc' } | null;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function Cell({ value, numeric }: { value: unknown; numeric: boolean }) {
  if (value === null || value === undefined)
    return <span className="text-xs text-subtle italic">NULL</span>;
  const text = cellText(value);
  const shown = text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
  return (
    <span
      title={text}
      className={cn('block max-w-md truncate', numeric && 'text-right tabular-nums')}
    >
      {shown}
    </span>
  );
}

/**
 * A query run in "Dados com IA" as a rich table card. Rows exist only right after the query ran;
 * a reloaded conversation keeps just SQL/columns/counts and offers "Executar de novo".
 */
export const QueryResultCard = memo(function QueryResultCard({
  result,
  databaseId,
  onRunSql,
  runDisabledReason = null,
}: {
  result: UiQueryResult;
  /** Connection used by "Executar de novo"; null when it is unknown or was deleted. */
  databaseId: string | null;
  /** Runs the SQL as direct SQL through the chat ("Rodar" next to "Copiar"); absent = no button. */
  onRunSql?: (sql: string) => void;
  /** Why "Rodar" is unavailable right now (streaming, no connection). */
  runDisabledReason?: string | null;
}) {
  const [rerun, setRerun] = useState<UiQueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const current = rerun ?? result;
  const failed = current.error !== null && current.error !== undefined;
  const [sqlOpen, setSqlOpen] = useState(failed || current.source === 'direct');
  const [sort, setSort] = useState<Sort>(null);
  const [page, setPage] = useState(0);

  // a new result (re-run, streamed update) starts on the first page, unsorted
  useEffect(() => {
    setPage(0);
    setSort(null);
  }, [current]);

  const rows = current.rows;
  const order = useMemo(() => {
    if (!rows || !sort) return null;
    const type = current.columns[sort.column]?.type ?? '';
    return sortedIndexes(rows, sort.column, type, sort.direction);
  }, [rows, sort, current.columns]);

  const total = rows?.length ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const visible = useMemo(() => {
    if (!rows) return [];
    const start = safePage * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, rows.length);
    const out: unknown[][] = [];
    for (let i = start; i < end; i += 1) out.push(rows[order ? order[i]! : i]!);
    return out;
  }, [rows, order, safePage]);

  const ordered = () => (rows && order ? order.map((i) => rows[i]!) : (rows ?? []));

  const toggleSort = (column: number) => {
    setPage(0);
    setSort((prev) =>
      prev?.column !== column
        ? { column, direction: 'asc' }
        : prev.direction === 'asc'
          ? { column, direction: 'desc' }
          : null,
    );
  };

  const exportCsv = () => {
    if (!rows) return;
    downloadText(
      `consulta-${stamp()}.csv`,
      toCsv(current.columns, ordered()),
      'text/csv;charset=utf-8',
    );
  };

  const copyForExcel = async () => {
    if (!rows) return;
    try {
      await navigator.clipboard.writeText(toTsv(current.columns, ordered()));
      notify.success('Copiado — cole direto no Excel');
    } catch {
      notify.error('Não foi possível copiar');
    }
  };

  const runAgain = async () => {
    if (!databaseId) return;
    setRunning(true);
    try {
      const fresh = await api.post<QueryResultDto>(`/api/databases/${databaseId}/query`, {
        sql: current.sql,
      });
      setRerun({ ...fresh, source: current.source, purpose: current.purpose });
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const count = `${formatNumber(current.rowCount)} ${current.rowCount === 1 ? 'linha' : 'linhas'}`;

  const rerunButton = (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void runAgain()}
      loading={running}
      disabled={!databaseId}
      title={databaseId ? undefined : 'A conexão desta conversa não está mais disponível'}
    >
      {!running && <RefreshCw className="h-3.5 w-3.5" aria-hidden />} Executar de novo
    </Button>
  );

  return (
    <section
      className="mt-3 overflow-hidden rounded-xl border border-border bg-surface"
      aria-label={current.purpose ? `Resultado: ${current.purpose}` : 'Resultado da consulta'}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2.5">
        <Table2 className="h-4 w-4 shrink-0 text-accent-text" aria-hidden />
        <Badge tone={current.source === 'ai' ? 'accent' : 'neutral'}>
          {current.source === 'ai' ? 'IA' : 'Direta'}
        </Badge>
        {current.purpose && (
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={current.purpose}>
            {current.purpose}
          </span>
        )}
        {!failed && (
          <span className="ml-auto text-xs text-muted">
            {count}
            {current.truncated && ` (truncado em ${formatNumber(current.rowCount)})`} ·{' '}
            {formatNumber(current.durationMs)} ms
          </span>
        )}
      </header>

      <div className="px-4 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSqlOpen((v) => !v)}
            aria-expanded={sqlOpen}
            className="flex cursor-pointer items-center gap-1 text-xs font-medium text-muted hover:text-fg"
          >
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', !sqlOpen && '-rotate-90')}
              aria-hidden
            />
            SQL
          </button>
          {sqlOpen && (
            <span className="flex items-center gap-0.5">
              {onRunSql && (
                <RunSqlButton
                  sql={current.sql}
                  onRun={onRunSql}
                  disabledReason={runDisabledReason}
                  invalid={!!current.validation}
                />
              )}
              <CopySqlButton sql={current.sql} />
            </span>
          )}
        </div>
        {sqlOpen && (
          <pre className="scrollbar-thin mt-1 max-h-60 overflow-auto rounded-lg bg-bg-elevated p-3 font-mono text-xs whitespace-pre-wrap">
            {current.sql}
          </pre>
        )}
      </div>

      {failed ? (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">
              {current.validation
                ? 'Consulta não executada: nomes que não existem'
                : 'A consulta falhou'}
            </p>
            <p className="break-words whitespace-pre-wrap">{current.error}</p>
            {databaseId && <div className="mt-2">{rerunButton}</div>}
          </div>
        </div>
      ) : !rows ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <p className="min-w-0 flex-1 text-sm text-muted">
            Os dados não ficam guardados no Thinkflow — Executar de novo para ver.
            {current.columns.length > 0 && (
              <span className="mt-1 block text-xs text-subtle">
                Colunas: {current.columns.map((c) => c.name).join(', ')}
              </span>
            )}
          </p>
          {rerunButton}
        </div>
      ) : (
        <>
          <div className="scrollbar-thin max-h-[28rem] overflow-auto border-t border-border">
            {total === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted">Nenhuma linha retornada.</p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {current.columns.map((column, i) => {
                      const active = sort?.column === i ? sort.direction : null;
                      return (
                        <th
                          key={`${column.name}-${i}`}
                          scope="col"
                          aria-sort={
                            active === 'asc'
                              ? 'ascending'
                              : active === 'desc'
                                ? 'descending'
                                : 'none'
                          }
                          className="sticky top-0 z-10 border-b border-border bg-surface-2 p-0 text-left"
                        >
                          <button
                            type="button"
                            onClick={() => toggleSort(i)}
                            aria-label={`Ordenar por ${column.name}`}
                            className={cn(
                              'flex w-full cursor-pointer items-start gap-1.5 px-3 py-2 hover:bg-surface-hover',
                              isNumericType(column.type) && 'flex-row-reverse text-right',
                            )}
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{column.name}</span>
                              <span className="block text-[10px] font-normal text-subtle">
                                {column.type}
                              </span>
                            </span>
                            {active === 'asc' ? (
                              <ArrowUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-text" />
                            ) : active === 'desc' ? (
                              <ArrowDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-text" />
                            ) : (
                              <ArrowUpDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
                            )}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row, r) => (
                    <tr
                      key={r}
                      className="border-b border-border/60 last:border-0 odd:bg-transparent even:bg-surface-2/40 hover:bg-surface-hover"
                    >
                      {current.columns.map((column, c) => (
                        <td key={c} className="px-3 py-1.5 align-top">
                          <Cell value={row[c]} numeric={isNumericType(column.type)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button variant="secondary" size="sm" onClick={exportCsv} disabled={total === 0}>
                <Download className="h-3.5 w-3.5" aria-hidden /> Exportar CSV
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void copyForExcel()}
                disabled={total === 0}
              >
                <Clipboard className="h-3.5 w-3.5" aria-hidden /> Copiar para Excel
              </Button>
              {rerunButton}
            </div>
            {total > PAGE_SIZE && (
              <nav className="ml-auto flex items-center gap-1.5" aria-label="Paginação">
                <span className="text-xs text-muted">
                  {formatNumber(safePage * PAGE_SIZE + 1)}–
                  {formatNumber(Math.min((safePage + 1) * PAGE_SIZE, total))} de{' '}
                  {formatNumber(total)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setPage(safePage - 1)}
                  disabled={safePage === 0}
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setPage(safePage + 1)}
                  disabled={safePage >= pages - 1}
                  aria-label="Próxima página"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </nav>
            )}
          </footer>
        </>
      )}
    </section>
  );
});
