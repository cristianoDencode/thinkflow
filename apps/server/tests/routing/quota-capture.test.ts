import { describe, expect, it } from 'vitest';
import { RouteChatRequest } from '../../src/contexts/routing/application/route-chat-request';
import type { QuotaObservation } from '../../src/contexts/connections/domain/quota';
import { providerCatalog } from '../../src/contexts/connections/domain/provider-catalog';
import { HttpProviderExecutor } from '../../src/contexts/routing/infrastructure/http-provider-executor';
import type { ProviderExecutor } from '../../src/contexts/routing/domain/ports';
import type { ExecutionResult } from '../../src/contexts/routing/domain/types';
import { FakeClock } from '../../src/shared/kernel/clock';
import {
  InMemoryComboRepository,
  InMemoryConnectionRepository,
  InMemoryLogRepository,
  fakeFetch,
  makeConnection,
  openAIFrames,
  seqIds,
  sseResponse,
} from '../helpers';

const recorder = () => {
  const records: { connectionId: string; observations: QuotaObservation[] }[] = [];
  return {
    records,
    record: (connectionId: string, observations: QuotaObservation[]) =>
      void records.push({ connectionId, observations }),
  };
};

describe('HttpProviderExecutor quota capture', () => {
  const target = {
    provider: providerCatalog.get('groq')!,
    connection: makeConnection({ id: 'g1', providerId: 'groq' }),
    model: 'llama',
  };
  const request = { format: 'openai' as const, body: { model: 'x', messages: [] } };

  it('hands the rate-limit headers of a successful answer to the recorder', async () => {
    const rec = recorder();
    const f = fakeFetch([
      {
        match: () => true,
        respond: () =>
          sseResponse(openAIFrames('oi'), {
            headers: {
              'x-ratelimit-limit-requests': '1000',
              'x-ratelimit-remaining-requests': '998',
              'x-ratelimit-reset-requests': '2m',
            },
          }),
      },
    ]);
    const result = await new HttpProviderExecutor(f.fn, { quota: rec, now: () => 10 }).execute(
      target,
      request,
    );
    expect(result.ok).toBe(true);
    expect(rec.records).toHaveLength(1);
    expect(rec.records[0]!.connectionId).toBe('g1');
    expect(rec.records[0]!.observations[0]).toMatchObject({
      metric: 'requests',
      window: 'day',
      limit: 1000,
      remaining: 998,
      model: 'llama',
      resetAt: null, // rolling per-day window: no reset time
      observedAt: 10,
    });
  });

  it('records nothing when there are no limit headers or the call failed', async () => {
    const rec = recorder();
    const f = fakeFetch([{ match: () => true, respond: () => sseResponse(openAIFrames('oi')) }]);
    await new HttpProviderExecutor(f.fn, { quota: rec }).execute(target, request);
    const failing = fakeFetch([
      {
        match: () => true,
        respond: () =>
          new Response('{}', { status: 500, headers: { 'x-ratelimit-limit-requests': '5' } }),
      },
    ]);
    await new HttpProviderExecutor(failing.fn, { quota: rec }).execute(target, request);
    expect(rec.records).toEqual([]);
  });

  it('never lets a throwing recorder break the request', async () => {
    const f = fakeFetch([
      {
        match: () => true,
        respond: () =>
          sseResponse(openAIFrames('oi'), { headers: { 'x-ratelimit-limit-requests': '5' } }),
      },
    ]);
    const result = await new HttpProviderExecutor(f.fn, {
      quota: {
        record: () => {
          throw new Error('db down');
        },
      },
    }).execute(target, request);
    expect(result.ok).toBe(true);
  });
});

describe('RouteChatRequest quota learning', () => {
  const run = async (failure: ExecutionResult) => {
    const rec = recorder();
    const clock = new FakeClock(1_000_000);
    const executor: ProviderExecutor = { execute: async () => failure };
    const router = new RouteChatRequest({
      connections: new InMemoryConnectionRepository([
        makeConnection({ id: 'groq-1', providerId: 'groq' }),
      ]),
      combos: new InMemoryComboRepository(),
      aliases: { getAliases: async () => ({ default: '', opus: '', sonnet: '', haiku: '' }) },
      executor,
      logs: new InMemoryLogRepository(),
      quota: rec,
      clock,
      ids: seqIds(),
    });
    await router.execute(
      { format: 'openai', body: { model: 'groq/llama', messages: [] } },
      { source: 'test' },
    );
    return { rec, clock };
  };

  it('records the limit a 429 message spells out', async () => {
    const { rec, clock } = await run({
      ok: false,
      failure: {
        status: 429,
        message:
          'Rate limit reached for model `llama` in organization `org_x` on tokens per day (TPD): Limit 200000, Used 199383, Requested 1520. Please try again in 13m45.6s.',
      },
    });
    expect(rec.records).toHaveLength(1);
    expect(rec.records[0]!.connectionId).toBe('groq-1');
    expect(rec.records[0]!.observations[0]).toMatchObject({
      metric: 'tokens',
      window: 'day',
      limit: 200000,
      used: 199383,
      resetAt: clock.now() + 825_600,
      source: 'error',
    });
  });

  it('ignores 429s without a measurement and other statuses', async () => {
    expect(
      (await run({ ok: false, failure: { status: 429, message: 'Rate limit' } })).rec.records,
    ).toEqual([]);
    expect(
      (
        await run({
          ok: false,
          failure: {
            status: 500,
            message: 'on tokens per day (TPD): Limit 5, Used 5. try again in 1m',
          },
        })
      ).rec.records,
    ).toEqual([]);
  });
});
