import JSZip from 'jszip';
import type { CtOneDriveResultDto, CtStateDto, TestSessionDto } from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { PdfRenderer } from '../../src/contexts/reports/domain/render-ports';
import {
  driveItem,
  FakeMicrosoft,
  jsonResponse,
  ME,
  TOKEN_URL,
  tokenResponse,
} from '../onedrive/fake-microsoft';
import { CLIENT_ID, GRAPH_ME, REDIRECT } from '../onedrive/harness';
import {
  buttonFacts,
  FakeRecorderBrowser,
  fieldFacts,
  instantSettler,
} from '../testing/fake-recorder';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BASE = '/api/tests/sessions';

class FakePdf implements PdfRenderer {
  htmls: string[] = [];
  fail = false;
  async status() {
    return { available: true } as never;
  }
  async pdf(html: string) {
    if (this.fail) throw new Error('Chromium não encontrado');
    this.htmls.push(html);
    return new TextEncoder().encode('%PDF-1.4 fake');
  }
}

/** goto + fill + fill + click, each with its automatic print; recording stopped. */
async function recorded(overrides: Parameters<typeof createTestApp>[0] = {}) {
  const recorder = new FakeRecorderBrowser();
  t = await createTestApp({ ...overrides, tests: { recorder, settler: instantSettler } });
  const created = await t.api<TestSessionDto>('POST', BASE, {
    name: 'Cálculo da taxa',
    startUrl: 'https://a.b/login',
  });
  const id = created.json.id;
  await t.api('POST', `${BASE}/${id}/record/start`);
  recorder.emit({ type: 'fill', facts: fieldFacts('Código'), value: '123', at: 1 });
  recorder.emit({ type: 'fill', facts: fieldFacts('Valor'), value: '10', at: 2 });
  recorder.emit({ type: 'click', facts: buttonFacts('Calcular'), at: 3 });
  await t.container.tests.recording.whenIdle();
  await t.api('POST', `${BASE}/${id}/record/stop`);
  // automatic prints start out of the document: turn them all on, as the person would
  const recordedSession = (await t.api<TestSessionDto>('GET', `${BASE}/${id}`)).json;
  for (const image of Object.values(recordedSession.images)) {
    await t.api('PATCH', `${BASE}/${id}/evidences/${image.id}`, { include: true });
  }
  const session = (await t.api<TestSessionDto>('GET', `${BASE}/${id}`)).json;
  return { id, session };
}

const get = (url: string) => t!.app.inject({ method: 'GET', url, headers: { cookie: t!.cookie } });

describe('CT document: fields and use cases', () => {
  it('returns the defaults, then saves fields, use-case info and keeps them', async () => {
    const { id, session } = await recorded();
    const first = (await t!.api<CtStateDto>('GET', `${BASE}/${id}/ct`)).json;
    expect(first.fields).toMatchObject({
      title: 'Cálculo da taxa',
      priority: 'Normal',
      author: 'Alex',
      analysisTitle: 'Análise',
    });
    expect(first.fields.versions).toHaveLength(1);
    expect(first.useCases).toEqual([
      { stepId: null, title: '', defaultTitle: 'Caso de Uso 1', status: 'Finalizado' },
    ]);
    expect(first.imageCount).toBe(4);

    const saved = await t!.api<CtStateDto>('PUT', `${BASE}/${id}/ct`, {
      ...first.fields,
      ticketId: '900.001',
      priority: 'Alta',
      systemModule: 'Financeiro / Empenho\nProtocolo',
      context: 'Contexto da correção',
      versions: [
        ...first.fields.versions,
        { version: '1.1', date: '13/11/2026', description: 'Ajuste', author: 'Ana' },
      ],
      useCases: [{ stepId: null, title: 'Cálculo', status: 'Reprovado' }],
    });
    expect(saved.status).toBe(200);
    expect(saved.json.fields).toMatchObject({ ticketId: '900.001', priority: 'Alta' });
    expect(saved.json.fields.versions).toHaveLength(2);
    expect(saved.json.useCases[0]).toMatchObject({ title: 'Cálculo', status: 'Reprovado' });

    // persisted in the session, steps untouched
    const again = (await t!.api<TestSessionDto>('GET', `${BASE}/${id}`)).json;
    expect(again.definition.steps).toHaveLength(session.definition.steps.length);
    expect(again.definition.ct?.ticketId).toBe('900.001');
  });

  it('validates the payload and refuses edits while recording', async () => {
    const { id } = await recorded();
    const fields = (await t!.api<CtStateDto>('GET', `${BASE}/${id}/ct`)).json.fields;
    const bad = await t!.api('PUT', `${BASE}/${id}/ct`, {
      ...fields,
      versions: [{ version: '', date: '', description: '', author: '' }],
    });
    expect(bad.status).toBe(400);
    const missing = await t!.api('PUT', `${BASE}/${id}/ct`, {
      ...fields,
      useCases: [{ stepId: 'nope', title: 'x', status: 'y' }],
    });
    expect(missing.status).toBe(404);
    expect((await t!.api('GET', `${BASE}/nao-existe/ct`)).status).toBe(404);

    await t!.api('POST', `${BASE}/${id}/record/start`);
    expect((await t!.api('PUT', `${BASE}/${id}/ct`, fields)).status).toBe(409);
    await t!.api('POST', `${BASE}/${id}/record/stop`);
  });

  it('builds use cases from the steps: dividers, comments, code and prints', async () => {
    const { id, session } = await recorded();
    const [, s1, s2, s3] = session.definition.steps;
    await t!.api('PATCH', `${BASE}/${id}/steps/${s1!.id}`, { comment: 'Informa o código' });
    await t!.api('PATCH', `${BASE}/${id}/steps/${s2!.id}`, {
      comment: 'SELECT *\n  FROM taxa',
      commentIsCode: true,
    });
    await t!.api('PATCH', `${BASE}/${id}/evidences/${session.images[s1!.id]!.id}`, {
      include: false,
    });
    await t!.api('PATCH', `${BASE}/${id}/evidences/${session.images[s2!.id]!.id}`, {
      include: false,
    });
    const added = await t!.api<TestSessionDto>('POST', `${BASE}/${id}/steps/use-cases`, {
      title: 'Resultado',
      status: 'Pendente',
      beforeStepId: s3!.id,
    });
    expect(added.status).toBe(201);
    expect(added.json.definition.steps.map((s) => s.kind)).toEqual([
      'goto',
      'fill',
      'fill',
      'usecase',
      'click',
    ]);
    expect(added.json.definition.steps[3]).toMatchObject({
      kind: 'usecase',
      useCase: { title: 'Resultado', status: 'Pendente' },
    });
    // a divider never locks or changes the session's mode
    expect(added.json.mode).toBe('record');

    const state = (await t!.api<CtStateDto>('GET', `${BASE}/${id}/ct`)).json;
    expect(state.useCases.map((u) => [u.title, u.status, u.defaultTitle])).toEqual([
      ['', 'Finalizado', 'Caso de Uso 1'],
      ['Resultado', 'Pendente', 'Caso de Uso 2'],
    ]);
    expect(state.document.useCases.map((u) => u.items.map((i) => i.kind))).toEqual([
      ['image', 'text', 'code'], // the page-open step keeps its print
      ['image'],
    ]);
    expect(state.itemStepIds).toEqual([
      [session.definition.steps[0]!.id, s1!.id, s2!.id],
      [s3!.id],
    ]);
    expect(state.imageCount).toBe(2);

    // the divider moves like any step (reorder) and goes away with delete
    const stepId = added.json.definition.steps[3]!.id;
    const removed = await t!.api<TestSessionDto>('DELETE', `${BASE}/${id}/steps/${stepId}`);
    expect(removed.json.definition.steps.some((s) => s.kind === 'usecase')).toBe(false);

    const edit = await t!.api<TestSessionDto>('PATCH', `${BASE}/${id}/steps/${s1!.id}`, {
      commentIsCode: true,
    });
    expect(edit.json.definition.steps[1]!.commentIsCode).toBe(true);
  });
});

describe('CT document: preview and exports', () => {
  it('serves the preview with image URLs of the authenticated image route', async () => {
    const { id } = await recorded();
    const res = await get(`${BASE}/${id}/ct/preview`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.body).toContain('Caso de Teste');
    expect(res.body).toContain('Cálculo da taxa');
    expect(res.body).toContain(`src="/api/tests/sessions/${id}/images/evidences/`);
    expect(
      (await t!.app.inject({ method: 'GET', url: `${BASE}/${id}/ct/preview` })).statusCode,
    ).toBe(401);
  });

  it('downloads a .docx with the images', async () => {
    const { id } = await recorded();
    const res = await get(`${BASE}/${id}/ct/docx`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain(
      'attachment; filename="Calculo da taxa.docx"',
    );
    const zip = await JSZip.loadAsync(res.rawPayload);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml.match(/<w:drawing>/g)).toHaveLength(4);
    expect(xml).toContain('Cálculo da taxa');
  });

  it('prints the PDF through the injected renderer, and explains when it is unavailable', async () => {
    const pdf = new FakePdf();
    const { id } = await recorded({ reports: { pdfRenderer: pdf } });
    const res = await get(`${BASE}/${id}/ct/pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('.pdf"');
    expect(res.body).toContain('%PDF');
    expect(pdf.htmls[0]).toContain('data:image/png;base64,');

    pdf.fail = true;
    const failed = await get(`${BASE}/${id}/ct/pdf`);
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error.message).toContain('Chromium não encontrado');
  });

  it('gives the plano as an HTML fragment with data-URI images, or as plain text', async () => {
    const { id, session } = await recorded();
    await t!.api('PATCH', `${BASE}/${id}/steps/${session.definition.steps[0]!.id}`, {
      comment: 'Informa o código',
    });
    const html = await get(`${BASE}/${id}/ct/clipboard`);
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('Informa o código');
    expect(html.body.match(/src="data:image\/png;base64,/g)).toHaveLength(4);
    expect(html.body).not.toContain('Cabeçalho');
    const text = await get(`${BASE}/${id}/ct/clipboard?format=text`);
    expect(text.body).toBe(
      'Caso de Uso 1 — Finalizado\nInforma o código\n[imagem]\n[imagem]\n[imagem]\n[imagem]\n',
    );
  });

  it('answers 404 for an unknown session', async () => {
    await recorded();
    expect((await get(`${BASE}/nao-existe/ct/docx`)).statusCode).toBe(404);
  });
});

describe('CT document: OneDrive', () => {
  async function connected() {
    const fake = new FakeMicrosoft();
    fake.on('GET', GRAPH_ME, ME);
    fake.on('POST', TOKEN_URL, () => tokenResponse());
    const out = await recorded({ fetchFn: fake.fetch });
    const od = t!.container.onedrive;
    od.updateSettings({ clientId: CLIENT_ID });
    const { authorizeUrl } = od.startAuthorization(REDIRECT);
    await od.completeAuthorization({
      code: 'CODE-1',
      state: new URL(authorizeUrl).searchParams.get('state') ?? '',
    });
    return { ...out, fake };
  }

  it('uploads the .docx with the suggested name and returns the link', async () => {
    const { id, fake } = await connected();
    await t!.api('PUT', `${BASE}/${id}/ct`, {
      ...(await t!.api<CtStateDto>('GET', `${BASE}/${id}/ct`)).json.fields,
      ticketId: '900.001',
    });
    fake.on('PUT', /\/content/, (call) =>
      jsonResponse(
        201,
        driveItem({
          id: 'NEW',
          name: decodeURIComponent(/root:\/(.+?):\/content/.exec(call.url)![1]!),
        }),
      ),
    );
    const res = await t!.api<CtOneDriveResultDto>('POST', `${BASE}/${id}/ct/onedrive`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: 'NEW',
      name: 'CT 900.001 - Cálculo da taxa.docx',
      webUrl: 'https://1drv.ms/w/s!abc',
    });
    const [put] = fake.callsTo('PUT', /\/content/);
    expect(put!.url).toContain(encodeURIComponent('CT 900.001 - Cálculo da taxa.docx'));
    expect(put!.bytes).toBeGreaterThan(1000);
  });

  it('says so when OneDrive is not connected', async () => {
    const { id } = await recorded();
    const res = await t!.api<{ error: { code: string; message: string } }>(
      'POST',
      `${BASE}/${id}/ct/onedrive`,
    );
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('onedrive_not_connected');
  });
});
