/** Calendar helpers. All dates use the server's local time zone. */

const pad = (n: number) => String(n).padStart(2, '0');

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM-DD' of a timestamp (local time). */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM' of a timestamp (local time). */
export function monthKey(ts: number): string {
  return dayKey(ts).slice(0, 7);
}

function parts(month: string): { year: number; monthIndex: number } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { year: y, monthIndex: m - 1 };
}

export function monthRange(month: string): { start: number; end: number; daysInMonth: number } {
  const { year, monthIndex } = parts(month);
  const start = new Date(year, monthIndex, 1).getTime();
  const end = new Date(year, monthIndex + 1, 1).getTime();
  return { start, end, daysInMonth: new Date(year, monthIndex + 1, 0).getDate() };
}

/** Shifts a 'YYYY-MM' by `delta` months. */
export function addMonths(month: string, delta: number): string {
  const { year, monthIndex } = parts(month);
  return monthKey(new Date(year, monthIndex + delta, 1).getTime());
}

/** Days of the month that already started (0 for future months, all days for past ones). */
export function daysElapsed(month: string, now: number): number {
  const { start, end, daysInMonth } = monthRange(month);
  if (now < start) return 0;
  if (now >= end) return daysInMonth;
  return new Date(now).getDate();
}

/** Every 'YYYY-MM-DD' of the month. */
export function daysOfMonth(month: string): string[] {
  const { daysInMonth } = monthRange(month);
  return Array.from({ length: daysInMonth }, (_, i) => `${month}-${pad(i + 1)}`);
}
