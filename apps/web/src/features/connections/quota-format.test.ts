import type { QuotaSnapshotDto } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import { compactNumber, quotaLabels, quotaLine, resetIn } from './quota-format';

const NOW = 1_000_000;
const q = (over: Partial<QuotaSnapshotDto>): QuotaSnapshotDto => ({
  metric: 'tokens',
  window: 'day',
  limit: 200000,
  remaining: 617,
  used: 199383,
  resetAt: NOW + 13 * 60_000,
  model: null,
  source: 'error',
  observedAt: NOW,
  ...over,
});

describe('compactNumber', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1k'],
    [1500, '1,5k'],
    [8000, '8k'],
    [199383, '199k'],
    [310000, '310k'],
    [999_600, '1M'],
    [2_340_000, '2,3M'],
  ])('%i -> %s', (n, text) => expect(compactNumber(n)).toBe(text));
});

describe('resetIn', () => {
  it.each([
    [30_000, '30 s'],
    [13 * 60_000, '13 min'],
    [2 * 3_600_000, '2 h'],
    [3_600_000 + 5 * 60_000, '1 h 5 min'],
  ])('%i ms -> %s', (ms, text) => expect(resetIn(NOW + ms, NOW)).toBe(text));
});

describe('quotaLabels', () => {
  it('describes a daily token limit learned from a 429', () => {
    expect(quotaLabels([q({})], NOW)).toEqual(['Tokens/dia: 199k/200k usados (zera em 13 min)']);
  });

  it('shows Groq headers: requests per day, tokens per minute (limit only)', () => {
    const labels = quotaLabels(
      [
        q({ metric: 'tokens', window: 'minute', limit: 8000, used: null, resetAt: null }),
        q({ metric: 'requests', limit: 1000, used: 1, resetAt: NOW + 86_000 }),
      ],
      NOW,
    );
    expect(labels).toEqual(['Requisições/dia: 1/1k usadas (zera em 2 min)', '8k tokens/min']);
  });

  it('does not claim a window it does not know', () => {
    expect(
      quotaLabels(
        [q({ window: 'unknown', metric: 'requests', limit: 100, used: 4, resetAt: null })],
        NOW,
      ),
    ).toEqual(['Requisições: 4/100 usadas']);
  });

  it('hides unknown values and windows that already refilled', () => {
    expect(quotaLabels([q({ used: null, resetAt: null })], NOW)).toEqual([
      'Tokens/dia: limite 200k',
    ]);
    expect(quotaLabels([q({ resetAt: NOW - 1 })], NOW)).toEqual([]);
  });
});

describe('quotaLine', () => {
  const usage = { requests: 42, tokens: 310_000 };

  it('puts the app usage after what the provider reported', () => {
    expect(quotaLine([q({})], usage, NOW)).toBe(
      'Tokens/dia: 199k/200k usados (zera em 13 min) · usado pelo app hoje: 42 req · 310k tokens',
    );
  });

  it('shows only the app usage when the provider reports nothing', () => {
    expect(quotaLine([], usage, NOW)).toBe('usado pelo app hoje: 42 req · 310k tokens');
  });
});
