export interface Projection {
  basis: 'month' | 'last7days';
  basisDays: number;
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
}

export interface ProjectionInput {
  monthTotal: number;
  daysElapsed: number;
  daysInMonth: number;
  /** True when the month is still running. */
  current: boolean;
  /** Daily totals of the last (up to 7) days with data, used early in the month. */
  recentDays: number[];
}

/** Below this many elapsed days the month average is too noisy; use the recent days instead. */
const MIN_DAYS_FOR_MONTH_BASIS = 3;

/**
 * Projects token usage from the average per day.
 * daily = average per elapsed day (days with zero count), weekly = daily x 7,
 * monthly = tokens so far + daily x remaining days (the real total for past months),
 * yearly = daily x 365.
 */
export function project(input: ProjectionInput): Projection {
  const { monthTotal, daysInMonth, current } = input;
  const elapsed = Math.max(input.daysElapsed, 1);
  const useRecent =
    current && input.daysElapsed < MIN_DAYS_FOR_MONTH_BASIS && input.recentDays.length > 0;

  const basisDays = useRecent ? input.recentDays.length : elapsed;
  const daily = useRecent
    ? input.recentDays.reduce((a, b) => a + b, 0) / input.recentDays.length
    : monthTotal / elapsed;

  const remaining = Math.max(daysInMonth - input.daysElapsed, 0);
  const monthly = current ? monthTotal + daily * remaining : monthTotal;

  return {
    basis: useRecent ? 'last7days' : 'month',
    basisDays,
    daily: Math.round(daily),
    weekly: Math.round(daily * 7),
    monthly: Math.round(monthly),
    yearly: Math.round(daily * 365),
  };
}
