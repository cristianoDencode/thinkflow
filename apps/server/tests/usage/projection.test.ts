import { describe, expect, it } from 'vitest';
import { project } from '../../src/contexts/usage/domain/projection';

describe('project', () => {
  it('extrapolates the month average, counting days without usage', () => {
    const p = project({
      monthTotal: 1000,
      daysElapsed: 10,
      daysInMonth: 30,
      current: true,
      recentDays: [],
    });
    expect(p).toEqual({
      basis: 'month',
      basisDays: 10,
      daily: 100,
      weekly: 700,
      monthly: 3000,
      yearly: 36500,
    });
  });

  it('uses the last days with data early in the month', () => {
    const p = project({
      monthTotal: 50,
      daysElapsed: 1,
      daysInMonth: 31,
      current: true,
      recentDays: [200, 400],
    });
    expect(p.basis).toBe('last7days');
    expect(p.basisDays).toBe(2);
    expect(p.daily).toBe(300);
    expect(p.monthly).toBe(50 + 300 * 30);
  });

  it('falls back to the month average when there is no history', () => {
    const p = project({
      monthTotal: 90,
      daysElapsed: 2,
      daysInMonth: 30,
      current: true,
      recentDays: [],
    });
    expect(p.basis).toBe('month');
    expect(p.daily).toBe(45);
  });

  it('reports the real total for past months', () => {
    const p = project({
      monthTotal: 2800,
      daysElapsed: 28,
      daysInMonth: 28,
      current: false,
      recentDays: [],
    });
    expect(p.monthly).toBe(2800);
    expect(p.daily).toBe(100);
  });

  it('handles an empty month', () => {
    const p = project({
      monthTotal: 0,
      daysElapsed: 0,
      daysInMonth: 30,
      current: true,
      recentDays: [],
    });
    expect(p.daily).toBe(0);
    expect(p.monthly).toBe(0);
  });
});
