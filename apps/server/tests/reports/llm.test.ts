import { describe, expect, it } from 'vitest';
import {
  LlmError,
  completeChat,
  sleepWithSignal,
  waitDelayMs,
  withProviderRetry,
} from '../../src/contexts/reports/application/llm';
import type { RouteChatRequest } from '../../src/contexts/routing/application/route-chat-request';

describe('withProviderRetry', () => {
  const run = (errors: LlmError[], max?: number) => {
    const waits: [number, number, number][] = [];
    let calls = 0;
    const result = withProviderRetry(
      async () => {
        const next = errors[calls++];
        if (next) throw next;
        return 'ok';
      },
      {
        sleep: async () => undefined,
        onWait: (attempt, total, delay) => void waits.push([attempt, total, delay]),
        ...(max ? { maxAttempts: max } : {}),
      },
    );
    return { result, waits, calls: () => calls };
  };

  it('waits with exponential backoff capped at 60 s and tells which attempt comes next', async () => {
    const limit = () => new LlmError('429', 'rate_limited');
    const { result, waits } = run([limit(), limit(), limit()]);
    await expect(result).resolves.toBe('ok');
    expect(waits).toEqual([
      [2, 4, 10_000],
      [3, 4, 20_000],
      [4, 4, 40_000],
    ]);
    expect([0, 1, 2, 3, 4].map(waitDelayMs)).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  it('gives up after the last attempt with a hint to resume later', async () => {
    const { result, calls } = run(
      Array.from({ length: 6 }, () => new LlmError('cooldown', 'no_connection')),
    );
    await expect(result).rejects.toThrow(/continua limitando/);
    expect(calls()).toBe(4);
  });

  it('does not wait for an exhausted quota', async () => {
    const { result, waits } = run([new LlmError('quota', 'quota_exhausted')]);
    await expect(result).rejects.toThrow(/Cota do provedor esgotada.*Retomar/);
    expect(waits).toEqual([]);
  });

  it('rethrows what waiting cannot fix', async () => {
    const { result, calls } = run([new LlmError('bad', 'bad_request')]);
    await expect(result).rejects.toThrow('bad');
    expect(calls()).toBe(1);
  });

  it('stops waiting when the job is aborted', async () => {
    const controller = new AbortController();
    controller.abort('cancel');
    await expect(
      withProviderRetry(
        async () => {
          throw new LlmError('429', 'rate_limited');
        },
        { sleep: async () => undefined, signal: controller.signal },
      ),
    ).rejects.toThrow('429');
    await expect(sleepWithSignal(10_000, controller.signal)).rejects.toBe('cancel');
  });
});

describe('completeChat', () => {
  it('turns a router failure into an LlmError with its reason', async () => {
    const router = {
      execute: async () => ({
        ok: false,
        status: 429,
        reason: 'rate_limited',
        message: 'espere',
        attempts: [],
      }),
    } as unknown as RouteChatRequest;
    const error = await completeChat(
      router,
      { model: 'm', messages: [], maxTokens: 10 },
      { source: 'report-section' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({
      reason: 'rate_limited',
      message: 'espere',
      waitable: true,
      soft: false,
    });
  });
});

describe('retryable router failures', () => {
  it('waits and retries when the final reason is model_unavailable but a transient failure happened', async () => {
    const waits: number[] = [];
    let calls = 0;
    const router = {
      execute: async () => {
        calls++;
        if (calls === 1)
          return {
            ok: false,
            status: 404,
            reason: 'model_unavailable',
            message: 'no tools',
            attempts: [],
            retryable: true,
          };
        throw new Error('stop');
      },
    } as unknown as RouteChatRequest;
    const result = await withProviderRetry(
      () => completeChat(router, { model: 'auto', messages: [], maxTokens: 1 }, { source: 't' }),
      { sleep: async (ms) => void waits.push(ms) },
    ).catch((e: unknown) => e);
    expect(calls).toBe(2);
    expect(waits).toEqual([10_000]);
    expect(result).toBeInstanceOf(LlmError);
  });

  it('fails immediately for a non-retryable model_unavailable', async () => {
    const waits: number[] = [];
    const err = new LlmError('x', 'model_unavailable', false);
    await expect(
      withProviderRetry(
        async () => {
          throw err;
        },
        { sleep: async (ms) => void waits.push(ms) },
      ),
    ).rejects.toBe(err);
    expect(waits).toEqual([]);
  });

  it('waits on quota_exhausted only when something transient also happened', async () => {
    let calls = 0;
    const out = await withProviderRetry(
      async () => {
        if (calls++ === 0) throw new LlmError('q', 'quota_exhausted', true);
        return 'ok';
      },
      { sleep: async () => undefined },
    );
    expect(out).toBe('ok');
  });
});
