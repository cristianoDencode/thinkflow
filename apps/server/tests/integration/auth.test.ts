import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { openDatabase } from '../../src/shared/infrastructure/db/client';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('identity', () => {
  it('requires setup on a fresh install', async () => {
    const handle = openDatabase(':memory:');
    const { app } = await buildApp({ config: loadConfig({}), db: handle.db, secret: 's' });
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.json()).toEqual({ setupRequired: true, authenticated: false, user: null });
    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { name: 'x', password: '123' },
    });
    expect(weak.statusCode).toBe(400);
    await app.close();
    handle.close();
  });

  it('protects the dashboard API with a session cookie', async () => {
    t = await createTestApp();
    expect((await t.app.inject({ method: 'GET', url: '/api/connections' })).statusCode).toBe(401);
    expect((await t.api('GET', '/api/connections')).status).toBe(200);
    const status = await t.api<{ authenticated: boolean; user: { name: string } }>(
      'GET',
      '/api/auth/status',
    );
    expect(status.json.authenticated).toBe(true);
    expect(status.json.user.name).toBe('Alex');
  });

  it('rejects a wrong password and accepts the right one', async () => {
    t = await createTestApp();
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'nope' },
    });
    expect(bad.statusCode).toBe(401);
    const good = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'senha-forte-123' },
    });
    expect(good.statusCode).toBe(200);
    expect(good.headers['set-cookie']).toBeDefined();
  });

  it('guards /v1 with API keys (Bearer or x-api-key) and supports revocation', async () => {
    t = await createTestApp();
    expect((await t.app.inject({ method: 'GET', url: '/v1/models' })).statusCode).toBe(401);
    const bearer = await t.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${t.apiKey}` },
    });
    expect(bearer.statusCode).toBe(200);
    const header = await t.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { 'x-api-key': t.apiKey },
    });
    expect(header.statusCode).toBe(200);

    const keys = await t.api<{ id: string; prefix: string }[]>('GET', '/api/api-keys');
    expect(keys.json[0]?.prefix).toBe(t.apiKey.slice(0, 10));
    await t.api('DELETE', `/api/api-keys/${keys.json[0]!.id}`);
    expect(
      (await t.app.inject({ method: 'GET', url: '/v1/models', headers: { 'x-api-key': t.apiKey } }))
        .statusCode,
    ).toBe(401);
  });

  it('returns 404 JSON for unknown API routes', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
  });
});
