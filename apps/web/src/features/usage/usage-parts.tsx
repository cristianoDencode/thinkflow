import type { UsageReportDto } from '@thinkflow/shared';
import type { ReactNode } from 'react';
import { Card } from '../../components/ui/card';
import { cn, formatNumber } from '../../lib/utils';

/** 1.234.567 -> "1,2 mi" for big numbers, plain pt-BR otherwise. */
export function compact(n: number): string {
  return n >= 10_000
    ? new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
    : formatNumber(n);
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const label = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function StatCard({
  label,
  value,
  children,
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {children && <div className="mt-1 text-xs text-muted">{children}</div>}
    </Card>
  );
}

/** Stacked bars (input / output) for every day of the month. */
export function DailyChart({ report }: { report: UsageReportDto }) {
  const max = Math.max(1, ...report.daily.map((d) => d.inputTokens + d.outputTokens));
  const today = report.current ? report.daysElapsed : report.daily.length + 1;
  return (
    <div>
      <div className="flex h-40 items-end gap-0.5 sm:gap-1" role="img" aria-label="Tokens por dia">
        {report.daily.map((d, i) => {
          const dayNumber = i + 1;
          const total = d.inputTokens + d.outputTokens;
          const future = report.current && dayNumber > report.daysElapsed;
          return (
            <div
              key={d.day}
              title={`${d.day.split('-').reverse().join('/')}: ${formatNumber(total)} tokens (${formatNumber(d.inputTokens)} entrada, ${formatNumber(d.outputTokens)} saída), ${formatNumber(d.requests)} requisições`}
              className={cn(
                'flex h-full min-w-0 flex-1 flex-col justify-end rounded-sm',
                future && 'opacity-30',
                dayNumber === today && 'bg-accent-soft',
              )}
            >
              <div
                className="w-full rounded-t-sm bg-success"
                style={{ height: `${(d.outputTokens / max) * 100}%` }}
              />
              <div
                className={cn('w-full bg-accent', d.outputTokens === 0 && 'rounded-t-sm')}
                style={{ height: `${(d.inputTokens / max) * 100}%` }}
              />
              {total === 0 && <div className="h-px w-full bg-border" />}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-subtle">
        <span>1</span>
        <span>{Math.ceil(report.daysInMonth / 2)}</span>
        <span>{report.daysInMonth}</span>
      </div>
      <div className="mt-3 flex gap-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-accent" /> Entrada
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-success" /> Saída
        </span>
      </div>
    </div>
  );
}

export interface BreakdownRow {
  key: string;
  label: string;
  sub?: string;
  tokens: number;
  requests: number;
}

/** Table with a share-of-total mini bar. */
export function Breakdown({
  title,
  rows,
  total,
}: {
  title: string;
  rows: BreakdownRow[];
  total: number;
}) {
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Sem dados.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((r) => {
            const pct = total > 0 ? (r.tokens / total) * 100 : 0;
            return (
              <li key={r.key}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-medium" title={r.label}>
                    {r.label}
                    {r.sub && (
                      <span className="ml-1.5 text-xs font-normal text-muted">{r.sub}</span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {compact(r.tokens)}{' '}
                    <span className="text-xs text-muted">({pct.toFixed(0)}%)</span>
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {formatNumber(r.requests)} {r.requests === 1 ? 'requisição' : 'requisições'}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
