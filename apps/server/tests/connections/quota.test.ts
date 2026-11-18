import { describe, expect, it } from 'vitest';
import {
  activeQuota,
  parseDuration,
  parseQuotaFromError,
  parseRateLimitHeaders,
  startOfLocalDay,
  type QuotaObservation,
} from '../../src/contexts/connections/domain/quota';

const NOW = 1_700_000_000_000;

describe('parseDuration', () => {
  it.each([
    ['1m26.4s', 86_400],
    ['659ms', 659],
    ['2h3m', 7_380_000],
    ['13m45.6s', 825_600],
    ['7.66s', 7_660],
    ['30', 30_000],
  ])('%s -> %i ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it('is null for garbage', () => {
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});

describe('parseRateLimitHeaders', () => {
  const groqHeaders = new Headers({
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-requests': '999',
    'x-ratelimit-reset-requests': '1m26.4s',
    'x-ratelimit-limit-tokens': '8000',
    'x-ratelimit-remaining-tokens': '7912',
    'x-ratelimit-reset-tokens': '659ms',
  });

  it('labels Groq requests as per day (rolling, no reset time) and tokens as per minute', () => {
    const out = parseRateLimitHeaders(groqHeaders, { providerId: 'groq', model: 'm', now: NOW });
    expect(out).toEqual([
      {
        metric: 'requests',
        window: 'day',
        limit: 1000,
        remaining: 999,
        used: 1,
        resetAt: null,
        model: 'm',
        source: 'headers',
        observedAt: NOW,
      },
      {
        metric: 'tokens',
        window: 'minute',
        limit: 8000,
        remaining: 7912,
        used: 88,
        resetAt: NOW + 659,
        model: 'm',
        source: 'headers',
        observedAt: NOW,
      },
    ]);
  });

  it('does not guess the window for other OpenAI-style providers', () => {
    const out = parseRateLimitHeaders(groqHeaders, { providerId: 'mistral', now: NOW });
    expect(out.map((o) => o.window)).toEqual(['unknown', 'unknown']);
    expect(out[0]!.model).toBeNull();
  });

  it('reads the Anthropic family (RFC 3339 reset)', () => {
    const h = new Headers({
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '49',
      'anthropic-ratelimit-requests-reset': '2026-11-12T10:00:00Z',
      'anthropic-ratelimit-tokens-limit': '40000',
      'anthropic-ratelimit-tokens-remaining': '39000',
    });
    const out = parseRateLimitHeaders(h, { providerId: 'anthropic', now: NOW });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      metric: 'requests',
      window: 'minute',
      limit: 50,
      remaining: 49,
      resetAt: Date.parse('2026-11-12T10:00:00Z'),
    });
    expect(out[1]).toMatchObject({ metric: 'tokens', limit: 40000, resetAt: null });
  });

  it('returns nothing when the provider sends no limit headers', () => {
    expect(parseRateLimitHeaders(new Headers(), { providerId: 'mistral', now: NOW })).toEqual([]);
  });

  it('ignores a metric without a usable limit', () => {
    const h = new Headers({
      'x-ratelimit-remaining-requests': '5',
      'x-ratelimit-limit-tokens': 'x',
    });
    expect(parseRateLimitHeaders(h, { providerId: 'groq', now: NOW })).toEqual([]);
  });
});

describe('parseQuotaFromError', () => {
  const tpd =
    'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199383, Requested 1520. Please try again in 13m45.6s. Need more tokens?';

  it('learns a daily token limit', () => {
    expect(parseQuotaFromError(tpd, NOW)).toEqual({
      metric: 'tokens',
      window: 'day',
      limit: 200000,
      used: 199383,
      remaining: 617,
      resetAt: NOW + 825_600,
      model: 'openai/gpt-oss-120b',
      source: 'error',
      observedAt: NOW,
    });
  });

  it.each([
    ['requests per day (RPD)', 'requests', 'day'],
    ['tokens per minute (TPM)', 'tokens', 'minute'],
    ['requests per minute (RPM)', 'requests', 'minute'],
  ])('learns %s', (what, metric, window) => {
    const msg = `Rate limit reached for model \`m\` on ${what}: Limit 30, Used 30, Requested 1. Please try again in 7.66s.`;
    expect(parseQuotaFromError(msg, NOW)).toMatchObject({
      metric,
      window,
      limit: 30,
      used: 30,
      remaining: 0,
      resetAt: NOW + 7_660,
    });
  });

  it('is null when the message carries no measurement', () => {
    expect(parseQuotaFromError('Rate limit exceeded', NOW)).toBeNull();
    expect(parseQuotaFromError('on tokens per day (TPD): Limit 10, Used 9', NOW)).toBeNull();
  });
});

describe('activeQuota', () => {
  const base: QuotaObservation = {
    metric: 'tokens',
    window: 'day',
    limit: 100,
    remaining: 10,
    used: 90,
    resetAt: NOW + 1000,
    model: null,
    source: 'error',
    observedAt: NOW - 5,
  };

  it('drops windows whose reset time has passed', () => {
    expect(activeQuota([base], NOW)).toHaveLength(1);
    expect(activeQuota([base], NOW + 1000)).toEqual([]);
    expect(activeQuota([{ ...base, window: 'unknown' }], NOW + 5000)).toEqual([]);
  });

  it('keeps only the limit of per-minute windows, even after their reset', () => {
    const minute = { ...base, window: 'minute' as const, resetAt: NOW - 1 };
    expect(activeQuota([minute], NOW)).toEqual([
      { ...minute, remaining: null, used: null, resetAt: null },
    ]);
  });

  it('keeps entries without a reset time for a day after they were observed', () => {
    const noReset = { ...base, resetAt: null };
    expect(activeQuota([noReset], NOW)).toHaveLength(1);
    expect(activeQuota([noReset], noReset.observedAt + 24 * 60 * 60 * 1000)).toEqual([]);
  });
});

describe('startOfLocalDay', () => {
  it('is local midnight', () => {
    const noon = new Date(2026, 10, 12, 13, 45, 10).getTime();
    expect(startOfLocalDay(noon)).toBe(new Date(2026, 10, 12, 0, 0, 0, 0).getTime());
  });
});
