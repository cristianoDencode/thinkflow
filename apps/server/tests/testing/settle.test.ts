import { describe, expect, it } from 'vitest';
import {
  createScreenSettler,
  isSettled,
  type SettleClock,
  type SettleReading,
} from '../../src/contexts/testing/domain/settle';

/** A clock that only moves when somebody sleeps. */
function fakeClock() {
  const clock = {
    t: 0,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) return;
      clock.sleeps.push(ms);
      clock.t += ms;
    },
  };
  return clock satisfies SettleClock & { t: number };
}

const quiet: SettleReading = {
  loaded: true,
  pendingRequests: 0,
  networkQuietMs: 10_000,
  domQuietMs: 10_000,
};

/** The page "settles" at `at` ms: before that it is loading, fetching and changing. */
function pageSettlingAt(clock: { now(): number }, at: number): () => Promise<SettleReading> {
  return async () => {
    const now = clock.now();
    if (now < at) {
      return {
        loaded: now > at / 2,
        pendingRequests: now < at / 2 ? 2 : 0,
        networkQuietMs: 0,
        domQuietMs: 0,
      };
    }
    // quiet since `at`
    return { loaded: true, pendingRequests: 0, networkQuietMs: now - at, domQuietMs: now - at };
  };
}

describe('isSettled', () => {
  it('needs the page loaded, no request in flight, and quiet network and DOM', () => {
    expect(isSettled(quiet)).toBe(true);
    expect(isSettled({ ...quiet, loaded: false })).toBe(false);
    expect(isSettled({ ...quiet, pendingRequests: 1 })).toBe(false);
    expect(isSettled({ ...quiet, networkQuietMs: 499 })).toBe(false);
    expect(isSettled({ ...quiet, networkQuietMs: 500 })).toBe(true);
    expect(isSettled({ ...quiet, domQuietMs: 399 })).toBe(false);
    expect(isSettled({ ...quiet, domQuietMs: 400 })).toBe(true);
  });
});

describe('createScreenSettler', () => {
  it('lets the action start, then returns as soon as the screen is quiet', async () => {
    const clock = fakeClock();
    const settler = createScreenSettler(clock);
    const outcome = await settler.settle(async () => quiet, { maxMs: 8000 });
    expect(outcome).toBe('settled');
    expect(clock.t).toBe(200); // only the minimum wait
  });

  it('keeps waiting while the page loads, fetches and changes', async () => {
    const clock = fakeClock();
    const settler = createScreenSettler(clock);
    const outcome = await settler.settle(pageSettlingAt(clock, 2000), { maxMs: 8000 });
    expect(outcome).toBe('settled');
    // quiet for 500 ms after the page stopped at 2.000 ms (polling every 100 ms)
    expect(clock.t).toBeGreaterThanOrEqual(2500);
    expect(clock.t).toBeLessThanOrEqual(2600);
  });

  it('gives up at the hard cap and prints anyway', async () => {
    const clock = fakeClock();
    const settler = createScreenSettler(clock);
    const busy = async (): Promise<SettleReading> => ({
      loaded: true,
      pendingRequests: 1,
      networkQuietMs: 0,
      domQuietMs: 0,
    });
    expect(await settler.settle(busy, { maxMs: 3000 })).toBe('timeout');
    expect(clock.t).toBe(3000);
  });

  it('stops right away when aborted by the next user action', async () => {
    const clock = fakeClock();
    const settler = createScreenSettler(clock);
    const controller = new AbortController();
    let reads = 0;
    const outcome = await settler.settle(
      async () => {
        reads += 1;
        if (reads === 3) controller.abort(); // the next action arrives
        return { loaded: false, pendingRequests: 0, networkQuietMs: 0, domQuietMs: 0 };
      },
      { maxMs: 8000, signal: controller.signal },
    );
    expect(outcome).toBe('aborted');
    expect(reads).toBe(3);
    expect(clock.t).toBeLessThan(1000);

    // already aborted: not even a reading
    const again = new AbortController();
    again.abort();
    let calls = 0;
    expect(
      await settler.settle(async () => (calls++, quiet), { maxMs: 8000, signal: again.signal }),
    ).toBe('aborted');
    expect(calls).toBe(0);
  });

  it('reports a page that is gone, and treats a failing reading as "not settled yet"', async () => {
    const clock = fakeClock();
    const settler = createScreenSettler(clock);
    expect(await settler.settle(async () => null, { maxMs: 8000 })).toBe('gone');

    let n = 0;
    const flaky = async (): Promise<SettleReading> => {
      if (++n < 4) throw new Error('Execution context was destroyed (navigating)');
      return quiet;
    };
    expect(await settler.settle(flaky, { maxMs: 8000 })).toBe('settled');
    expect(n).toBe(4);
  });

  it('never waits past the cap even when the minimum wait is longer', async () => {
    const clock = fakeClock();
    const settler = createScreenSettler(clock, { minWaitMs: 5000 });
    await settler.settle(async () => quiet, { maxMs: 1000 });
    expect(clock.sleeps[0]).toBe(1000);
  });
});
