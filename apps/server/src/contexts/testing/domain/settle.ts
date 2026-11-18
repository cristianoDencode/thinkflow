/**
 * "Wait until the screen settles" before a print: the page and its frames finished loading, no
 * request is in flight (and none started/finished for a while) and the DOM stopped changing.
 * The rules live here, free of any browser: the adapter only reports what it observes
 * (`SettleReading`) and tests drive the waiter with a fake clock.
 */
export interface SettleReading {
  /** The main page and every frame reached `readyState === 'complete'`. */
  loaded: boolean;
  /** Requests started and not finished yet. */
  pendingRequests: number;
  /** Ms since a request last started, finished or failed (a huge number when none did). */
  networkQuietMs: number;
  /** Ms since the DOM last changed in the page or any frame (a huge number when it never did). */
  domQuietMs: number;
}

export interface SettleOptions {
  /** Hard cap: after this the print is taken anyway. */
  maxMs: number;
  /** Aborted when the next user action arrives: the print is taken right then. */
  signal?: AbortSignal;
}

/** Why the wait ended; the print is taken in every case (except when the page is gone). */
export type SettleOutcome = 'settled' | 'timeout' | 'aborted' | 'gone';

/** Reads the page now; `null` when the page was closed. */
export type SettleProbe = () => Promise<SettleReading | null>;

export interface ScreenSettler {
  settle(probe: SettleProbe, options: SettleOptions): Promise<SettleOutcome>;
}

export interface SettleConfig {
  /** No request activity for this long. */
  networkQuietMs: number;
  /** No DOM mutation for this long. */
  domQuietMs: number;
  /** Let the effects of the action start before the first reading. */
  minWaitMs: number;
  pollMs: number;
}

export const SETTLE_DEFAULTS: SettleConfig = {
  networkQuietMs: 500,
  domQuietMs: 400,
  minWaitMs: 200,
  pollMs: 100,
};

/** After an automatic print's action, or when the page is still loading at the start. */
export const AUTO_SETTLE_MAX_MS = 8_000;
/** Before a manual capture: the user is looking at the screen, do not keep them waiting. */
export const MANUAL_SETTLE_MAX_MS = 3_000;

export interface SettleClock {
  now(): number;
  /** Resolves early when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realSettleClock: SettleClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    }),
};

export const isSettled = (r: SettleReading, config: SettleConfig = SETTLE_DEFAULTS): boolean =>
  r.loaded &&
  r.pendingRequests === 0 &&
  r.networkQuietMs >= config.networkQuietMs &&
  r.domQuietMs >= config.domQuietMs;

export function createScreenSettler(
  clock: SettleClock = realSettleClock,
  config: Partial<SettleConfig> = {},
): ScreenSettler {
  const cfg = { ...SETTLE_DEFAULTS, ...config };
  return {
    async settle(probe, { maxMs, signal }) {
      const started = clock.now();
      const remaining = () => maxMs - (clock.now() - started);
      await clock.sleep(Math.min(cfg.minWaitMs, maxMs), signal);
      for (;;) {
        if (signal?.aborted) return 'aborted';
        let reading: SettleReading | null;
        try {
          reading = await probe();
        } catch {
          // the page navigated under the reading: it is certainly not settled yet
          reading = { loaded: false, pendingRequests: 0, networkQuietMs: 0, domQuietMs: 0 };
        }
        if (reading === null) return 'gone';
        if (signal?.aborted) return 'aborted';
        if (isSettled(reading, cfg)) return 'settled';
        const left = remaining();
        if (left <= 0) return 'timeout';
        await clock.sleep(Math.min(cfg.pollMs, left), signal);
      }
    },
  };
}
