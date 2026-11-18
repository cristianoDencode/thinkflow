import type { QuotaMetric, QuotaSnapshotDto, QuotaWindow } from '@thinkflow/shared';

/**
 * Quota a provider reported for one credential. Two honest sources only: rate-limit response
 * headers and the text of a 429 error. Nothing here is guessed.
 */
export interface QuotaObservation {
  metric: QuotaMetric;
  window: QuotaWindow;
  limit: number;
  remaining: number | null;
  used: number | null;
  /** Epoch ms when the window refills. */
  resetAt: number | null;
  model: string | null;
  source: 'headers' | 'error';
  observedAt: number;
}

export interface HeaderReader {
  get(name: string): string | null;
}

const DURATION_RE = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;

/** "1m26.4s", "659ms", "2h3m", "30" (seconds) -> milliseconds. Null when unreadable. */
export function parseDuration(value: string): number | null {
  let total = 0;
  let matched = false;
  for (const m of value.matchAll(DURATION_RE)) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2];
    total +=
      unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000;
  }
  if (matched) return Math.round(total);
  const n = Number(value);
  return value.trim() !== '' && Number.isFinite(n) ? n * 1000 : null;
}

const toInt = (value: string | null): number | null => {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

function build(
  metric: QuotaMetric,
  window: QuotaWindow,
  limit: number | null,
  remaining: number | null,
  resetAt: number | null,
  model: string | null,
  now: number,
): QuotaObservation[] {
  if (limit === null || limit <= 0) return [];
  const left = remaining === null ? null : Math.min(remaining, limit);
  return [
    {
      metric,
      window,
      limit,
      remaining: left,
      used: left === null ? null : limit - left,
      resetAt,
      model,
      source: 'headers',
      observedAt: now,
    },
  ];
}

/**
 * Reads `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` (OpenAI style) and
 * `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}`.
 *
 * Only Groq documents the windows (requests = per day, tokens = per minute); other OpenAI-style
 * providers reuse the names with their own windows, so they stay 'unknown'.
 */
export function parseRateLimitHeaders(
  headers: HeaderReader,
  ctx: { providerId: string; model?: string | null; now: number },
): QuotaObservation[] {
  const model = ctx.model ?? null;
  const out: QuotaObservation[] = [];
  const groq = ctx.providerId === 'groq';
  for (const metric of ['requests', 'tokens'] as const) {
    const window: QuotaWindow = groq ? (metric === 'requests' ? 'day' : 'minute') : 'unknown';
    const reset = headers.get(`x-ratelimit-reset-${metric}`);
    const resetMs = reset ? parseDuration(reset) : null;
    out.push(
      ...build(
        metric,
        window,
        toInt(headers.get(`x-ratelimit-limit-${metric}`)),
        toInt(headers.get(`x-ratelimit-remaining-${metric}`)),
        // Groq's per-day window is rolling: its reset header is the time to win back ONE
        // request (~86 s at 1000/day), not when the day refills — so there is no reset time.
        resetMs === null || window === 'day' ? null : ctx.now + resetMs,
        model,
        ctx.now,
      ),
    );
  }
  for (const metric of ['requests', 'tokens'] as const) {
    const reset = headers.get(`anthropic-ratelimit-${metric}-reset`);
    const at = reset ? Date.parse(reset) : NaN;
    out.push(
      ...build(
        metric,
        'minute',
        toInt(headers.get(`anthropic-ratelimit-${metric}-limit`)),
        toInt(headers.get(`anthropic-ratelimit-${metric}-remaining`)),
        Number.isFinite(at) ? at : null,
        model,
        ctx.now,
      ),
    );
  }
  return out;
}

const LIMIT_RE =
  /on\s+(tokens|requests)\s+per\s+(day|minute|hour)\s*\(\s*[TR]P[DMH]\s*\)\s*:\s*Limit\s+(\d+)\s*,\s*Used\s+(\d+)/i;
const RETRY_RE = /try again in\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i;
const MODEL_RE = /for model\s+[`'"]([^`'"]+)[`'"]/i;

/**
 * Learns a limit from a 429 message such as "Rate limit reached for model `x` ... on tokens per
 * day (TPD): Limit 200000, Used 199383, Requested 1520. Please try again in 13m45.6s."
 * Returns null unless limit, used and a retry delay are all present.
 */
export function parseQuotaFromError(message: string, now: number): QuotaObservation | null {
  const hit = LIMIT_RE.exec(message);
  const retry = RETRY_RE.exec(message);
  if (!hit || !retry) return null;
  const delay = parseDuration(retry[1]!);
  const limit = Number(hit[3]);
  const used = Number(hit[4]);
  if (delay === null || !(limit > 0) || !Number.isFinite(used)) return null;
  const per = hit[2]!.toLowerCase();
  return {
    metric: hit[1]!.toLowerCase() as QuotaMetric,
    window: per === 'day' ? 'day' : per === 'minute' ? 'minute' : 'unknown',
    limit,
    used,
    remaining: Math.max(limit - used, 0),
    resetAt: now + delay,
    model: MODEL_RE.exec(message)?.[1] ?? null,
    source: 'error',
    observedAt: now,
  };
}

/** An entry without a reset time is still shown for a day after it was observed. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Local midnight (server timezone) of the day containing `now`. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * What is still worth showing: refilled windows are dropped, and a per-minute window keeps only
 * its limit (its remaining count is stale within seconds).
 */
export function activeQuota(rows: QuotaObservation[], now: number): QuotaSnapshotDto[] {
  const out: QuotaSnapshotDto[] = [];
  for (const r of rows) {
    if (r.window === 'minute') {
      out.push({ ...r, remaining: null, used: null, resetAt: null });
    } else if (r.resetAt === null ? now - r.observedAt < STALE_AFTER_MS : r.resetAt > now) {
      out.push({ ...r });
    }
  }
  return out.sort((a, b) => a.metric.localeCompare(b.metric) || a.window.localeCompare(b.window));
}
