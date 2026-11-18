/**
 * Capacity awareness: estimates how big a request is and remembers, per connection
 * and model, how many tokens each one accepts. Limits are learned from provider
 * errors ("Limit 8000, Requested 47687", "maximum context length is 128000"…) and
 * stored in *estimate units*, so they stay comparable with `estimateTokens`.
 */

/** Rough token estimate (≈4 chars/token) of everything sent as input. */
export function estimateTokens(body: Record<string, unknown>): number {
  const text = JSON.stringify([
    body.system ?? '',
    body.messages ?? body.input ?? [],
    body.tools ?? [],
  ]);
  return Math.ceil(text.length / 4);
}

export interface ParsedLimit {
  limit: number;
  /** Tokens the provider says the request had (used to calibrate our estimate). */
  requested: number | null;
}

const LIMIT_PATTERNS: RegExp[] = [
  /limit[:\s]+(\d[\d,]*)[^\d]{1,40}requested[:\s]+(\d[\d,]*)/i, // Groq / OpenAI TPM
  /(\d[\d,]*) tokens? > (\d[\d,]*) maximum/i, // Anthropic: "210000 tokens > 200000 maximum" (requested, limit)
  /maximum context length is (\d[\d,]*)[^\d]+(?:requested|resulted in) (\d[\d,]*)/i,
  /maximum context length is (\d[\d,]*)/i,
  /exceeds the maximum number of tokens allowed \((\d[\d,]*)\)/i, // Gemini
  /context (?:length|window)(?: of| is| limit(?: of| is)?)? (\d[\d,]*)/i,
  /max(?:imum)?(?: input)? tokens?(?: is| of|:)? (\d[\d,]*)/i,
  /limit[:\s]+(\d[\d,]*)/i,
];

const num = (s: string | undefined) => (s ? Number(s.replace(/,/g, '')) : NaN);

export function parseTokenLimit(message: string): ParsedLimit | null {
  for (const [i, re] of LIMIT_PATTERNS.entries()) {
    const m = re.exec(message);
    if (!m) continue;
    // the Anthropic form lists "requested > limit"
    const [limit, requested] = i === 1 ? [num(m[2]), num(m[1])] : [num(m[1]), num(m[2])];
    if (!Number.isFinite(limit) || limit < 256) continue;
    return { limit, requested: Number.isFinite(requested) ? requested : null };
  }
  return null;
}

export interface CapacityEntry {
  /** Max accepted input, in estimate units. Undefined = never rejected. */
  limit?: number;
  /** Largest request (estimate units) this connection/model served successfully. */
  maxOk?: number;
  /** When this connection/model last served a request successfully. */
  lastOkAt?: number;
  updatedAt: number;
}

export type CapacitySnapshot = Record<string, CapacityEntry>;

/** Learned limits expire so upgrades (paid tier, new model version) are rediscovered. */
const LIMIT_TTL_MS = 24 * 60 * 60 * 1000;
/** A model counts as proven for a request when it already served at least this share of its size. */
export const PROVEN_CAPACITY_RATIO = 0.85;
/** Keep a margin: our estimate is approximate. */
const SAFETY = 0.9;

const key = (connectionId: string, model: string) => `${connectionId}::${model}`;

export class CapacityBook {
  private entries: Map<string, CapacityEntry>;

  constructor(snapshot: CapacitySnapshot = {}) {
    this.entries = new Map(Object.entries(snapshot));
  }

  private get(connectionId: string, model: string, now: number): CapacityEntry | undefined {
    const e = this.entries.get(key(connectionId, model));
    if (e?.limit !== undefined && now - e.updatedAt > LIMIT_TTL_MS) {
      const { limit: _expired, ...rest } = e;
      return rest;
    }
    return e;
  }

  /** Learned (non-expired) input limit in estimate units; undefined = never rejected. */
  limit(connectionId: string, model: string, now: number): number | undefined {
    return this.get(connectionId, model, now)?.limit;
  }

  /** Best known capacity (limit, or the largest request served). Undefined = unknown. */
  capacity(connectionId: string, model: string, now: number): number | undefined {
    const e = this.get(connectionId, model, now);
    return e?.limit ?? e?.maxOk;
  }

  /** False only when we *know* the model rejects requests of this size. */
  fits(connectionId: string, model: string, tokens: number, now: number): boolean {
    const limit = this.get(connectionId, model, now)?.limit;
    return limit === undefined || tokens <= limit;
  }

  /** Learns from a "request too large" error. Returns the stored limit. */
  recordRejection(
    connectionId: string,
    model: string,
    estimate: number,
    message: string,
    now: number,
  ): number {
    const parsed = parseTokenLimit(message);
    let limit: number;
    if (parsed) {
      const ratio = parsed.requested ? estimate / parsed.requested : 1;
      limit = Math.floor(parsed.limit * ratio * SAFETY);
    } else {
      limit = Math.floor(estimate * SAFETY);
    }
    limit = Math.min(limit, Math.max(estimate - 1, 0));
    const prev = this.entries.get(key(connectionId, model));
    this.entries.set(key(connectionId, model), { ...prev, limit, updatedAt: now });
    return limit;
  }

  recordSuccess(connectionId: string, model: string, estimate: number, now: number): void {
    const k = key(connectionId, model);
    const prev = this.entries.get(k);
    const maxOk = Math.max(prev?.maxOk ?? 0, estimate);
    // served something bigger than the learned limit: the limit was transient/outdated
    const limit = prev?.limit !== undefined && estimate > prev.limit ? undefined : prev?.limit;
    this.entries.set(k, {
      ...(limit !== undefined ? { limit } : {}),
      maxOk,
      lastOkAt: now,
      updatedAt: now,
    });
  }

  /**
   * True when the model is known to handle a request this big: it served at least
   * `PROVEN_CAPACITY_RATIO` of it before (the estimate is approximate). Never true for a model
   * that is known to reject this size.
   */
  isProven(connectionId: string, model: string, tokens: number, now: number): boolean {
    if (!this.fits(connectionId, model, tokens, now)) return false;
    const maxOk = this.get(connectionId, model, now)?.maxOk;
    return maxOk !== undefined && maxOk >= tokens * PROVEN_CAPACITY_RATIO;
  }

  /** When the model last served a request on this connection (undefined = never recorded). */
  lastSuccessAt(connectionId: string, model: string, now: number): number | undefined {
    const e = this.get(connectionId, model, now);
    return e?.lastOkAt ?? (e?.maxOk !== undefined ? e.updatedAt : undefined);
  }

  /** Removes everything learned for a connection (e.g. when it is deleted or reset). */
  forget(connectionId: string): void {
    for (const k of this.entries.keys())
      if (k.startsWith(`${connectionId}::`)) this.entries.delete(k);
  }

  snapshot(): CapacitySnapshot {
    return Object.fromEntries(this.entries);
  }
}
