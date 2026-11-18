import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionDto, RequestLogDto } from '@thinkflow/shared';
import { anthropicFrames, fakeFetch, jsonResponse, openAIFrames, sseResponse } from '../helpers';
import { createTestApp, sseEvents, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

async function seed(t: TestApp) {
  const a = await t.api<ConnectionDto>('POST', '/api/connections', {
    providerId: 'groq',
    name: 'groq-a',
    apiKey: 'gsk_a',
    priority: 1,
  });
  const b = await t.api<ConnectionDto>('POST', '/api/connections', {
    providerId: 'groq',
    name: 'groq-b',
    apiKey: 'gsk_b',
    priority: 2,
  });
  const c = await t.api<ConnectionDto>('POST', '/api/connections', {
    providerId: 'anthropic',
    name: 'claude',
    apiKey: 'sk-ant',
    priority: 1,
  });
  expect(a.status).toBe(201);
  const combo = await t.api('POST', '/api/combos', {
    name: 'thinkflow/default',
    targets: [
      { providerId: 'groq', model: 'llama-3.3-70b-versatile' },
      { providerId: 'anthropic', model: 'claude-haiku-5-5' },
    ],
  });
  expect(combo.status).toBe(201);
  return { a: a.json, b: b.json, c: c.json };
}

describe('gateway /v1', () => {
  it('serves Claude Code (/v1/messages, stream) through an OpenAI provider with key fallback', async () => {
    const fetch = fakeFetch([
      {
        match: (url, _b, h) => url === GROQ && h.authorization === 'Bearer gsk_a',
        respond: () =>
          jsonResponse({ error: { message: 'Rate limit reached for requests per minute' } }, 429, {
            'retry-after': '20',
          }),
      },
      {
        match: (url, _b, h) => url === GROQ && h.authorization === 'Bearer gsk_b',
        respond: () => sseResponse(openAIFrames('Olá do Groq')),
      },
    ]);
    t = await createTestApp({ fetchFn: fetch.fn });
    await seed(t);

    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': t.apiKey, 'anthropic-version': '2023-06-01' },
      payload: {
        model: 'thinkflow/default',
        max_tokens: 1024,
        stream: true,
        system: [{ type: 'text', text: 'You are Claude Code' }],
        tools: [{ name: 'Bash', description: 'Run', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'oi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-thinkflow-provider']).toBe('groq');

    const events = sseEvents(res.body);
    expect(events[0]?.type).toBe('message_start');
    expect(events.at(-1)?.type).toBe('message_stop');
    const text = events
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => (e.delta as { text?: string }).text ?? '')
      .join('');
    expect(text).toBe('Olá do Groq');

    // upstream received an OpenAI-format request with translated tools
    const upstream = fetch.calls.at(-1)!;
    expect(upstream.body?.model).toBe('llama-3.3-70b-versatile');
    expect((upstream.body?.messages as { role: string }[])[0]?.role).toBe('system');
    expect((upstream.body?.tools as { function: { name: string } }[])[0]?.function.name).toBe(
      'Bash',
    );
    expect(upstream.body?.stream_options).toEqual({ include_usage: true });

    // first key is now cooling down and visible in the dashboard
    const connections = await t.api<ConnectionDto[]>('GET', '/api/connections');
    const cooled = connections.json.find((c) => c.name === 'groq-a');
    expect(cooled?.status).toBe('cooldown');
    expect(cooled?.lastError).toContain('Rate limit');

    await new Promise((r) => setTimeout(r, 10));
    const logs = await t.api<RequestLogDto[]>('GET', '/api/logs');
    expect(logs.json[0]).toMatchObject({
      success: true,
      providerId: 'groq',
      inputTokens: 12,
      outputTokens: 5,
    });
    expect(logs.json[0]?.attempts.map((a) => a.reason)).toEqual(['rate_limited', 'success']);
  });

  it('returns a non-streaming Anthropic message', async () => {
    const fetch = fakeFetch([
      { match: (url) => url === GROQ, respond: () => sseResponse(openAIFrames('resposta curta')) },
    ]);
    t = await createTestApp({ fetchFn: fetch.fn });
    await seed(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${t.apiKey}` },
      payload: {
        model: 'thinkflow/default',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'oi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe('message');
    expect(body.content).toEqual([{ type: 'text', text: 'resposta curta' }]);
    expect(body.stop_reason).toBe('end_turn');
  });

  it('serves OpenAI clients from an Anthropic upstream when the first target is down', async () => {
    const fetch = fakeFetch([
      {
        match: (url) => url === GROQ,
        respond: () => jsonResponse({ error: { message: 'Service unavailable' } }, 503),
      },
      {
        match: (url) => url === ANTHROPIC,
        respond: () => sseResponse(anthropicFrames('Oi do Claude')),
      },
    ]);
    t = await createTestApp({ fetchFn: fetch.fn });
    await seed(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${t.apiKey}` },
      payload: {
        model: 'thinkflow/default',
        stream: true,
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'oi' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.trim().endsWith('data: [DONE]')).toBe(true);
    const text = sseEvents(res.body)
      .map(
        (c) =>
          (c.choices as { delta: { content?: string } }[] | undefined)?.[0]?.delta.content ?? '',
      )
      .join('');
    expect(text).toBe('Oi do Claude');

    const upstream = fetch.calls.find((c) => c.url === ANTHROPIC)!;
    expect(upstream.headers['x-api-key']).toBe('sk-ant');
    expect(upstream.headers['anthropic-version']).toBe('2023-06-01');
    expect(upstream.body?.system).toBe('s');
    expect(upstream.body?.model).toBe('claude-haiku-5-5');
  });

  it('answers with an Anthropic-shaped error when every target fails', async () => {
    const fetch = fakeFetch([
      {
        match: (url) => url === GROQ,
        respond: () => jsonResponse({ error: { message: 'quota exceeded' } }, 429),
      },
      {
        match: (url) => url === ANTHROPIC,
        respond: () =>
          jsonResponse(
            { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
            529,
          ),
      },
    ]);
    t = await createTestApp({ fetchFn: fetch.fn });
    await seed(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': t.apiKey },
      payload: {
        model: 'thinkflow/default',
        max_tokens: 10,
        stream: true,
        messages: [{ role: 'user', content: 'oi' }],
      },
    });
    expect(res.statusCode).toBe(529);
    const body = res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('overloaded_error');
    expect(body.error.attempts).toHaveLength(3);
  });

  it('maps Claude model names through the configured aliases', async () => {
    const fetch = fakeFetch([
      { match: (url) => url === GROQ, respond: () => sseResponse(openAIFrames('ok')) },
    ]);
    t = await createTestApp({ fetchFn: fetch.fn });
    await seed(t);
    await t.api('PUT', '/api/settings', {
      aliases: { default: 'thinkflow/default', opus: '', sonnet: '', haiku: '' },
    });
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': t.apiKey },
      payload: {
        model: 'claude-sonnet-5-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'oi' }],
      },
    });
    // an Anthropic connection exists, so claude-* goes there directly unless a family alias is set
    // (the fake upstream has no Anthropic handler → network failure → 502)
    expect(res.statusCode).toBe(502);
    expect(res.json().error.attempts[0]).toMatchObject({
      providerId: 'anthropic',
      reason: 'network',
    });
    await t.api('PUT', '/api/settings', {
      aliases: { default: '', opus: '', sonnet: 'thinkflow/default', haiku: '' },
    });
    const viaAlias = await t.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': t.apiKey },
      payload: {
        model: 'claude-sonnet-5-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'oi' }],
      },
    });
    expect(viaAlias.statusCode).toBe(200);
    expect(viaAlias.headers['x-thinkflow-provider']).toBe('groq');
  });

  it('lists combos and connection models on /v1/models and estimates tokens', async () => {
    t = await createTestApp({ fetchFn: fakeFetch([]).fn });
    await seed(t);
    const models = await t.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { 'x-api-key': t.apiKey },
    });
    const ids = (models.json().data as { id: string }[]).map((m) => m.id);
    expect(ids.slice(0, 2)).toEqual(['auto', 'thinkflow/default']);
    expect(ids).toContain('groq/llama-3.3-70b-versatile');
    const count = await t.app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { 'x-api-key': t.apiKey },
      payload: { model: 'x', messages: [{ role: 'user', content: 'a'.repeat(400) }] },
    });
    expect(count.json().input_tokens).toBeGreaterThan(90);
  });

  it('tests a connection by listing its models and making a 1-token chat call', async () => {
    const fetch = fakeFetch([
      {
        match: (url) => url === 'https://api.groq.com/openai/v1/models',
        respond: () => jsonResponse({ data: [{ id: 'b' }, { id: 'a' }] }),
      },
      {
        match: (url) => url === 'https://api.groq.com/openai/v1/chat/completions',
        respond: () =>
          jsonResponse({ choices: [{ message: { content: 'oi' } }] }, 200, {
            'x-ratelimit-limit-requests': '1000',
            'x-ratelimit-remaining-requests': '999',
            'x-ratelimit-reset-requests': '1m26.4s',
          }),
      },
    ]);
    t = await createTestApp({ fetchFn: fetch.fn });
    const { a } = await seed(t);
    const res = await t.api<{ ok: boolean; models: string[]; quota: unknown[] }>(
      'POST',
      `/api/connections/${a.id}/test`,
    );
    expect(res.json).toMatchObject({
      ok: true,
      models: ['a', 'b'],
      usageToday: { requests: 0, tokens: 0 },
    });
    expect(res.json.quota).toMatchObject([{ metric: 'requests', window: 'day', limit: 1000 }]);
    expect(fetch.calls[0]?.headers.authorization).toBe('Bearer gsk_a');
    expect(fetch.calls[1]?.body).toMatchObject({ max_tokens: 1 });
    // the card (GET /api/connections) now carries the quota that was just learned
    const list = await t.api<{ id: string; quota: unknown[] }[]>('GET', '/api/connections');
    expect(list.json.find((c) => c.id === a.id)?.quota).toHaveLength(1);
  });
});
