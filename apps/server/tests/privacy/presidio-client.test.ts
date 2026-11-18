import { describe, expect, it } from 'vitest';
import {
  chunkText,
  createPresidioSpans,
  probePresidio,
  type PresidioFetch,
} from '../../src/contexts/privacy/infrastructure/presidio-client';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function recorder(reply: (body: Record<string, unknown>) => Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch: PresidioFetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body });
    return reply(body);
  };
  return { fetch, calls };
}

describe('createPresidioSpans', () => {
  it('posts text, language and the score threshold, mapping entities to kinds', async () => {
    const r = recorder(() =>
      json([
        { entity_type: 'PERSON', start: 0, end: 5, score: 0.85 },
        { entity_type: 'LOCATION', start: 6, end: 10, score: 0.8 },
        { entity_type: 'EMAIL_ADDRESS', start: 11, end: 12, score: 1 },
        { entity_type: 'PHONE_NUMBER', start: 12, end: 13, score: 0.7 },
        { entity_type: 'CREDIT_CARD', start: 13, end: 14, score: 0.9 },
        { entity_type: 'BR_CPF', start: 14, end: 15, score: 1 },
        { entity_type: 'BR_CNPJ', start: 15, end: 16, score: 1 },
        { entity_type: 'BR_NIS', start: 16, end: 17, score: 1 },
        { entity_type: 'BR_TITULO_ELEITOR', start: 17, end: 18, score: 1 },
        { entity_type: 'DATE_TIME', start: 0, end: 5, score: 0.9 },
        { entity_type: 'URL', start: 0, end: 5, score: 0.9 },
        { entity_type: 'BR_CNJ', start: 0, end: 5, score: 0.9 },
      ]),
    );
    const detect = createPresidioSpans({
      url: 'http://presidio:3000/',
      minScore: 0.6,
      fetch: r.fetch,
    });
    const spans = await detect('maria aparecida souza, mora la');
    expect(r.calls[0]).toEqual({
      url: 'http://presidio:3000/analyze',
      body: { text: 'maria aparecida souza, mora la', language: 'pt', score_threshold: 0.6 },
    });
    expect(spans.map((s) => s.kind)).toEqual([
      'NOME',
      'ENDERECO',
      'EMAIL',
      'TELEFONE',
      'CARTAO',
      'CPF',
      'CNPJ',
      'PIS',
      'TITULO',
    ]);
    expect(spans.every((s) => s.source === 'presidio')).toBe(true);
  });

  it('drops results under the threshold and malformed ones', async () => {
    const r = recorder(() =>
      json([
        { entity_type: 'PERSON', start: 0, end: 5, score: 0.3 },
        { entity_type: 'PERSON', start: 5, end: 5, score: 0.9 },
        { entity_type: 'PERSON', start: 'a', end: 9, score: 0.9 },
        { entity_type: 'PERSON', start: 1, end: 4, score: 0.9 },
      ]),
    );
    const spans = await createPresidioSpans({ url: 'http://p', minScore: 0.5, fetch: r.fetch })(
      'abcdefghij',
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 1, end: 4, kind: 'NOME' });
  });

  it('skips tiny texts without calling the sidecar', async () => {
    const r = recorder(() => json([]));
    const detect = createPresidioSpans({ url: 'http://p', minScore: 0.5, fetch: r.fetch });
    expect(await detect(' a ')).toEqual([]);
    expect(r.calls).toHaveLength(0);
  });

  it('rejects on HTTP errors and on timeout (so the firewall degrades)', async () => {
    const bad = createPresidioSpans({
      url: 'http://p',
      minScore: 0.5,
      fetch: async () => json({ error: 'x' }, 500),
    });
    await expect(bad('texto qualquer')).rejects.toThrow(/500/);

    const hang: PresidioFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    const slow = createPresidioSpans({
      url: 'http://p',
      minScore: 0.5,
      timeoutMs: 20,
      fetch: hang,
    });
    await expect(slow('texto qualquer')).rejects.toThrow(/abort/);
  });

  it('chunks huge texts on whitespace and corrects the offsets', async () => {
    const word = 'palavra ';
    const text = word.repeat(30) + 'MARIA ' + word.repeat(30);
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((c) => c.text).join('')).toBe(text);
    for (const c of chunks) expect(text.slice(c.offset, c.offset + c.text.length)).toBe(c.text);

    // fake analyzer finds "MARIA" wherever it is inside the chunk it receives
    const r = recorder((body) => {
      const t = String(body.text);
      const i = t.indexOf('MARIA');
      return json(i < 0 ? [] : [{ entity_type: 'PERSON', start: i, end: i + 5, score: 0.9 }]);
    });
    const big = createPresidioSpans({ url: 'http://p', minScore: 0.5, fetch: r.fetch });
    // use the real limit: build a text over 100k chars
    const huge = 'x '.repeat(60_000) + 'MARIA ' + 'y '.repeat(10);
    const spans = await big(huge);
    expect(r.calls.length).toBeGreaterThan(1);
    expect(spans).toHaveLength(1);
    expect(huge.slice(spans[0]!.start, spans[0]!.end)).toBe('MARIA');
  });
});

describe('probePresidio', () => {
  it('reports not configured / reachable / unreachable', async () => {
    expect(await probePresidio('  ')).toEqual({ configured: false, reachable: false });
    const ok = await probePresidio('http://p:3000/', async (url) => {
      expect(url).toBe('http://p:3000/health');
      return new Response('up');
    });
    expect(ok).toMatchObject({ configured: true, reachable: true });
    const down = await probePresidio('http://p', async () => {
      throw new TypeError('fetch failed');
    });
    expect(down).toMatchObject({ configured: true, reachable: false });
    expect(down.error).toBeTruthy();
    const http = await probePresidio('http://p', async () => new Response('x', { status: 503 }));
    expect(http).toMatchObject({ reachable: false, error: 'HTTP 503' });
  });
});
