import type { FailureClassification } from './error-classifier';

export interface CooldownDecision {
  cooldownUntil: number;
  backoffLevel: number;
}

export const MAX_BACKOFF_MS = 120_000;
export const AUTH_COOLDOWN_MS = 120_000;
export const CAPACITY_COOLDOWN_MS = 5_000;
export const MAX_QUOTA_COOLDOWN_MS = 3_600_000;
export const MAX_RETRY_AFTER_MS = 24 * 3_600_000;
/** Base for server/network failures: a dead host should not be retried on every request. */
export const TRANSIENT_BASE_MS = 5_000;

/** Exponential backoff: 1s, 2s, 4s … capped at 2 minutes. */
export function exponentialBackoff(level: number, baseMs = 1_000, maxMs = MAX_BACKOFF_MS): number {
  return Math.min(baseMs * 2 ** Math.max(0, level), maxMs);
}

export function msUntilNextUtcMidnight(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return next - now;
}

/**
 * Decides how long a connection stays out of rotation after a failure.
 * Returns null when the failure is not the connection's fault (scope target/fatal).
 */
export function decideCooldown(
  classification: FailureClassification,
  state: { backoffLevel: number; retryAfterMs?: number | null },
  now: number,
): CooldownDecision | null {
  if (classification.scope !== 'connection') return null;

  const level = state.backoffLevel;
  const retryAfter =
    state.retryAfterMs && state.retryAfterMs > 0
      ? Math.min(state.retryAfterMs, MAX_RETRY_AFTER_MS)
      : null;

  switch (classification.reason) {
    case 'rate_limited':
      return {
        cooldownUntil: now + (retryAfter ?? exponentialBackoff(level)),
        backoffLevel: level + 1,
      };
    case 'quota_exhausted': {
      if (classification.daily) {
        return {
          cooldownUntil: now + (retryAfter ?? msUntilNextUtcMidnight(now)),
          backoffLevel: level + 1,
        };
      }
      const ms = retryAfter ?? exponentialBackoff(level, 60_000, MAX_QUOTA_COOLDOWN_MS);
      return { cooldownUntil: now + ms, backoffLevel: level + 1 };
    }
    case 'capacity':
      return { cooldownUntil: now + (retryAfter ?? CAPACITY_COOLDOWN_MS), backoffLevel: level };
    case 'auth':
    case 'invalid_response':
      return { cooldownUntil: now + AUTH_COOLDOWN_MS, backoffLevel: level + 1 };
    case 'server':
    case 'network':
    default:
      return {
        cooldownUntil: now + (retryAfter ?? exponentialBackoff(level, TRANSIENT_BASE_MS)),
        backoffLevel: level + 1,
      };
  }
}
