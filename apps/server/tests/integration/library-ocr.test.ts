import type {
  ConnectionDto,
  LibraryDetailDto,
  LibraryDto,
  LibrarySearchResultDto,
  UsageReportDto,
} from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeFetch, jsonResponse, multipartBody, openAIFrames, sseResponse } from '../helpers';
import { makePdf, PNG_1X1 } from '../library/library-fixtures';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const localOcr = (calls: { n: number }) => ({
  method: 'ocr-local' as const,
  recognize: async () => {
    calls.n++;
    return 'Texto local: prazo de 10 dias';
  },
});

async function setup(respond: () => Response, calls = { n: 0 }) {
  const fetch = fakeFetch([{ match: (url) => url === GROQ, respond }]);
  t = await createTestApp({ fetchFn: fetch.fn, ocrEngine: localOcr(calls) });
  expect(
    (
      await t.api<ConnectionDto>('POST', '/api/connections', {
        providerId: 'groq',
        name: 'groq-a',
        apiKey: 'gsk_a',
      })
    ).status,
  ).toBe(201);
  await t.api('POST', '/api/combos', {
    name: 'ocr-vision',
    targets: [{ providerId: 'groq', model: 'llama-3.2-90b-vision' }],
  });
  const lib = (await t.api<LibraryDto>('POST', '/api/libraries', { name: 'Scans' })).json;
  return { lib, fetch, calls };
}

async function upload(libraryId: string, name: string, bytes: Uint8Array) {
  const body = await multipartBody([{ name, bytes }]);
  const res = await t!.app.inject({
    method: 'POST',
    url: `/api/libraries/${libraryId}/documents`,
    headers: { cookie: t!.cookie, ...body.headers },
    payload: body.payload,
  });
  expect(res.statusCode).toBe(201);
  await t!.container.library.whenIdle();
  return (await t!.api<LibraryDetailDto>('GET', `/api/libraries/${libraryId}`)).json.documents[0]!;
}

const useVision = () =>
  t!.api('PUT', '/api/library/settings', { ocr: 'vision', ocrModel: 'ocr-vision' });

describe('library OCR', () => {
  it('uses the local engine by default and makes the text searchable', async () => {
    const { lib, calls } = await setup(() => sseResponse(openAIFrames('nunca')));
    const doc = await upload(lib.id, 'scan.png', PNG_1X1);
    expect(doc).toMatchObject({ status: 'ready', extraction: 'ocr-local' });
    expect(calls.n).toBe(1);
    const hits = (
      await t!.api<LibrarySearchResultDto>('GET', `/api/libraries/${lib.id}/search?q=prazo`)
    ).json.hits;
    expect(hits[0]!.documentName).toBe('scan.png');
  });

  it('vision mode sends the image through the router and records library-ocr usage', async () => {
    const { lib, fetch, calls } = await setup(() =>
      sseResponse(openAIFrames('Contrato assinado em 2026', { usage: true })),
    );
    await useVision();
    const doc = await upload(lib.id, 'scan.png', PNG_1X1);
    expect(doc).toMatchObject({ status: 'ready', extraction: 'ocr-vision' });
    expect(calls.n).toBe(0);

    const body = fetch.calls[0]!.body as {
      model: string;
      messages: { content: { type: string; image_url?: { url: string } }[] }[];
    };
    expect(body.model).toBe('llama-3.2-90b-vision');
    const parts = body.messages[0]!.content;
    expect(parts.find((p) => p.type === 'image_url')!.image_url!.url).toMatch(
      /^data:image\/png;base64,/,
    );

    const hits = (
      await t!.api<LibrarySearchResultDto>('GET', `/api/libraries/${lib.id}/search?q=contrato`)
    ).json.hits;
    expect(hits).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 20));
    const usage = (await t!.api<UsageReportDto>('GET', '/api/usage')).json;
    const ocr = usage.bySource.find((s) => s.source === 'library-ocr');
    expect(ocr).toMatchObject({ requests: 1, totalTokens: 17 });
  });

  it('falls back to local OCR when the vision provider fails', async () => {
    const { lib, calls } = await setup(() => jsonResponse({ error: { message: 'boom' } }, 500));
    await useVision();
    const doc = await upload(lib.id, 'scan.png', PNG_1X1);
    expect(doc).toMatchObject({ status: 'ready', extraction: 'ocr-local' });
    expect(calls.n).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    const usage = (await t!.api<UsageReportDto>('GET', '/api/usage')).json;
    expect(usage.bySource.find((s) => s.source === 'library-ocr')?.requests).toBeGreaterThan(0);
  });

  it('treats "(sem texto)" from the vision model as an empty image', async () => {
    const { lib } = await setup(() => sseResponse(openAIFrames('(sem texto)')));
    await useVision();
    const doc = await upload(lib.id, 'vazia.png', PNG_1X1);
    expect(doc).toMatchObject({
      status: 'error',
      error: 'Nenhum texto reconhecido na imagem',
    });
  });

  it('fails images with an accurate message when OCR is off', async () => {
    const { lib, calls } = await setup(() => sseResponse(openAIFrames('nunca')));
    await t!.api('PUT', '/api/library/settings', { ocr: 'off' });
    const doc = await upload(lib.id, 'scan.png', PNG_1X1);
    expect(doc).toMatchObject({
      status: 'error',
      error: 'OCR desativado em Biblioteca → Configurações',
    });
    expect(calls.n).toBe(0);

    // turning OCR back on and reindexing recovers the document
    await t!.api('PUT', '/api/library/settings', { ocr: 'local' });
    const re = await t!.api('POST', `/api/libraries/${lib.id}/documents/${doc.id}/reindex`);
    expect(re.status).toBe(202);
    await t!.container.library.whenIdle();
    const detail = (await t!.api<LibraryDetailDto>('GET', `/api/libraries/${lib.id}`)).json;
    expect(detail.documents[0]).toMatchObject({ status: 'ready', extraction: 'ocr-local' });
  });

  it('indexes a scanned PDF through the OCR engine', async () => {
    const { lib, calls } = await setup(() => sseResponse(openAIFrames('nunca')));
    const doc = await upload(lib.id, 'digitalizado.pdf', await makePdf(['', '']));
    expect(doc).toMatchObject({ status: 'ready', extraction: 'ocr-local', pageCount: 2 });
    expect(calls.n).toBe(2);
  });
});
