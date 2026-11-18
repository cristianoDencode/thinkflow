import type { TestSessionDto, TestSessionSummaryDto, TestSupportDto } from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { RECORDING_UNSUPPORTED_MESSAGE } from '../../src/contexts/testing/application/test-session-service';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BASE = '/api/tests/sessions';

describe('test sessions API', () => {
  it('creates, lists, updates and deletes a session', async () => {
    t = await createTestApp();
    const created = await t.api<TestSessionDto>('POST', BASE, {
      name: 'Cadastro de contribuinte',
      startUrl: 'https://homolog.exemplo.gov.br/login',
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      name: 'Cadastro de contribuinte',
      state: 'idle',
      stepCount: 0,
      imageCount: 0,
      mode: null,
      lastRun: null,
      warning: null,
      definition: {
        schemaVersion: 1,
        viewport: { width: 1366, height: 768 },
        autoThumbnails: true,
        parameters: [],
        dataSets: [{ id: 'recorded', name: 'Gravado', values: {} }],
        steps: [],
      },
    });
    const id = created.json.id;

    const list = await t.api<TestSessionSummaryDto[]>('GET', BASE);
    expect(list.json.map((s) => s.id)).toEqual([id]);

    const patched = await t.api<TestSessionDto>('PATCH', `${BASE}/${id}`, {
      name: 'Cadastro (v2)',
      autoThumbnails: false,
    });
    expect(patched.json).toMatchObject({
      name: 'Cadastro (v2)',
      definition: { autoThumbnails: false },
    });

    expect((await t.api('DELETE', `${BASE}/${id}`)).status).toBe(200);
    expect((await t.api('GET', `${BASE}/${id}`)).status).toBe(404);
  });

  it('validates the input in pt-BR', async () => {
    t = await createTestApp();
    const bad = await t.api<{ error: { message: string } }>('POST', BASE, {
      name: 'x',
      startUrl: 'ftp://exemplo',
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain('http');
    expect((await t.api('POST', BASE, { name: '', startUrl: 'https://a.b' })).status).toBe(400);
  });

  it('serves only images of the session, and deletes them with it', async () => {
    t = await createTestApp();
    const { json: s } = await t.api<TestSessionDto>('POST', BASE, {
      name: 'a',
      startUrl: 'https://a.b',
    });
    const { json: other } = await t.api<TestSessionDto>('POST', BASE, {
      name: 'b',
      startUrl: 'https://a.b',
    });
    await t.store.put(`tests/${s.id}/steps/s1.jpg`, new Uint8Array([1, 2]), {
      contentType: 'image/jpeg',
    });
    const res = await t.app.inject({
      method: 'GET',
      url: `${BASE}/${s.id}/images/steps/s1.jpg`,
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect([...res.rawPayload]).toEqual([1, 2]);

    // another session's id in the path never reaches this session's keys
    const cross = await t.app.inject({
      method: 'GET',
      url: `${BASE}/${other.id}/images/../${s.id}/steps/s1.jpg`,
      headers: { cookie: t.cookie },
    });
    expect(cross.statusCode).toBe(404);
    const svg = await t.app.inject({
      method: 'GET',
      url: `${BASE}/${s.id}/images/steps/x.svg`,
      headers: { cookie: t.cookie },
    });
    expect(svg.statusCode).toBe(404);

    expect((await t.api('DELETE', `${BASE}/${s.id}`)).status).toBe(200);
    expect(await t.store.head(`tests/${s.id}/steps/s1.jpg`)).toBeNull();
  });

  it('requires authentication', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: BASE });
    expect(res.statusCode).toBe(401);
  });

  it('reports whether a browser window can be opened', async () => {
    t = await createTestApp();
    expect((await t.api<TestSupportDto>('GET', '/api/tests/support')).json).toEqual({
      recording: { supported: true, message: '' },
    });
    await t.close();
    t = await createTestApp({ tests: { display: { canOpenWindow: () => false } } });
    expect((await t.api<TestSupportDto>('GET', '/api/tests/support')).json).toEqual({
      recording: { supported: false, message: RECORDING_UNSUPPORTED_MESSAGE },
    });
  });
});
