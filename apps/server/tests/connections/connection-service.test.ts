import { describe, expect, it } from 'vitest';
import { ConnectionService } from '../../src/contexts/connections/application/connection-service';
import type {
  ConnectionUsageReader,
  QuotaStore,
} from '../../src/contexts/connections/domain/ports';
import {
  startOfLocalDay,
  type QuotaObservation,
} from '../../src/contexts/connections/domain/quota';
import { HttpConnectionProbe } from '../../src/contexts/connections/infrastructure/http-connection-probe';
import { FakeClock } from '../../src/shared/kernel/clock';
import {
  InMemoryComboRepository,
  InMemoryConnectionRepository,
  fakeFetch,
  jsonResponse,
  makeConnection,
  seqIds,
} from '../helpers';

class MemoryQuota implements QuotaStore {
  readonly rows = new Map<string, QuotaObservation[]>();
  record(id: string, observations: QuotaObservation[]) {
    const kept = (this.rows.get(id) ?? []).filter(
      (r) => !observations.some((o) => o.metric === r.metric && o.window === r.window),
    );
    this.rows.set(id, [...kept, ...observations]);
  }
  list(id: string) {
    return this.rows.get(id) ?? [];
  }
  listAll() {
    return this.rows;
  }
}

const groqHeaders = {
  'x-ratelimit-limit-requests': '1000',
  'x-ratelimit-remaining-requests': '999',
  'x-ratelimit-reset-requests': '1m26.4s',
  'x-ratelimit-limit-tokens': '8000',
  'x-ratelimit-remaining-tokens': '7912',
  'x-ratelimit-reset-tokens': '659ms',
};

const modelsBody = {
  data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.3-70b-versatile' }],
};

function setup(
  handlers: Parameters<typeof fakeFetch>[0],
  connection = makeConnection({ id: 'c1', providerId: 'groq' }),
) {
  const clock = new FakeClock(Date.now());
  const connections = new InMemoryConnectionRepository([connection]);
  const quota = new MemoryQuota();
  const f = fakeFetch(handlers);
  const usage: ConnectionUsageReader = {
    since: (sinceMs) =>
      new Map([
        ['c1', { requests: sinceMs === startOfLocalDay(clock.now()) ? 42 : 0, tokens: 310 }],
      ]),
  };
  const service = new ConnectionService({
    connections,
    combos: new InMemoryComboRepository(),
    probe: new HttpConnectionProbe(f.fn),
    quota,
    usage,
    clock,
    ids: seqIds(),
  });
  return { service, connections, quota, calls: f.calls, clock };
}

const isModels = (url: string) => url.endsWith('/models');
const isChat = (url: string) => url.endsWith('/chat/completions');
const chatOk =
  (headers: Record<string, string> = {}) =>
  () =>
    jsonResponse({ choices: [{ message: { content: 'oi' } }] }, 200, headers);

describe('ConnectionService.test', () => {
  it('lists models, makes a 1-token chat call and reports the quota the provider sent', async () => {
    const { service, calls, quota } = setup([
      { match: isModels, respond: () => jsonResponse(modelsBody) },
      { match: isChat, respond: chatOk(groqHeaders) },
    ]);
    const result = await service.test('c1');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('2 modelo(s)');
    expect(calls).toHaveLength(2);
    // a chat model from the list, never whisper; minimal request
    expect(calls[1]!.body).toMatchObject({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'oi' }],
    });
    expect(result.quota).toHaveLength(2);
    expect(result.quota![0]).toMatchObject({
      metric: 'requests',
      window: 'day',
      limit: 1000,
      remaining: 999,
      used: 1,
    });
    // minute windows only expose their limit
    expect(result.quota![1]).toMatchObject({
      metric: 'tokens',
      window: 'minute',
      limit: 8000,
      remaining: null,
    });
    expect(result.usageToday).toEqual({ requests: 42, tokens: 310 });
    expect(quota.list('c1')).toHaveLength(2);
  });

  it('prefers the connection default model', async () => {
    const { service, calls } = setup(
      [
        { match: isModels, respond: () => jsonResponse(modelsBody) },
        { match: isChat, respond: chatOk() },
      ],
      makeConnection({ id: 'c1', providerId: 'groq', defaultModel: 'my-model' }),
    );
    await service.test('c1');
    expect(calls[1]!.body!.model).toBe('my-model');
  });

  it('fails when a 200 answer is text/plain "OK" (bad token permission)', async () => {
    const text = () => new Response('OK', { headers: { 'content-type': 'text/plain' } });
    const { service, connections } = setup(
      [
        { match: isModels, respond: text },
        { match: isChat, respond: text },
      ],
      makeConnection({ id: 'c1', providerId: 'openrouter' }),
    );
    const result = await service.test('c1');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Resposta inesperada do provider (text/plain: "OK")');
    expect((await connections.findById('c1'))?.cooldownUntil).toBeNull();
  });

  it('a failed test neither cools the connection down nor records a failure, and still learns a 429 limit', async () => {
    const message =
      'Rate limit reached for model `m` on tokens per day (TPD): Limit 200000, Used 199383, Requested 1520. Please try again in 13m45.6s.';
    const { service, connections, quota, clock } = setup([
      { match: isModels, respond: () => jsonResponse(modelsBody) },
      { match: isChat, respond: () => jsonResponse({ error: { message } }, 429) },
    ]);
    const result = await service.test('c1');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('HTTP 429');
    const c = await connections.findById('c1');
    expect(c?.cooldownUntil).toBeNull();
    expect(c?.toSnapshot().failureCount).toBe(0);
    expect(quota.list('c1')[0]).toMatchObject({ metric: 'tokens', window: 'day', limit: 200000 });
    expect(result.quota![0]).toMatchObject({ used: 199383 });
    expect(result.quota![0]!.resetAt!).toBeGreaterThan(clock.now());
  });

  it('reports a list failure without touching the connection', async () => {
    const { service, calls } = setup([
      { match: isModels, respond: () => jsonResponse({ error: { message: 'bad key' } }, 401) },
    ]);
    const result = await service.test('c1');
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain('401');
    expect(calls).toHaveLength(1);
  });

  it('a successful test clears a stale error and cooldown without counting a success', async () => {
    const connection = makeConnection({ id: 'c1', providerId: 'openrouter' });
    connection.registerFailure(
      {
        message: '[429] A cota gratuita deste provider acabou',
        cooldownUntil: Date.now() + 1e9,
        backoffLevel: 3,
      },
      Date.now() - 10,
    );
    const { service, connections, clock } = setup(
      [
        { match: isModels, respond: () => jsonResponse({ data: [{ id: 'openrouter/auto' }] }) },
        { match: isChat, respond: chatOk() },
      ],
      connection,
    );
    expect(connection.status(clock.now())).toBe('cooldown');
    const result = await service.test('c1');
    expect(result.ok).toBe(true);
    expect(result.quota).toEqual([]); // no limit headers in this response
    const after = (await connections.findById('c1'))!.toSnapshot();
    expect(after).toMatchObject({
      lastError: null,
      lastErrorAt: null,
      cooldownUntil: null,
      backoffLevel: 0,
      successCount: 0,
      failureCount: 1,
    });
    expect(result.usageToday).toBeDefined();
  });

  it('list() shows only quota that has not expired, plus the app usage', async () => {
    const { service, quota, clock } = setup([]);
    const now = clock.now();
    const base = {
      metric: 'tokens' as const,
      limit: 200000,
      remaining: 617,
      used: 199383,
      model: null,
      source: 'error' as const,
      observedAt: now,
    };
    quota.record('c1', [
      { ...base, window: 'day', resetAt: now + 60_000 },
      { ...base, metric: 'requests', window: 'day', resetAt: now - 1 },
    ]);
    const [dto] = await service.list();
    expect(dto!.quota).toHaveLength(1);
    expect(dto!.quota[0]).toMatchObject({ metric: 'tokens', window: 'day', used: 199383 });
    expect(dto!.usageToday).toEqual({ requests: 42, tokens: 310 });
  });

  it('skips the chat call for local providers', async () => {
    const { service, calls } = setup(
      [{ match: isModels, respond: () => jsonResponse({ data: [{ id: 'llama3' }] }) }],
      makeConnection({ id: 'c1', providerId: 'ollama' }),
    );
    expect((await service.test('c1')).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('uses the Messages API for Anthropic providers', async () => {
    const { service, calls } = setup(
      [
        {
          match: isModels,
          respond: () =>
            jsonResponse({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }] }),
        },
        {
          match: (url) => url.endsWith('/v1/messages'),
          respond: () =>
            jsonResponse({ content: [{ type: 'text', text: 'oi' }] }, 200, {
              'anthropic-ratelimit-requests-limit': '50',
              'anthropic-ratelimit-requests-remaining': '49',
            }),
        },
      ],
      makeConnection({ id: 'c1', providerId: 'anthropic' }),
    );
    const result = await service.test('c1');
    expect(result.ok).toBe(true);
    expect(calls[1]!.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 1 });
    expect(result.quota![0]).toMatchObject({ metric: 'requests', window: 'minute', limit: 50 });
  });
});
