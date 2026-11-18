import { afterEach, describe, expect, it } from 'vitest';
import type { SettingsDto } from '@thinkflow/shared';
import { fakeFetch, openAIFrames, sseResponse } from '../helpers';
import { createTestApp, sseEvents, type TestApp } from './test-app';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const PRESIDIO = 'http://presidio:3000';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const NAME = 'maria aparecida souza';

async function chat(app: TestApp, content: string) {
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { cookie: app.cookie },
    payload: { model: 'groq/llama', content },
  });
  return sseEvents(res.body);
}

describe('Presidio sidecar', () => {
  it('tokenizes a lowercase name only the sidecar finds', async () => {
    const fetch = fakeFetch([
      {
        match: (u) => u === `${PRESIDIO}/analyze`,
        respond: () =>
          new Response(
            JSON.stringify([
              { entity_type: 'PERSON', start: 9, end: 9 + NAME.length, score: 0.85 },
            ]),
          ),
      },
      { match: (u) => u === GROQ, respond: () => sseResponse(openAIFrames('ok')) },
    ]);
    t = await createTestApp({ fetchFn: fetch.fn });
    await t.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
    await t.api('PUT', '/api/settings', { privacy: { presidioUrl: PRESIDIO } });
    await chat(t, `Cliente: ${NAME} pediu retorno`);
    const sent = JSON.stringify(fetch.calls.find((c) => c.url === GROQ)!.body);
    expect(sent).not.toContain(NAME);
    expect(sent).toContain('[NOME_1]');
  });

  it('keeps working (native only) when the sidecar is down', async () => {
    const fetch = fakeFetch([
      {
        match: (u) => u === `${PRESIDIO}/analyze`,
        respond: () => new Response('boom', { status: 500 }),
      },
      { match: (u) => u === GROQ, respond: () => sseResponse(openAIFrames('ok')) },
    ]);
    t = await createTestApp({ fetchFn: fetch.fn });
    await t.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
    await t.api('PUT', '/api/settings', { privacy: { presidioUrl: PRESIDIO } });
    await chat(t, 'CPF 529.982.247-25 do cliente');
    const sent = JSON.stringify(fetch.calls.find((c) => c.url === GROQ)!.body);
    expect(sent).not.toContain('529.982.247-25');
    expect(sent).toContain('[CPF_1]');
  });

  it('GET /api/settings/privacy/presidio: not configured / reachable / unreachable', async () => {
    let up = true;
    const fetch = fakeFetch([
      {
        match: (u) => u === `${PRESIDIO}/health`,
        respond: () => {
          if (!up) throw new TypeError('fetch failed');
          return new Response('Presidio Analyzer service is up');
        },
      },
    ]);
    t = await createTestApp({ fetchFn: fetch.fn });
    const probe = () =>
      t!.api<{ configured: boolean; reachable: boolean; latencyMs?: number; error?: string }>(
        'GET',
        '/api/settings/privacy/presidio',
      );
    expect((await probe()).json).toEqual({ configured: false, reachable: false });

    const saved = await t.api<SettingsDto>('PUT', '/api/settings', {
      privacy: { presidioUrl: PRESIDIO },
    });
    expect(saved.json.privacy.presidioUrl).toBe(PRESIDIO);
    const ok = (await probe()).json;
    expect(ok).toMatchObject({ configured: true, reachable: true });
    expect(typeof ok.latencyMs).toBe('number');

    up = false;
    const down = (await probe()).json;
    expect(down).toMatchObject({ configured: true, reachable: false });
    expect(down.error).toBeTruthy();
  });
});
