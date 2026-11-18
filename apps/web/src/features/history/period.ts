export type Period = 'any' | 'today' | '7d' | '30d' | 'month' | 'lastMonth' | 'year' | 'custom';

export const PERIOD_LABELS: Record<Period, string> = {
  any: 'Qualquer data',
  today: 'Hoje',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  month: 'Este mês',
  lastMonth: 'Mês passado',
  year: 'Este ano',
  custom: 'Personalizado…',
};

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

/** `yyyy-mm-dd` (from an `<input type="date">`) as a local date, or null. */
function parseDay(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Last-activity range (epoch ms, local time, inclusive) for a period; custom uses the `from`/`to`
 * days typed by the user (either may be empty). Empty object = no limit.
 */
export function periodRange(
  period: Period,
  custom: { from: string; to: string } = { from: '', to: '' },
  now: Date = new Date(),
): { from?: number; to?: number } {
  const today = startOfDay(now);
  const daysAgo = (n: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  switch (period) {
    case 'any':
      return {};
    case 'today':
      return { from: today.getTime() };
    case '7d':
      return { from: daysAgo(6).getTime() };
    case '30d':
      return { from: daysAgo(29).getTime() };
    case 'month':
      return { from: new Date(today.getFullYear(), today.getMonth(), 1).getTime() };
    case 'lastMonth':
      return {
        from: new Date(today.getFullYear(), today.getMonth() - 1, 1).getTime(),
        to: endOfDay(new Date(today.getFullYear(), today.getMonth(), 0)).getTime(),
      };
    case 'year':
      return { from: new Date(today.getFullYear(), 0, 1).getTime() };
    case 'custom': {
      const from = parseDay(custom.from);
      const to = parseDay(custom.to);
      return {
        ...(from ? { from: from.getTime() } : {}),
        ...(to ? { to: endOfDay(to).getTime() } : {}),
      };
    }
  }
}
