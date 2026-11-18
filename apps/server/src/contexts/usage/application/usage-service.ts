import type { UsageMonthsDto, UsageReportDto } from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { DomainError } from '../../../shared/kernel/errors';
import {
  addMonths,
  dayKey,
  daysElapsed,
  daysOfMonth,
  MONTH_PATTERN,
  monthKey,
  monthRange,
} from '../domain/period';
import type { BudgetSource, UsageEntry, UsageRepository } from '../domain/ports';
import { project } from '../domain/projection';

export interface UsageDeps {
  repo: UsageRepository;
  budget: BudgetSource;
  clock: Clock;
}

/** Months of history kept in the aggregation table. */
const RETENTION_MONTHS = 13;
const PRUNE_EVERY = 200;

type Totals = Pick<UsageEntry, 'requests' | 'failures' | 'inputTokens' | 'outputTokens'>;

const zero = (): Totals => ({ requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 });
const add = (acc: Totals, row: Totals): void => {
  acc.requests += row.requests;
  acc.failures += row.failures;
  acc.inputTokens += row.inputTokens;
  acc.outputTokens += row.outputTokens;
};

function group<V extends Totals>(
  rows: UsageEntry[],
  keyOf: (r: UsageEntry) => string,
  make: (r: UsageEntry) => V,
): V[] {
  const map = new Map<string, V>();
  for (const r of rows) {
    const k = keyOf(r);
    let item = map.get(k);
    if (!item) map.set(k, (item = make(r)));
    add(item, r);
  }
  return [...map.values()];
}

export class UsageService {
  private writes = 0;

  constructor(private readonly deps: UsageDeps) {}

  /** Called by the router for every finished request. Never throws. */
  record(e: {
    at: number;
    source: string;
    providerId: string | null;
    model: string | null;
    success: boolean;
    inputTokens: number;
    outputTokens: number;
    estimated: boolean;
  }): void {
    try {
      void this.deps.repo
        .record({
          day: dayKey(e.at),
          providerId: e.providerId ?? '',
          model: e.model ?? '',
          source: e.source,
          requests: 1,
          failures: e.success ? 0 : 1,
          inputTokens: Math.max(0, Math.round(e.inputTokens)),
          outputTokens: Math.max(0, Math.round(e.outputTokens)),
          estimatedRequests: e.estimated ? 1 : 0,
        })
        .catch(() => undefined);
      if (++this.writes % PRUNE_EVERY === 0) {
        const oldest = addMonths(monthKey(this.deps.clock.now()), -RETENTION_MONTHS);
        void this.deps.repo.pruneBefore(`${oldest}-01`).catch(() => undefined);
      }
    } catch {
      // usage tracking must never break a request
    }
  }

  async months(): Promise<UsageMonthsDto> {
    const current = monthKey(this.deps.clock.now());
    const months = new Set(await this.deps.repo.months());
    months.add(current);
    return { current, months: [...months].sort().reverse() };
  }

  getBudget(): number {
    return this.deps.budget.getMonthlyTokens();
  }

  setBudget(tokens: number): void {
    this.deps.budget.setMonthlyTokens(tokens);
  }

  async report(month?: string): Promise<UsageReportDto> {
    const now = this.deps.clock.now();
    const currentMonth = monthKey(now);
    const target = month ?? currentMonth;
    if (!MONTH_PATTERN.test(target))
      throw new DomainError('Mês inválido (use AAAA-MM)', 'bad_request', 400);

    const { daysInMonth, end } = monthRange(target);
    const elapsed = daysElapsed(target, now);
    const current = target === currentMonth;

    const rows = await this.deps.repo.monthRows(target);
    const totals = zero();
    let estimatedRequests = 0;
    for (const r of rows) {
      add(totals, r);
      estimatedRequests += r.estimatedRequests;
    }
    const totalTokens = totals.inputTokens + totals.outputTokens;

    const byDay = new Map<string, Totals>();
    for (const r of rows) {
      const d = byDay.get(r.day) ?? zero();
      add(d, r);
      byDay.set(r.day, d);
    }
    const daily = daysOfMonth(target).map((day) => ({ day, ...(byDay.get(day) ?? zero()) }));

    const byProvider = group(
      rows,
      (r) => r.providerId,
      (r) => ({ providerId: r.providerId, ...zero() }),
    ).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

    const byModel = group(
      rows,
      (r) => `${r.providerId}\u0000${r.model}`,
      (r) => ({ providerId: r.providerId, model: r.model, ...zero() }),
    )
      .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
      .slice(0, 10)
      .map(({ failures: _failures, ...rest }) => rest);

    const bySource = group(
      rows,
      (r) => r.source,
      (r) => ({ source: r.source, ...zero() }),
    )
      .map((s) => ({
        source: s.source,
        requests: s.requests,
        totalTokens: s.inputTokens + s.outputTokens,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const prevRows = await this.deps.repo.monthRows(addMonths(target, -1));
    const prevTotals = zero();
    for (const r of prevRows) add(prevTotals, r);
    const previous =
      prevTotals.requests > 0
        ? {
            totalTokens: prevTotals.inputTokens + prevTotals.outputTokens,
            requests: prevTotals.requests,
          }
        : null;

    let recentDays: number[] = [];
    if (current && elapsed < 3) {
      const from = dayKey(now - 30 * 86_400_000);
      recentDays = (await this.deps.repo.dailyTotals(from, dayKey(now)))
        .filter((d) => d.totalTokens > 0)
        .slice(-7)
        .map((d) => d.totalTokens);
    }
    const projection = project({
      monthTotal: totalTokens,
      daysElapsed: elapsed,
      daysInMonth,
      current,
      recentDays,
    });

    const monthlyTokens = this.deps.budget.getMonthlyTokens();
    const pct = (n: number) => Math.round((n / monthlyTokens) * 1000) / 10;
    const budget =
      monthlyTokens > 0
        ? {
            monthlyTokens,
            usedPct: pct(totalTokens),
            projectedPct: pct(projection.monthly),
          }
        : null;

    return {
      month: target,
      current,
      daysInMonth,
      daysElapsed: elapsed,
      resetsAt: end,
      totals: { ...totals, totalTokens, estimatedRequests },
      previous,
      daily,
      byProvider,
      byModel,
      bySource,
      projection,
      budget,
    };
  }
}
