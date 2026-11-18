import type { ConnectionUsageTodayDto, QuotaSnapshotDto } from '@thinkflow/shared';

/** 999 -> "999", 8000 -> "8k", 1500 -> "1,5k", 199383 -> "199k", 2_300_000 -> "2,3M". */
export function compactNumber(n: number): string {
  const short = (v: number, unit: string) =>
    `${(v < 10 ? Math.round(v * 10) / 10 : Math.round(v)).toString().replace('.', ',')}${unit}`;
  if (n < 1000) return String(Math.round(n));
  if (n < 999_500) return short(n / 1000, 'k');
  return short(n / 1_000_000, 'M');
}

/** "zera em 13 min" style countdown (the server tells when the window refills). */
export function resetIn(resetAt: number, now: number): string {
  const seconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const WINDOW_ORDER = { day: 0, unknown: 1, minute: 2 } as const;

/** What the provider itself reported, as short labels; unknown parts are simply left out. */
export function quotaLabels(quota: QuotaSnapshotDto[], now: number): string[] {
  const live = quota.filter((q) => q.window === 'minute' || q.resetAt === null || q.resetAt > now);
  live.sort(
    (a, b) =>
      WINDOW_ORDER[a.window] - WINDOW_ORDER[b.window] ||
      (a.metric === b.metric ? 0 : a.metric === 'requests' ? -1 : 1),
  );
  return live.map((q) => {
    const requests = q.metric === 'requests';
    if (q.window === 'minute')
      return `${compactNumber(q.limit)} ${requests ? 'req' : 'tokens'}/min`;
    const name = (requests ? 'Requisições' : 'Tokens') + (q.window === 'day' ? '/dia' : '');
    const value =
      q.used !== null
        ? `${compactNumber(q.used)}/${compactNumber(q.limit)} ${requests ? 'usadas' : 'usados'}`
        : `limite ${compactNumber(q.limit)}`;
    const reset = q.resetAt !== null ? ` (zera em ${resetIn(q.resetAt, now)})` : '';
    return `${name}: ${value}${reset}`;
  });
}

export function usageLabel(usage: ConnectionUsageTodayDto): string {
  return `usado pelo app hoje: ${usage.requests} req · ${compactNumber(usage.tokens)} tokens`;
}

/** The compact muted line of a connection card: provider-reported quota, then the app's own usage. */
export function quotaLine(
  quota: QuotaSnapshotDto[],
  usage: ConnectionUsageTodayDto,
  now: number,
): string {
  return [...quotaLabels(quota, now), usageLabel(usage)].join(' · ');
}
