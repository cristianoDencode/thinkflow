import { describe, expect, it } from 'vitest';
import {
  AUTH_COOLDOWN_MS,
  CAPACITY_COOLDOWN_MS,
  MAX_BACKOFF_MS,
  decideCooldown,
  exponentialBackoff,
  msUntilNextUtcMidnight,
} from '../../src/contexts/routing/domain/cooldown-policy';
import type { FailureClassification } from '../../src/contexts/routing/domain/error-classifier';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const c = (
  reason: FailureClassification['reason'],
  scope: FailureClassification['scope'] = 'connection',
  daily = false,
) => ({
  reason,
  scope,
  daily,
});

describe('exponentialBackoff', () => {
  it('doubles and caps', () => {
    expect(exponentialBackoff(0)).toBe(1_000);
    expect(exponentialBackoff(3)).toBe(8_000);
    expect(exponentialBackoff(30)).toBe(MAX_BACKOFF_MS);
  });
});

describe('decideCooldown', () => {
  it('ignores failures that are not the connection fault', () => {
    expect(decideCooldown(c('model_unavailable', 'target'), { backoffLevel: 0 }, NOW)).toBeNull();
    expect(decideCooldown(c('bad_request', 'fatal'), { backoffLevel: 0 }, NOW)).toBeNull();
  });

  it('honours Retry-After for rate limits and escalates the level', () => {
    const d = decideCooldown(c('rate_limited'), { backoffLevel: 2, retryAfterMs: 30_000 }, NOW);
    expect(d).toEqual({ cooldownUntil: NOW + 30_000, backoffLevel: 3 });
  });

  it('uses exponential backoff for rate limits without Retry-After', () => {
    const d = decideCooldown(c('rate_limited'), { backoffLevel: 2 }, NOW);
    expect(d).toEqual({ cooldownUntil: NOW + 4_000, backoffLevel: 3 });
  });

  it('locks daily quotas until next UTC midnight', () => {
    const d = decideCooldown(c('quota_exhausted', 'connection', true), { backoffLevel: 0 }, NOW);
    expect(d?.cooldownUntil).toBe(Date.UTC(2026, 10, 11));
    expect(msUntilNextUtcMidnight(NOW)).toBe(12 * 3_600_000);
  });

  it('uses minute-scale backoff for non-daily quota errors', () => {
    expect(decideCooldown(c('quota_exhausted'), { backoffLevel: 1 }, NOW)?.cooldownUntil).toBe(
      NOW + 120_000,
    );
  });

  it('applies fixed cooldowns for capacity and auth', () => {
    expect(decideCooldown(c('capacity'), { backoffLevel: 4 }, NOW)).toEqual({
      cooldownUntil: NOW + CAPACITY_COOLDOWN_MS,
      backoffLevel: 4,
    });
    expect(decideCooldown(c('auth'), { backoffLevel: 0 }, NOW)?.cooldownUntil).toBe(
      NOW + AUTH_COOLDOWN_MS,
    );
  });

  it('starts transient (server/network) cooldowns at 5s and doubles them', () => {
    expect(decideCooldown(c('network'), { backoffLevel: 0 }, NOW)?.cooldownUntil).toBe(NOW + 5_000);
    expect(decideCooldown(c('server'), { backoffLevel: 2 }, NOW)?.cooldownUntil).toBe(NOW + 20_000);
  });

  it('caps absurd Retry-After values to 24h', () => {
    const d = decideCooldown(
      c('server'),
      { backoffLevel: 0, retryAfterMs: 10 * 24 * 3_600_000 },
      NOW,
    );
    expect(d?.cooldownUntil).toBe(NOW + 24 * 3_600_000);
  });
});
