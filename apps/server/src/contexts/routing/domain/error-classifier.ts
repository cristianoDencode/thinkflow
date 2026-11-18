import type { UpstreamFailure } from './types';

export type FailureReason =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'capacity'
  | 'server'
  | 'network'
  | 'auth'
  | 'model_unavailable'
  | 'context_length'
  | 'bad_request'
  /** 2xx answer that is neither JSON nor SSE: a token/permission/endpoint problem, not a blip. */
  | 'invalid_response';

/**
 * - `connection`: this credential is unhealthy → cool it down, try the next connection/target.
 * - `target`: this provider/model can't serve the request → skip to the next target (no cooldown).
 * - `fatal`: the request itself is invalid → stop and return the error to the client.
 */
export type FailureScope = 'connection' | 'target' | 'fatal';

export interface FailureClassification {
  reason: FailureReason;
  scope: FailureScope;
  /** Quota that only resets the next day (RPD/TPD limits). */
  daily: boolean;
}

const QUOTA_RE =
  /quota|credit|billing|insufficient[_ ]funds|payment required|spend(ing)? limit|exceeded your current|balance is too low/i;
const DAILY_RE = /per[ -]day|daily|\bRPD\b|\bTPD\b|requests per day|tokens per day/i;
const CAPACITY_RE =
  /overloaded|over capacity|capacity|high demand|temporarily unavailable|try again later/i;
const CONTEXT_RE =
  /context(_| )length|context window|too long|too many tokens|maximum (context|number of tokens)|token limit|reduce the length/i;
const TOO_LARGE_RE =
  /request too large|reduce your message size|payload too large|request entity too large/i;
const PER_MINUTE_RE = /per minute|\bTPM\b|\bRPM\b|try again in|retry (after|in)/i;
/** Free-tier quota that is zero for one specific model ("limit: 0, model: x"). */
const MODEL_QUOTA_RE = /limit:\s*0\b[^]*model:\s*\S+|model:\s*\S+[^]*limit:\s*0\b/i;
const MODEL_RE =
  /model|not found|does not exist|not supported|unsupported|decommissioned|deprecated|no endpoints|not available|tool(s)? (use|calling)/i;

export function classifyFailure(failure: UpstreamFailure): FailureClassification {
  const { status, message } = failure;
  const text = message ?? '';
  const daily = DAILY_RE.test(text);

  if (failure.kind === 'invalid_response')
    return { reason: 'invalid_response', scope: 'connection', daily: false };

  if (status === null) return { reason: 'network', scope: 'connection', daily: false };

  if (status === 413 || TOO_LARGE_RE.test(text))
    return { reason: 'context_length', scope: 'target', daily: false };

  if (status === 429 && MODEL_QUOTA_RE.test(text) && !PER_MINUTE_RE.test(text))
    return { reason: 'model_unavailable', scope: 'target', daily: false };

  if (status === 429 && PER_MINUTE_RE.test(text) && !daily)
    return { reason: 'rate_limited', scope: 'connection', daily: false };

  if (status === 429) {
    return {
      reason: QUOTA_RE.test(text) ? 'quota_exhausted' : 'rate_limited',
      scope: 'connection',
      daily,
    };
  }
  if (status === 402) return { reason: 'quota_exhausted', scope: 'connection', daily };
  if (QUOTA_RE.test(text) && status >= 400 && !CONTEXT_RE.test(text)) {
    return { reason: 'quota_exhausted', scope: 'connection', daily };
  }
  if (status === 401 || status === 403)
    return { reason: 'auth', scope: 'connection', daily: false };
  if (status === 503 || status === 529 || (status >= 500 && CAPACITY_RE.test(text))) {
    return { reason: 'capacity', scope: 'connection', daily: false };
  }
  if (status === 408 || status === 504)
    return { reason: 'network', scope: 'connection', daily: false };
  if (status >= 500) return { reason: 'server', scope: 'connection', daily: false };
  if (status === 404) return { reason: 'model_unavailable', scope: 'target', daily: false };

  if (status === 400 || status === 413 || status === 422) {
    if (CONTEXT_RE.test(text) || status === 413)
      return { reason: 'context_length', scope: 'target', daily: false };
    if (MODEL_RE.test(text)) return { reason: 'model_unavailable', scope: 'target', daily: false };
  }
  return { reason: 'bad_request', scope: 'fatal', daily: false };
}

/** The request never got an answer in time (connect or idle timeout). */
export const isTimeoutFailure = (failure: UpstreamFailure): boolean =>
  failure.kind === 'timeout' ||
  (failure.status === null && /timeout|tempo esgotado|ocioso/i.test(failure.message));

const NO_TOOLS_RE =
  /tool(s)?[\s`'"_-]*(calling|use)?[\s`'"]*(is |are )?(not supported|unsupported)|(does not|doesn't|do not|don't) support (tools?|function)/i;

/** The upstream says this model cannot do tool/function calling. */
export const isToolUnsupported = (message: string): boolean => NO_TOOLS_RE.test(message);

/** Reasons that may clear up on their own after a short wait. */
export const TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  'rate_limited',
  'capacity',
  'server',
  'network',
]);
