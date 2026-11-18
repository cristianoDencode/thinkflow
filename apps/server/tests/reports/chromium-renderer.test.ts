import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeDiagrams, templateLayoutSchema } from '@thinkflow/shared';
import { NOTEBOOKLM_UNFENCED } from '../../../../packages/shared/src/diagrams/fixtures';
import { assemblePrototype } from '../../src/contexts/reports/domain/prototype';
import { isSafeSvg } from '../../src/contexts/reports/domain/svg-guard';
import { ChromiumBrowser } from '../../src/contexts/reports/infrastructure/chromium/chromium-browser';
import { ChromiumDiagramRenderer } from '../../src/contexts/reports/infrastructure/chromium/chromium-diagram-renderer';
import { ChromiumPdfRenderer } from '../../src/contexts/reports/infrastructure/chromium/chromium-pdf-renderer';

// Real Chromium: slow and needs the browser installed, so it is opt-in (RUN_CHROMIUM_TESTS=1).
describe.skipIf(!process.env.RUN_CHROMIUM_TESTS)('real Chromium (smoke)', () => {
  const browser = new ChromiumBrowser();
  const diagrams = new ChromiumDiagramRenderer(browser);
  const pdf = new ChromiumPdfRenderer(browser);
  afterAll(async () => {
    await diagrams.close();
    await browser.close();
  });

  it('reports the browser as available', async () => {
    expect(await browser.status()).toMatchObject({ available: true, reason: null });
  }, 60_000);

  it('renders the normalized NotebookLM fixture to a safe SVG', async () => {
    const { diagrams: found } = normalizeDiagrams(NOTEBOOKLM_UNFENCED);
    expect(found.length).toBeGreaterThan(0);
    for (const block of found) {
      const res = await diagrams.render(block.code);
      expect(res.ok, JSON.stringify(res)).toBe(true);
      if (res.ok) {
        expect(isSafeSvg(res.svg)).toBe(true);
        expect(res.svg).not.toContain('foreignObject');
      }
    }
  }, 60_000);

  it('renders a sequence diagram and rejects an invalid one', async () => {
    const ok = await diagrams.render('sequenceDiagram\n  A->>B: oi\n  B-->>A: ola');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(isSafeSvg(ok.svg)).toBe(true);
    const bad = await diagrams.render('flowchart TD\n  A --> B --> [[[');
    expect(bad).toMatchObject({ ok: false });
    expect('unavailable' in bad && bad.unavailable).toBeFalsy();
    // the session survives a failure
    expect((await diagrams.render('flowchart LR\n  X --> Y')).ok).toBe(true);
  }, 60_000);

  it('navigates the prototype between screens with CSS only (JavaScript disabled)', async () => {
    const html = assemblePrototype({
      title: 'Painel',
      metaLine: 'm',
      layout: templateLayoutSchema.parse({}),
      specHtml: '<h2>Especificação</h2>',
      screens: [
        { slug: 'lista', title: 'Lista', html: '<p id="x">Tela da lista</p>' },
        { slug: 'detalhe', title: 'Detalhe', html: '<p>Tela do detalhe</p>' },
      ],
    });
    await browser.use(async (b) => {
      const context = await browser.newIsolatedContext(b, { javaScriptEnabled: false });
      try {
        const page = await context.newPage();
        await page.setContent(html);
        const visible = async (text: string) => page.getByText(text).isVisible();
        expect(await visible('Tela da lista')).toBe(true); // first screen by default
        expect(await visible('Tela do detalhe')).toBe(false);
        await page.click('.tf-proto-nav a[href="#tela-detalhe"]');
        expect(await visible('Tela do detalhe')).toBe(true);
        expect(await visible('Tela da lista')).toBe(false);
        await page.click('.tf-proto-nav a[href="#tela-especificacao"]');
        expect(await page.getByRole('heading', { name: 'Especificação' }).isVisible()).toBe(true);
      } finally {
        await context.close();
      }
    });
  }, 60_000);

  it('prints a 2-page PDF and never requests remote resources', async () => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'image/png' }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>.p{break-after:page}</style></head><body>
        <img src="http://127.0.0.1:${port}/tracker.png"><link rel="stylesheet" href="http://127.0.0.1:${port}/x.css">
        <h1 class="p">Página 1 áéíõç</h1><h1>Página 2</h1></body></html>`;
      const bytes = await pdf.pdf(html, {
        headerTemplate: '<span></span>',
        footerTemplate: '<span class="pageNumber"></span>',
        pageSize: 'A4',
      });
      expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
      expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(2);
      expect(requests).toEqual([]);
    } finally {
      server.close();
    }
  }, 60_000);
});
