import type {
  ConversationDetailDto,
  LibraryDetailDto,
  LibraryDocumentDto,
  LibraryDto,
  LibrarySearchResultDto,
  NotebookLmSettingsDto,
  UsageReportDto,
} from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { NotebookLmError } from '../../src/contexts/library/domain/ports';
import { fakeFetch, multipartBody, sseResponse } from '../helpers';
import {
  FakeNotebookLmGateway,
  FakeNotebookLmProbe,
  fakeStorageState,
  proAccount,
} from '../library/notebooklm-helpers';
import { createTestApp, sseEvents, type TestApp } from './test-app';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const TOOL = 'buscar_na_biblioteca';
const NLM = '/api/library/notebooklm';
const DOC_TEXT =
  '# Aprovação\n\nO prazo de aprovação é de 5 dias úteis para qualquer solicitação.\n';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** Fails the first `n` `waitSourceReady` calls with a timeout, like a slow import. */
class SlowSourceGateway extends FakeNotebookLmGateway {
  waits = 0;
  constructor(public slow: number) {
    super();
  }
  override async waitSourceReady() {
    this.waits += 1;
    if (this.waits <= this.slow) throw new NotebookLmError('timeout', 'ainda processando');
    await super.waitSourceReady();
  }
}

async function configure(overrides: Parameters<typeof createTestApp>[0] = {}) {
  const gw =
    (overrides.notebookLmGateway as FakeNotebookLmGateway | undefined) ??
    new FakeNotebookLmGateway();
  t = await createTestApp({ notebookLmGateway: gw, ...overrides });
  const res = await t.api('PUT', NLM, { authJson: fakeStorageState(), enabled: true });
  expect(res.status).toBe(200);
  return gw;
}

const createLibrary = (name = 'Regras remotas', extra: object = {}) =>
  t!.api<LibraryDto & { error?: { code: string } }>('POST', '/api/libraries', {
    name,
    engine: 'notebooklm',
    acceptRemoteUpload: true,
    ...extra,
  });

async function upload(libraryId: string, files = [{ name: 'regras.md', bytes: DOC_TEXT }]) {
  const body = await multipartBody(files);
  const res = await t!.app.inject({
    method: 'POST',
    url: `/api/libraries/${libraryId}/documents`,
    headers: { cookie: t!.cookie, ...body.headers },
    payload: body.payload,
  });
  await t!.container.library.whenIdle();
  return res;
}

const detail = async (id: string) =>
  (await t!.api<LibraryDetailDto>('GET', `/api/libraries/${id}`)).json;
const search = async (id: string, q: string) =>
  (
    await t!.api<LibrarySearchResultDto>(
      'GET',
      `/api/libraries/${id}/search?q=${encodeURIComponent(q)}`,
    )
  ).json;

describe('NotebookLM libraries: creation', () => {
  it('refuses when NotebookLM is not configured, and without the remote-upload consent', async () => {
    t = await createTestApp({ notebookLmGateway: new FakeNotebookLmGateway() });
    const notConfigured = await createLibrary();
    expect(notConfigured.status).toBe(400);
    expect(notConfigured.json.error?.code).toBe('notebooklm_not_configured');

    await t.api('PUT', NLM, { authJson: fakeStorageState(), enabled: true });
    const noConsent = await createLibrary('Sem aceite', { acceptRemoteUpload: false });
    expect(noConsent.status).toBe(400);
    expect(noConsent.json.error?.code).toBe('remote_upload_not_accepted');
    expect((await t.api<LibraryDto[]>('GET', '/api/libraries')).json).toEqual([]);
  });

  it('refuses when the integration is configured but switched off', async () => {
    t = await createTestApp({ notebookLmGateway: new FakeNotebookLmGateway() });
    await t.api('PUT', NLM, { authJson: fakeStorageState(), enabled: true });
    await t.api('PUT', NLM, { enabled: false });
    expect((await createLibrary()).json.error?.code).toBe('notebooklm_not_configured');
  });

  it('creates the notebook and stores its id', async () => {
    const gw = await configure();
    const res = await createLibrary();
    expect(res.status).toBe(201);
    expect(res.json.engine).toBe('notebooklm');
    expect(res.json.remoteNotebookId).toMatch(/^nb_/);
    expect([...gw.notebooks.values()]).toEqual(['Thinkflow — Regras remotas']);
  });

  it('maps an upstream failure to 502 notebooklm_<kind> (never 401) and creates nothing', async () => {
    const gw = await configure();
    gw.failNext = new NotebookLmError('auth', 'expired');
    const res = await createLibrary();
    expect(res.status).toBe(502);
    expect(res.json.error?.code).toBe('notebooklm_auth');
    expect((await t!.api<LibraryDto[]>('GET', '/api/libraries')).json).toEqual([]);
  });
});

describe('NotebookLM libraries: document sync', () => {
  it('indexes locally, then syncs the file to the notebook', async () => {
    const gw = await configure();
    const lib = (await createLibrary()).json;
    const res = await upload(lib.id);
    expect(res.statusCode).toBe(201);

    const d = (await detail(lib.id)).documents[0]!;
    expect(d.status).toBe('ready');
    expect(d.chunkCount).toBeGreaterThan(0);
    expect(d.remote).toEqual({ status: 'synced', error: null });
    expect([...gw.sources.values()]).toEqual([
      { notebookId: lib.remoteNotebookId, title: 'regras.md' },
    ]);
    expect(gw.calls).toContain('waitSourceReady');
  });

  it('waits for slow imports in short slices instead of holding the CLI for the whole time', async () => {
    const gw = new SlowSourceGateway(2);
    await configure({
      notebookLmGateway: gw,
      notebookLm: { waitSliceMs: 1000, syncTimeoutMs: 10_000 },
    });
    const lib = (await createLibrary()).json;
    await upload(lib.id);
    expect((await detail(lib.id)).documents[0]!.remote?.status).toBe('synced');
    expect(gw.waits).toBe(3);
  });

  it('gives up with a friendly error when the import never finishes', async () => {
    const gw = new SlowSourceGateway(99);
    await configure({
      notebookLmGateway: gw,
      notebookLm: { waitSliceMs: 1000, syncTimeoutMs: 3000 },
    });
    const lib = (await createLibrary()).json;
    await upload(lib.id);
    const d = (await detail(lib.id)).documents[0]!;
    expect(d.remote?.status).toBe('error');
    expect(d.remote?.error).toContain('demorou demais');
    expect(gw.waits).toBe(3);
    expect(d.status).toBe('ready'); // the local index is unaffected
  });

  it('records a sync error per document and /sync retries it', async () => {
    const gw = await configure();
    const lib = (await createLibrary()).json;
    gw.failNext = new NotebookLmError('rate_limited', 'rate limited');
    await upload(lib.id);

    let d = (await detail(lib.id)).documents[0]!;
    expect(d.status).toBe('ready');
    expect(d.remote?.status).toBe('error');
    expect(d.remote?.error).toContain('Limite de uso');

    const retry = await t!.api<LibraryDocumentDto>(
      'POST',
      `/api/libraries/${lib.id}/documents/${d.id}/sync`,
    );
    expect(retry.status).toBe(202);
    expect(retry.json.remote).toEqual({ status: 'pending', error: null });
    await t!.container.library.whenIdle();
    d = (await detail(lib.id)).documents[0]!;
    expect(d.remote).toEqual({ status: 'synced', error: null });
    expect(gw.sources.size).toBe(1);
  });

  it('a retry replaces the source left over by a failed attempt', async () => {
    const gw = new SlowSourceGateway(99);
    await configure({
      notebookLmGateway: gw,
      notebookLm: { waitSliceMs: 1000, syncTimeoutMs: 1000 },
    });
    const lib = (await createLibrary()).json;
    await upload(lib.id);
    const d = (await detail(lib.id)).documents[0]!;
    expect(d.remote?.status).toBe('error');
    expect(gw.sources.size).toBe(1);

    gw.slow = 0; // from now on the wait succeeds
    await t!.api('POST', `/api/libraries/${lib.id}/documents/${d.id}/sync`);
    await t!.container.library.whenIdle();
    expect((await detail(lib.id)).documents[0]!.remote?.status).toBe('synced');
    expect(gw.sources.size).toBe(1);
  });

  it('marks the document as error when NotebookLM is switched off, without touching the local index', async () => {
    const gw = await configure();
    const lib = (await createLibrary()).json;
    await t!.api('PUT', NLM, { enabled: false });
    await upload(lib.id);
    const d = (await detail(lib.id)).documents[0]!;
    expect(d.status).toBe('ready');
    expect(d.remote).toEqual({ status: 'error', error: 'NotebookLM não configurado' });
    expect(gw.sources.size).toBe(0);
  });

  it('/sync is only for NotebookLM libraries and unknown documents are 404', async () => {
    await configure();
    const local = (await t!.api<LibraryDto>('POST', '/api/libraries', { name: 'Local' })).json;
    await upload(local.id);
    const doc = (await detail(local.id)).documents[0]!;
    expect(
      (await t!.api('POST', `/api/libraries/${local.id}/documents/${doc.id}/sync`)).status,
    ).toBe(400);
    const lib = (await createLibrary()).json;
    expect((await t!.api('POST', `/api/libraries/${lib.id}/documents/nope/sync`)).status).toBe(404);
  });

  it('local libraries never touch the gateway', async () => {
    const gw = await configure();
    const local = (await t!.api<LibraryDto>('POST', '/api/libraries', { name: 'Local' })).json;
    await upload(local.id);
    expect((await detail(local.id)).documents[0]!.remote).toBeNull();
    expect(gw.calls.filter((c) => c !== 'check')).toEqual([]);
  });
});

describe('NotebookLM libraries: search', () => {
  async function ready() {
    const gw = await configure();
    const lib = (await createLibrary()).json;
    await upload(lib.id, [
      { name: 'regras.md', bytes: DOC_TEXT },
      { name: 'manual.md', bytes: '# Manual\n\nO manual descreve o reembolso de despesas.\n' },
    ]);
    return { gw, lib };
  }
  const usage = async () => (await t!.api<UsageReportDto>('GET', '/api/usage')).json;

  it('asks NotebookLM and returns its cited answer mapped to the document names', async () => {
    const { gw, lib } = await ready();
    const res = await search(lib.id, 'qual o prazo de aprovação?');
    expect(res.isError).toBe(false);
    expect(res.toolOutput).toContain('Resposta do NotebookLM (biblioteca «Regras remotas»)');
    expect(res.toolOutput).toContain('regras.md');
    expect(res.toolOutput).toContain('manual.md');
    expect(res.toolOutput).toContain('Trecho citado 1');
    expect(res.toolOutput).not.toContain('src_');
    expect(res.hits.map((h) => h.documentName).sort()).toEqual(['manual.md', 'regras.md']);
    expect(gw.lastAsk).toMatchObject({
      notebookId: lib.remoteNotebookId,
      question: 'qual o prazo de aprovação?',
      sourceIds: undefined, // every document is synced: no restriction
    });

    const nlm = (await usage()).bySource.find((s) => s.source === 'library-notebooklm');
    expect(nlm).toMatchObject({ requests: 1 });
  });

  it('is what the AI gets when it calls the library tool in the chat', async () => {
    const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'llama' };
    const frame = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    let n = 0;
    const script = [
      () =>
        sseResponse([
          frame({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: TOOL,
                  arguments: JSON.stringify({ consulta: 'prazo aprovação' }),
                },
              },
            ],
          }),
          frame({}, 'tool_calls'),
          'data: [DONE]\n\n',
        ]),
      () =>
        sseResponse([
          frame({ content: 'São 5 dias úteis.' }),
          frame({}, 'stop'),
          'data: [DONE]\n\n',
        ]),
    ];
    const fetch = fakeFetch([
      { match: (url) => url === GROQ, respond: () => script[Math.min(n++, 1)]!() },
    ]);
    const gw = await configure({ fetchFn: fetch.fn });
    await t!.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
    const lib = (await createLibrary()).json;
    await upload(lib.id);

    const res = await t!.app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: t!.cookie },
      payload: { model: 'groq/llama', content: 'Qual o prazo?', libraryId: lib.id, useMcp: false },
    });
    const events = sseEvents(res.body);
    expect(events.at(-1)?.type).toBe('done');
    expect(gw.lastAsk?.question).toBe('prazo aprovação');

    const second = fetch.calls[1]!.body as { messages: { role: string; content?: string }[] };
    const toolMessage = second.messages.find((m) => m.role === 'tool')!;
    expect(toolMessage.content).toContain('Resposta do NotebookLM');
    expect(toolMessage.content).toContain('regras.md');
    expect(toolMessage.content).toContain('Trecho citado 1');

    const conversationId = (events[0] as { conversationId: string }).conversationId;
    const saved = await t!.api<ConversationDetailDto>(
      'GET',
      `/api/conversations/${conversationId}`,
    );
    expect(saved.json.messages.at(-1)!.meta.toolCalls?.[0]?.output).toContain(
      'Resposta do NotebookLM',
    );
    expect(saved.json.messages.at(-1)!.meta.library).toEqual({
      id: lib.id,
      name: 'Regras remotas',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect((await usage()).bySource.find((s) => s.source === 'library-notebooklm')?.requests).toBe(
      1,
    );
  });

  it('restricts the question to the synced documents while others are not synced', async () => {
    const gw = await configure();
    const lib = (await createLibrary()).json;
    await upload(lib.id, [{ name: 'a.md', bytes: '# A\n\nprimeiro documento sobre aprovação.\n' }]);
    gw.failNext = new NotebookLmError('unavailable', 'x'); // the next sync (c.md) fails
    await upload(lib.id, [{ name: 'c.md', bytes: '# C\n\nterceiro documento sobre aprovação.\n' }]);
    const docs = (await detail(lib.id)).documents;
    expect(docs.find((d) => d.name === 'c.md')!.remote?.status).toBe('error');

    const res = await search(lib.id, 'aprovação');
    expect(res.toolOutput).toContain('a.md');
    const aId = [...gw.sources].find(([, v]) => v.title === 'a.md')![0];
    expect(gw.lastAsk?.sourceIds).toEqual([aId]);
  });

  it('falls back to the local index when NotebookLM fails (auth), and flags the credentials', async () => {
    const { lib } = await ready();
    const res = await search(lib.id, '__AUTH__ prazo aprovação');
    expect(res.isError).toBe(false);
    expect(res.toolOutput.startsWith('⚠️ NotebookLM indisponível (credenciais expiradas)')).toBe(
      true,
    );
    expect(res.toolOutput).toContain('regras.md');
    expect(res.toolOutput).toContain('5 dias úteis');
    expect(res.hits.length).toBeGreaterThan(0);

    const settings = (await t!.api<NotebookLmSettingsDto>('GET', NLM)).json;
    expect(settings.lastCheck).toMatchObject({ ok: false, message: 'Credenciais expiradas' });
    const nlm = (await usage()).bySource.find((s) => s.source === 'library-notebooklm');
    expect(nlm).toMatchObject({ requests: 1 });
  });

  it.each([
    ['__RATE__', 'limite de uso'],
    ['__TIMEOUT__', 'tempo esgotado'],
  ])('falls back on %s', async (magic, reason) => {
    const { lib } = await ready();
    const res = await search(lib.id, `${magic} prazo aprovação`);
    expect(res.toolOutput).toContain(`NotebookLM indisponível (${reason}`);
    expect(res.toolOutput).toContain('regras.md');
  });

  it('returns an error instead of local excerpts when the fallback is off', async () => {
    const { lib } = await ready();
    await t!.api('PUT', NLM, { fallbackToLocal: false });
    const res = await search(lib.id, '__AUTH__ prazo aprovação');
    expect(res.isError).toBe(true);
    expect(res.toolOutput).toContain('NotebookLM indisponível: credenciais expiradas');
    expect(res.toolOutput).not.toContain('5 dias úteis');
  });

  it('falls back once the daily limit is reached, without calling NotebookLM again', async () => {
    const { gw, lib } = await ready();
    await t!.api('PUT', NLM, { dailyQueryLimit: 1 });
    const first = await search(lib.id, 'prazo aprovação');
    expect(first.toolOutput).toContain('Resposta do NotebookLM');
    const asks = gw.calls.filter((c) => c === 'ask').length;

    const second = await search(lib.id, 'prazo aprovação');
    expect(second.toolOutput).toContain('limite diário de 1 consultas atingido');
    expect(second.toolOutput).toContain('regras.md');
    expect(gw.calls.filter((c) => c === 'ask').length).toBe(asks);
    const settings = (await t!.api<NotebookLmSettingsDto>('GET', NLM)).json;
    expect(settings.queriesToday).toBe(1);
  });

  it('falls back when nothing is synced yet and when the integration is switched off', async () => {
    const gw = await configure();
    const lib = (await createLibrary()).json;
    gw.failNext = new NotebookLmError('unavailable', 'x');
    await upload(lib.id); // sync fails: nothing synced
    const none = await search(lib.id, 'prazo aprovação');
    expect(none.toolOutput).toContain('nenhum documento sincronizado ainda');
    expect(none.toolOutput).toContain('5 dias úteis');
    expect(gw.lastAsk).toBeNull();

    await t!.api('PUT', NLM, { enabled: false });
    const off = await search(lib.id, 'prazo aprovação');
    expect(off.toolOutput).toContain('NotebookLM indisponível (não configurado)');
  });

  it('respects the output cap of the tool', async () => {
    const { lib } = await ready();
    const res = await t!.container.library.service.chatTools(lib.id, { maxOutputChars: 300 });
    const out = await res!.call(TOOL, { consulta: 'prazo aprovação' });
    expect(out.text.length).toBeLessThanOrEqual(300);
    expect(out.text).toContain('Resposta do NotebookLM');
  });
});

describe('NotebookLM libraries: deletion', () => {
  it('deleting a document removes its source; deleting the library removes the notebook', async () => {
    const gw = await configure();
    const lib = (await createLibrary()).json;
    await upload(lib.id);
    const doc = (await detail(lib.id)).documents[0]!;
    expect(gw.sources.size).toBe(1);

    expect((await t!.api('DELETE', `/api/libraries/${lib.id}/documents/${doc.id}`)).status).toBe(
      200,
    );
    expect(gw.sources.size).toBe(0);
    expect(gw.calls).toContain('deleteSource');

    expect((await t!.api('DELETE', `/api/libraries/${lib.id}`)).status).toBe(200);
    expect(gw.notebooks.size).toBe(0);
    expect(gw.calls).toContain('deleteNotebook');
  });

  it('remote failures never block local deletion', async () => {
    const gw = await configure();
    const lib = (await createLibrary()).json;
    await upload(lib.id);
    const doc = (await detail(lib.id)).documents[0]!;

    gw.failNext = new NotebookLmError('auth', 'expired');
    expect((await t!.api('DELETE', `/api/libraries/${lib.id}/documents/${doc.id}`)).status).toBe(
      200,
    );
    expect((await detail(lib.id)).documents).toEqual([]);

    gw.failNext = new NotebookLmError('unavailable', 'down');
    expect((await t!.api('DELETE', `/api/libraries/${lib.id}`)).status).toBe(200);
    expect((await t!.api('GET', `/api/libraries/${lib.id}`)).status).toBe(404);
  });

  it('a document that never reached NotebookLM is deleted without a remote call', async () => {
    const gw = await configure();
    const lib = (await createLibrary()).json;
    gw.failNext = new NotebookLmError('unavailable', 'x');
    await upload(lib.id);
    const doc = (await detail(lib.id)).documents[0]!;
    await t!.api('DELETE', `/api/libraries/${lib.id}/documents/${doc.id}`);
    expect(gw.calls).not.toContain('deleteSource');
  });
});

describe('NotebookLM libraries: account limits', () => {
  const docs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `d${i}.txt`, bytes: `texto único ${i}` }));

  it('uses the detected source limit of the account as the library limit', async () => {
    const probe = new FakeNotebookLmProbe(proAccount());
    await configure({ notebookLmProbe: probe });
    expect(probe.calls).toBe(1); // after the login/credentials were stored
    const settings = (await t!.api<NotebookLmSettingsDto>('GET', NLM)).json;
    expect(settings).toMatchObject({
      sourceLimit: 300,
      notebookLimit: 500,
      dailyQueryLimit: 500,
      detection: { sourceLimit: 300, tier: 2, planLabel: 'Pro', unavailableReason: null },
    });
    const lib = (await createLibrary()).json;
    expect(lib.maxDocuments).toBe(300);
    expect((await detail(lib.id)).maxDocuments).toBe(300);
    // local libraries keep their own limit
    const local = (await t!.api<LibraryDto>('POST', '/api/libraries', { name: 'Local' })).json;
    expect(local.maxDocuments).toBe(1000);
  });

  it('stops uploads at the account limit with a clear message', async () => {
    await configure({
      notebookLmProbe: new FakeNotebookLmProbe({
        ok: true,
        limits: { sourceLimit: 2, notebookLimit: 10, tier: null },
      }),
    });
    const lib = (await createLibrary()).json;
    expect(lib.maxDocuments).toBe(2);
    const res = await upload(lib.id, docs(3));
    const result = res.json() as { accepted: unknown[]; rejected: { reason: string }[] };
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected[0]!.reason).toBe(
      'A conta do NotebookLM permite no máximo 2 fontes por notebook',
    );
  });

  it('falls back to the chosen plan, then to Free, when the account does not report limits', async () => {
    await configure({
      notebookLmProbe: new FakeNotebookLmProbe({ ok: false, reason: 'Detecção indisponível.' }),
    });
    let lib = (await createLibrary('Gratuita')).json;
    expect(lib.maxDocuments).toBe(50);
    const settings = (await t!.api<NotebookLmSettingsDto>('GET', NLM)).json;
    expect(settings.detection.unavailableReason).toBe('Detecção indisponível.');

    await t!.api('PUT', NLM, { plan: 'plus' });
    lib = (await createLibrary('Plus')).json;
    expect(lib.maxDocuments).toBe(100);
    expect((await t!.api<NotebookLmSettingsDto>('GET', NLM)).json.dailyQueryLimit).toBe(200);
  });

  it('learns the limit from a source-limit error, shows it and does not retry', async () => {
    const gw = new FakeNotebookLmGateway();
    await configure({ notebookLmGateway: gw });
    const lib = (await createLibrary()).json;
    expect(lib.maxDocuments).toBe(50);
    gw.failNext = new NotebookLmError(
      'source_limit',
      'A conta do NotebookLM permite no máximo 40 fontes por notebook',
      40,
    );
    await upload(lib.id, docs(1));
    const adds = gw.calls.filter((c) => c === 'addSource').length;
    const d = await detail(lib.id);
    expect(d.documents[0]!.remote).toEqual({
      status: 'error',
      error: 'A conta do NotebookLM permite no máximo 40 fontes por notebook',
    });
    expect(d.maxDocuments).toBe(40);
    await t!.container.library.whenIdle();
    expect(gw.calls.filter((c) => c === 'addSource').length).toBe(adds);
    expect((await t!.api<NotebookLmSettingsDto>('GET', NLM)).json.sourceLimit).toBe(40);
  });

  it('explains the limit even when the service does not say a number', async () => {
    const gw = new FakeNotebookLmGateway();
    await configure({ notebookLmGateway: gw });
    const lib = (await createLibrary()).json;
    gw.failNext = new NotebookLmError('source_limit', 'x');
    await upload(lib.id, docs(1));
    expect((await detail(lib.id)).documents[0]!.remote?.error).toBe(
      'A conta do NotebookLM permite no máximo 50 fontes por notebook',
    );
    expect((await detail(lib.id)).maxDocuments).toBe(50);
  });
});
