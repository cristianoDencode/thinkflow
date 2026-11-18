import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  LibraryDetailDto,
  LibraryDto,
  ReportDetailDto,
  ReportDto,
  ReportRendererStatusDto,
  ReportTemplateSummaryDto,
} from '@thinkflow/shared';
import { UnavailableRenderer } from '../../src/contexts/reports/infrastructure/unavailable-renderer';
import { createTestApp, type TestApp } from './test-app';
import {
  FakeDiagramRenderer,
  FakePdfRenderer,
  MODEL,
  makeProvider,
  type Provider,
} from './report-rendering-fixtures';

let t: TestApp | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const FLOW = 'Segue o fluxo:\nflowchart TD\nA[Início (x)] --> B';

interface Setup {
  app: TestApp;
  provider: Provider;
  diagrams: FakeDiagramRenderer;
  pdf: FakePdfRenderer;
  reportsDir: string;
  byName(part: string): string;
}

async function setup(
  options: {
    provider?: Provider;
    diagrams?: FakeDiagramRenderer | UnavailableRenderer;
    pdf?: FakePdfRenderer | UnavailableRenderer;
  } = {},
): Promise<Setup> {
  const provider = options.provider ?? makeProvider();
  const diagrams = options.diagrams ?? new FakeDiagramRenderer();
  const pdf = options.pdf ?? new FakePdfRenderer();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-pdf-'));
  dirs.push(reportsDir);
  const app = await createTestApp({
    fetchFn: provider.fetchFn,
    reports: {
      diagramRenderer: diagrams,
      pdfRenderer: pdf,
      dataDir: reportsDir,
      sleep: async () => {},
    },
  });
  t = app;
  await app.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
  const templates = (await app.api<ReportTemplateSummaryDto[]>('GET', '/api/report-templates'))
    .json;
  return {
    app,
    provider,
    diagrams: diagrams as FakeDiagramRenderer,
    pdf: pdf as FakePdfRenderer,
    reportsDir,
    byName: (part) => templates.find((x) => x.name.includes(part))!.id,
  };
}

async function generate(s: Setup, template: string, body: object = {}): Promise<ReportDetailDto> {
  const created = await s.app.api<ReportDto>('POST', '/api/reports', {
    templateId: s.byName(template),
    model: MODEL,
    useMcp: false,
    variables: { assunto: 'Cobrança de IPTU' },
    ...body,
  });
  expect(created.status).toBe(201);
  await s.app.container.reports.runner.whenIdle();
  return (await s.app.api<ReportDetailDto>('GET', `/api/reports/${created.json.id}`)).json;
}

/** Keys of the cached PDFs of a report in the (in-memory) object store. */
const pdfObjects = (s: Setup, id: string): string[] =>
  s.app.store.keys(`reports/${id}/`).filter((key) => key.endsWith('/report.pdf'));

const get = (app: TestApp, url: string) =>
  app.app.inject({ method: 'GET', url, headers: { cookie: app.cookie } });

describe('report rendering: HTML', () => {
  it('serves a sandboxed, sanitized HTML document with TOC, appendix and rendered diagrams', async () => {
    const provider = makeProvider();
    provider.answer.section = (c) =>
      c.n === 3
        ? FLOW
        : c.n === 1
          ? 'Texto **forte** <script>alert(1)</script> ![x](http://evil.test/p.png) [ok](javascript:alert(1))'
          : `Conteúdo da seção ${c.n}.`;
    const s = await setup({ provider });
    const report = await generate(s, 'Análise técnica', { title: 'Guia <i>IPTU</i> & cia' });

    expect(report.status).toBe('done');
    expect(report.hasHtml).toBe(true);
    expect(report.meta.diagrams).toEqual({
      total: 1,
      rendered: 1,
      repaired: 0,
      failed: 0,
      unvalidated: 0,
    });

    const res = await get(s.app, `/api/reports/${report.id}/html`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox",
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBeUndefined();
    const html = res.body;
    // TOC anchors point at the headings
    expect(html).toContain('<nav class="toc"');
    expect(html).toContain('href="#sec-3-');
    expect(html).toMatch(/<h2 id="sec-3-[a-z0-9-]+">3\. /);
    expect(html).toContain('<h2 id="sobre-este-documento">Sobre este documento</h2>');
    // diagram is the (fake) SVG
    expect(html).toContain('<figure class="diagram"');
    expect(html).toContain('fake-diagram');
    expect(html).not.toContain('<pre class="mermaid-fallback">');
    // the title is escaped everywhere, nothing from the AI text is executable or remote
    expect(html).toContain('<title>Guia &lt;i&gt;IPTU&lt;/i&gt; &amp; cia</title>');
    expect(html).not.toContain('<i>IPTU');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('evil.test');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<strong>forte</strong>');
    expect(html).toContain(
      "content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\"",
    );

    const download = await get(s.app, `/api/reports/${report.id}/html?download=1`);
    expect(download.headers['content-disposition']).toMatch(
      /^attachment; filename="guia-i-iptu-i-cia\.html"$/,
    );

    // Markdown still has the raw diagram fence
    const md = await get(s.app, `/api/reports/${report.id}/markdown`);
    expect(md.body).toContain('```mermaid');
  });

  it('needs a finished report and a session', async () => {
    const s = await setup();
    expect((await s.app.api('GET', '/api/reports/nope/html')).status).toBe(404);
    const anon = await s.app.app.inject({ method: 'GET', url: '/api/reports/x/html' });
    expect(anon.statusCode).toBe(401);
    for (const url of ['pdf', 'html']) {
      expect(
        (await s.app.app.inject({ method: 'GET', url: `/api/reports/x/${url}` })).statusCode,
      ).toBe(401);
    }
    expect(
      (await s.app.app.inject({ method: 'GET', url: '/api/reports/renderer' })).statusCode,
    ).toBe(401);
  });

  it('rebuilds the html with the new title when the report is renamed', async () => {
    const s = await setup();
    const report = await generate(s, 'Análise técnica');
    await s.app.api('PATCH', `/api/reports/${report.id}`, { title: 'Título novo' });
    const html = (await get(s.app, `/api/reports/${report.id}/html`)).body;
    expect(html).toContain('<title>Título novo</title>');
    const md = (await s.app.api<ReportDetailDto>('GET', `/api/reports/${report.id}`)).json.markdown;
    expect(md).toContain('# Título novo');
  });
});

describe('report rendering: diagram validation and repair', () => {
  const BROKEN = 'Fluxo:\nflowchart TD\nA[BROKEN] --> B';

  it('repairs a diagram once with the model and keeps the repaired source', async () => {
    const provider = makeProvider();
    provider.answer.section = (c) => (c.n === 2 ? BROKEN : `Conteúdo da seção ${c.n}.`);
    provider.answer.repair = () => '```mermaid\nflowchart TD\nA[Corrigido] --> B\n```';
    const s = await setup({ provider });
    const report = await generate(s, 'Análise técnica');

    expect(provider.count('repair')).toBe(1);
    expect(report.sections[1]!.markdown).toContain('A[Corrigido] --> B');
    expect(report.sections[1]!.markdown).not.toContain('BROKEN');
    expect(report.sections[1]!.warnings).toEqual([]);
    expect(report.meta.diagrams).toEqual({
      total: 1,
      rendered: 1,
      repaired: 1,
      failed: 0,
      unvalidated: 0,
    });
    const usage = await s.app.api<{ bySource: { source: string }[] }>('GET', '/api/usage');
    expect(usage.json.bySource.map((x) => x.source)).toContain('diagram-repair');
  });

  it('keeps the code and warns when the repair fails too, showing a fallback block', async () => {
    const provider = makeProvider();
    provider.answer.section = (c) => (c.n === 2 ? BROKEN : `Conteúdo da seção ${c.n}.`);
    provider.answer.repair = () => '```mermaid\nflowchart TD\nA[BROKEN again] --> B\n```';
    const s = await setup({ provider });
    const report = await generate(s, 'Análise técnica');

    expect(provider.count('repair')).toBe(1); // one repair per diagram, never more
    expect(report.sections[1]!.markdown).toContain('A[BROKEN] --> B');
    expect(report.sections[1]!.warnings.join()).toContain('não pôde ser validado');
    expect(report.meta.diagrams).toMatchObject({ total: 1, rendered: 0, failed: 1, repaired: 0 });
    expect(report.markdown).toContain('1 com erro de sintaxe');
    const html = (await get(s.app, `/api/reports/${report.id}/html`)).body;
    expect(html).toContain('<pre class="mermaid-fallback">');
    expect(html).toContain('Diagrama não validado');
    expect(html).not.toContain('fake-diagram');
  });

  it('degraded mode: no renderer means no validation, no repair call and an honest appendix', async () => {
    const provider = makeProvider();
    provider.answer.section = (c) => (c.n === 2 ? BROKEN : `Conteúdo da seção ${c.n}.`);
    const s = await setup({
      provider,
      diagrams: new UnavailableRenderer('sem chromium'),
      pdf: new UnavailableRenderer('sem chromium'),
    });
    const report = await generate(s, 'Análise técnica');

    expect(report.status).toBe('done');
    expect(provider.count('repair')).toBe(0);
    expect(report.meta.diagrams).toEqual({
      total: 1,
      rendered: 0,
      repaired: 0,
      failed: 0,
      unvalidated: 1,
    });
    expect(report.sections[1]!.markdown).toContain('```mermaid');
    const html = await get(s.app, `/api/reports/${report.id}/html`);
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('<pre class="mermaid-fallback">');
    expect((await get(s.app, `/api/reports/${report.id}/markdown`)).statusCode).toBe(200);

    const pdf = await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(pdf.statusCode).toBe(503);
    expect(JSON.parse(pdf.body)).toMatchObject({ error: { code: 'pdf_unavailable' } });
    expect(JSON.parse(pdf.body).error.message).toContain('Baixar HTML');

    const status = await s.app.api<ReportRendererStatusDto>('GET', '/api/reports/renderer');
    expect(status.json).toMatchObject({ pdf: false, diagrams: false, reason: 'sem chromium' });
  });
});

describe('report rendering: PDF', () => {
  it('renders once, caches in the object store, and invalidates when the document changes', async () => {
    const s = await setup();
    const report = await generate(s, 'Análise técnica', { title: 'Relatório de IPTU' });
    expect((await s.app.api<ReportRendererStatusDto>('GET', '/api/reports/renderer')).json).toEqual(
      {
        pdf: true,
        diagrams: true,
        reason: null,
        executablePath: '/fake/chrome',
      },
    );

    const first = await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('application/pdf');
    expect(first.headers['content-disposition']).toBe(
      'attachment; filename="relatorio-de-iptu.pdf"',
    );
    expect(first.body.startsWith('%PDF')).toBe(true);
    expect(s.pdf.calls).toHaveLength(1);
    // header text defaults to the title; page numbers are the print engine's
    expect(s.pdf.calls[0]!.header).toContain('Relatório de IPTU');
    expect(s.pdf.calls[0]!.footer).toContain('pageNumber');
    expect(s.pdf.calls[0]!.pageSize).toBe('A4');
    expect(s.pdf.calls[0]!.html).toContain('<h2 id="sobre-este-documento">');
    expect(pdfObjects(s, report.id)).toHaveLength(1);
    expect(fs.readdirSync(s.reportsDir)).toEqual([]); // nothing is written to the legacy cache dir
    expect((await s.app.api<ReportDto>('GET', `/api/reports/${report.id}`)).json.hasPdf).toBe(true);

    const second = await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(second.body).toBe(first.body);
    expect(s.pdf.calls).toHaveLength(1); // served from the cache

    // rewriting a section assembles a new document: the PDF is stale
    s.provider.answer.section = () => 'Texto novo.';
    await s.app.api('POST', `/api/reports/${report.id}/sections/2/regenerate`, {});
    await s.app.container.reports.runner.whenIdle();
    expect((await s.app.api<ReportDto>('GET', `/api/reports/${report.id}`)).json.hasPdf).toBe(
      false,
    );
    const third = await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(third.statusCode).toBe(200);
    expect(s.pdf.calls).toHaveLength(2);
    expect(s.pdf.calls[1]!.html).toContain('Texto novo.');
  });

  it('shares one render between concurrent requests', async () => {
    const s = await setup();
    const report = await generate(s, 'Análise técnica');
    const results = await Promise.all(
      [1, 2, 3].map(() => get(s.app, `/api/reports/${report.id}/pdf`)),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(s.pdf.calls).toHaveLength(1);
  });

  it('has no PDF for prototypes', async () => {
    const provider = makeProvider();
    provider.answer.screens = () => '{"telas":[{"titulo":"Lista","objetivo":"Listar"}]}';
    provider.answer.screen = () => 'Descrição.\n```html\n<div class="tf-card">Olá</div>\n```';
    const s = await setup({ provider });
    const proto = await generate(s, 'Protótipo', { variables: { produto: 'Painel' } });
    expect(proto.status).toBe('done');
    const res = await get(s.app, `/api/reports/${proto.id}/pdf`);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'pdf_not_supported' } });
  });

  it('is not available while the report is still being generated', async () => {
    const provider = makeProvider();
    let release!: () => void;
    provider.gate = new Promise<void>((resolve) => (release = resolve));
    const s = await setup({ provider });
    const created = await s.app.api<ReportDto>('POST', '/api/reports', {
      templateId: s.byName('Análise técnica'),
      model: MODEL,
      useMcp: false,
      variables: { assunto: 'x' },
    });
    for (const kind of ['pdf', 'html']) {
      const res = await get(s.app, `/api/reports/${created.json.id}/${kind}`);
      expect(res.statusCode, kind).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'report_not_ready' } });
    }
    release();
    await s.app.container.reports.runner.whenIdle();
    expect((await get(s.app, `/api/reports/${created.json.id}/html`)).statusCode).toBe(200);
  });

  it('deleting a report removes its cached PDF', async () => {
    const s = await setup();
    const report = await generate(s, 'Análise técnica');
    await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(pdfObjects(s, report.id)).toHaveLength(1);
    expect((await s.app.api('DELETE', `/api/reports/${report.id}`)).status).toBe(200);
    expect(s.app.store.keys(`reports/${report.id}/`)).toEqual([]);
  });
});

describe('report rendering: Adicionar à Biblioteca', () => {
  it('turns the report Markdown into a library document', async () => {
    const s = await setup();
    const report = await generate(s, 'Análise técnica', { title: 'Relatório de IPTU' });
    const lib = await s.app.api<LibraryDto>('POST', '/api/libraries', { name: 'Biblioteca' });

    const res = await s.app.api<{ documentId: string; libraryId: string; name: string }>(
      'POST',
      `/api/reports/${report.id}/library`,
      { libraryId: lib.json.id },
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ libraryId: lib.json.id, name: 'relatorio-de-iptu.md' });

    await s.app.container.library.whenIdle();
    const detail = await s.app.api<LibraryDetailDto>('GET', `/api/libraries/${lib.json.id}`);
    const doc = detail.json.documents.find((d) => d.id === res.json.documentId)!;
    expect(doc).toMatchObject({ name: 'relatorio-de-iptu.md', status: 'ready' });
    const text = await s.app.api<{ text: string }>(
      'GET',
      `/api/libraries/${lib.json.id}/documents/${doc.id}/text`,
    );
    expect(text.json.text).toContain('# Relatório de IPTU');
    expect(text.json.text).toContain('## Sobre este documento');

    const after = (await s.app.api<ReportDetailDto>('GET', `/api/reports/${report.id}`)).json;
    expect(after.meta.libraryDocuments).toEqual([
      { libraryId: lib.json.id, documentId: res.json.documentId },
    ]);

    // the same content twice is rejected by the library with its own reason
    const again = await s.app.api('POST', `/api/reports/${report.id}/library`, {
      libraryId: lib.json.id,
    });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.json)).toContain('já existe');

    expect((await s.app.api('POST', `/api/reports/${report.id}/library`, {})).status).toBe(400);
    expect(
      (await s.app.api('POST', `/api/reports/${report.id}/library`, { libraryId: 'nope' })).status,
    ).toBe(404);
  });
});

describe('report rendering: prototype', () => {
  it('plans screens, writes sanitized fragments and assembles a CSS-only navigable page', async () => {
    const provider = makeProvider();
    provider.answer.screens = () =>
      '{"telas":[{"titulo":"Lista de débitos","objetivo":"Listar"},{"titulo":"Detalhe","objetivo":"Ver um débito"}]}';
    provider.answer.screen = (c) =>
      c.user.includes('"Detalhe"')
        ? 'Tela de detalhe.\n```html\n<div class="tf-card" style="x:y"><h2 id="tela-lista" onclick="evil()">Detalhe</h2><a class="tf-btn" href="#tela-lista-de-debitos">Voltar</a><a href="http://evil.test">fora</a><script>alert(1)</script></div>\n```'
        : 'Tela de lista.\n```html\n<div class="tf-app"><table class="tf-table"><tr><td>1</td></tr></table><a href="#tela-detalhe">Abrir</a></div>\n```';
    const s = await setup({ provider });
    const report = await generate(s, 'Protótipo', { variables: { produto: 'Painel', telas: '' } });

    expect(report.status).toBe('done');
    expect(provider.count('screens')).toBe(1);
    expect(provider.count('screen')).toBe(2);
    expect(report.sections.map((x) => [x.role, x.title])).toEqual([
      ['section', 'Visão geral'],
      ['section', 'Mapa de navegação'],
      ['section', 'Componentes'],
      ['section', 'Estados e mensagens'],
      ['screen', 'Lista de débitos'],
      ['screen', 'Detalhe'],
    ]);
    expect(report.markdown).toContain('## Telas do protótipo');
    expect(report.markdown).toContain('### Detalhe');

    const res = await get(s.app, `/api/reports/${report.id}/html`);
    const html = res.body;
    expect(html).toContain('<section id="tela-lista-de-debitos" class="tf-screen">');
    expect(html).toContain('<section id="tela-detalhe" class="tf-screen">');
    expect(html).toContain('id="tela-especificacao"');
    expect(html).toContain('href="#tela-detalhe"');
    expect(html).toContain('href="#tela-lista-de-debitos"');
    expect(html).toContain('.tf-screen:target{display:block}');
    // sanitized: no script, handlers, inline style, ids from the model or external links
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('evil');
    expect(html).not.toContain('style="');
    expect(html).not.toMatch(/<h2 id="tela-lista"/);
    // sections for the documentation are the specification screen
    expect(html).toContain('Visão geral');
  });

  it('falls back to the screens listed in the request when the plan cannot be read', async () => {
    const provider = makeProvider();
    provider.answer.screens = () => 'sem json';
    provider.answer.screen = () => 'Tela.\n```html\n<div>x</div>\n```';
    const s = await setup({ provider });
    const report = await generate(s, 'Protótipo', {
      variables: { produto: 'Painel', telas: 'Listagem, Formulário' },
    });
    expect(provider.count('screens')).toBe(2);
    expect(report.sections.filter((x) => x.role === 'screen').map((x) => x.title)).toEqual([
      'Listagem',
      'Formulário',
    ]);
    expect(report.meta.warnings.join()).toContain('plano de telas');
  });

  it('marks a screen as failed when the model never returns HTML, keeping the others', async () => {
    const provider = makeProvider();
    provider.answer.screens = () => '{"telas":[{"titulo":"A"},{"titulo":"B"}]}';
    provider.answer.screen = (c) =>
      c.user.includes('"A"') ? 'só texto, sem bloco html' : 'Tela B.\n```html\n<div>b</div>\n```';
    const s = await setup({ provider });
    const report = await generate(s, 'Protótipo', { variables: { produto: 'Painel' } });
    expect(report.status).toBe('done');
    const screens = report.sections.filter((x) => x.role === 'screen');
    expect(screens.map((x) => x.status)).toEqual(['error', 'done']);
    const html = (await get(s.app, `/api/reports/${report.id}/html`)).body;
    expect(html).toContain('id="tela-b"');
    expect(html).not.toContain('id="tela-a"');
  });
});
