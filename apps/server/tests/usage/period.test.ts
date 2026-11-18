import { describe, expect, it } from 'vitest';
import {
  addMonths,
  dayKey,
  daysElapsed,
  daysOfMonth,
  monthKey,
  monthRange,
} from '../../src/contexts/usage/domain/period';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe('period', () => {
  it('formats local day and month keys', () => {
    expect(dayKey(at(2026, 3, 5))).toBe('2026-03-05');
    expect(monthKey(at(2026, 12, 31, 23))).toBe('2026-12');
  });

  it('rolls over at the month boundary', () => {
    expect(monthKey(new Date(2026, 0, 31, 23, 59, 59).getTime())).toBe('2026-01');
    expect(monthKey(new Date(2026, 1, 1, 0, 0, 0).getTime())).toBe('2026-02');
  });

  it('knows the length of 28, 29, 30 and 31 day months', () => {
    expect(monthRange('2026-02').daysInMonth).toBe(28);
    expect(monthRange('2028-02').daysInMonth).toBe(29);
    expect(monthRange('2026-04').daysInMonth).toBe(30);
    expect(monthRange('2026-01').daysInMonth).toBe(31);
    expect(monthRange('2026-12').end).toBe(new Date(2027, 0, 1).getTime());
  });

  it('shifts months across years', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
  });

  it('counts elapsed days for current, past and future months', () => {
    expect(daysElapsed('2026-11', at(2026, 11, 11))).toBe(11);
    expect(daysElapsed('2026-10', at(2026, 11, 11))).toBe(31);
    expect(daysElapsed('2026-12', at(2026, 11, 11))).toBe(0);
  });

  it('lists every day of a month', () => {
    const days = daysOfMonth('2026-02');
    expect(days).toHaveLength(28);
    expect(days[0]).toBe('2026-02-01');
    expect(days.at(-1)).toBe('2026-02-28');
  });
});
