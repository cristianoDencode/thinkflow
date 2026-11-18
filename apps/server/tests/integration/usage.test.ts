import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionDto, UsageMonthsDto, UsageReportDto } from '@thinkflow/shared';
import { fakeFetch, openAIFrames, sseResponse } from '../helpers';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';

async function setup(usage: boolean) {
  const fetch = fakeFetch([
    { match: (url) => url === GROQ, respond: () => sseResponse(openAIFrames('olá', { usage })) },
  ]);
  t = await createTestApp({ fetchFn: fetch.fn });
  const c = await t.api<ConnectionDto>('POST', '/api/connections', {
    providerId: 'groq',
    name: 'groq-a',
    apiKey: 'gsk_a',
  });
  expect(c.status).toBe(201);
  await t.api('POST', '/api/combos', {
    name: 'thinkflow/default',
    targets: [{ providerId: 'groq', model: 'llama-3.3-70b-versatile' }],
  });
  return t;
}

async function ask(app: TestApp, content = 'oi') {
  const res = await app.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${app.apiKey}` },
    payload: { model: 'thinkflow/default', messages: [{ role: 'user', content }] },
  });
  expect(res.statusCode).toBe(200);
  await new Promise((r) => setTimeout(r, 20));
}

describe('usage', () => {
  it('requires a session', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/usage' });
    expect(res.statusCode).toBe(401);
  });

  it('is empty before any request', async () => {
    t = await createTestApp();
    const r = await t.api<UsageReportDto>('GET', '/api/usage');
    expect(r.json.totals.totalTokens).toBe(0);
    expect(r.json.daily.length).toBe(r.json.daysInMonth);
    expect(r.json.budget).toBeNull();
    expect(r.json.previous).toBeNull();
  });

  it('sums tokens reported by the provider', async () => {
    const app = await setup(true);
    await ask(app);
    await ask(app);
    const r = (await app.api<UsageReportDto>('GET', '/api/usage')).json;
    expect(r.totals).toMatchObject({
      requests: 2,
      failures: 0,
      inputTokens: 24,
      outputTokens: 10,
      totalTokens: 34,
      estimatedRequests: 0,
    });
    expect(r.byProvider[0]).toMatchObject({ providerId: 'groq', requests: 2 });
    expect(r.byModel[0]).toMatchObject({ model: 'llama-3.3-70b-versatile' });
    expect(r.bySource[0]).toMatchObject({ totalTokens: 34 });
    expect(r.projection.daily).toBeGreaterThan(0);

    const months = (await app.api<UsageMonthsDto>('GET', '/api/usage/months')).json;
    expect(months.months).toContain(r.month);
    expect(months.current).toBe(r.month);
  });

  it('estimates tokens when the provider sends no usage', async () => {
    const app = await setup(false);
    await ask(app, 'uma pergunta um pouco mais longa para estimar tokens');
    const r = (await app.api<UsageReportDto>('GET', '/api/usage')).json;
    expect(r.totals.requests).toBe(1);
    expect(r.totals.estimatedRequests).toBe(1);
    expect(r.totals.inputTokens).toBeGreaterThan(0);
  });

  it('counts failed requests without tokens', async () => {
    t = await createTestApp();
    await t.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${t.apiKey}` },
      payload: { model: 'nao/existe', messages: [] },
    });
    await new Promise((r) => setTimeout(r, 20));
    const r = (await t.api<UsageReportDto>('GET', '/api/usage')).json;
    expect(r.totals).toMatchObject({ requests: 1, failures: 1, totalTokens: 0 });
  });

  it('stores a monthly budget and reports percentages', async () => {
    const app = await setup(true);
    await ask(app);
    const r = await app.api<UsageReportDto>('PUT', '/api/usage/budget', { monthlyTokens: 170 });
    expect(r.status).toBe(200);
    expect(r.json.budget).toMatchObject({ monthlyTokens: 170, usedPct: 10 });
    const off = await app.api<UsageReportDto>('PUT', '/api/usage/budget', { monthlyTokens: 0 });
    expect(off.json.budget).toBeNull();
    const bad = await app.api('PUT', '/api/usage/budget', { monthlyTokens: -1 });
    expect(bad.status).toBe(400);
  });

  it('rejects an invalid month', async () => {
    t = await createTestApp();
    const r = await t.api('GET', '/api/usage?month=2026-13');
    expect(r.status).toBe(400);
  });
});
