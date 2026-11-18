import { describe, expect, it } from 'vitest';
import { periodRange } from './period';

// 2026-11-12 15:30 local time
const now = new Date(2026, 10, 12, 15, 30);
const local = (y: number, m: number, d: number, ...t: number[]) =>
  new Date(y, m - 1, d, ...(t as [number?, number?, number?, number?])).getTime();

describe('periodRange', () => {
  it('turns presets into local-time ranges', () => {
    expect(periodRange('any', undefined, now)).toEqual({});
    expect(periodRange('today', undefined, now)).toEqual({ from: local(2026, 11, 12) });
    expect(periodRange('7d', undefined, now)).toEqual({ from: local(2026, 11, 6) });
    expect(periodRange('30d', undefined, now)).toEqual({ from: local(2026, 10, 14) });
    expect(periodRange('month', undefined, now)).toEqual({ from: local(2026, 11, 1) });
    expect(periodRange('lastMonth', undefined, now)).toEqual({
      from: local(2026, 10, 1),
      to: local(2026, 10, 31, 23, 59, 59, 999),
    });
    expect(periodRange('year', undefined, now)).toEqual({ from: local(2026, 1, 1) });
  });

  it('uses the typed days for a custom period (either side optional)', () => {
    expect(periodRange('custom', { from: '2026-01-05', to: '2026-01-10' }, now)).toEqual({
      from: local(2026, 1, 5),
      to: local(2026, 1, 10, 23, 59, 59, 999),
    });
    expect(periodRange('custom', { from: '', to: '2026-02-01' }, now)).toEqual({
      to: local(2026, 2, 1, 23, 59, 59, 999),
    });
    expect(periodRange('custom', { from: 'x', to: '' }, now)).toEqual({});
  });
});
