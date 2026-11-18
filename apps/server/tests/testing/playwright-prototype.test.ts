import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prepareSnapshot } from '../../src/contexts/prototypes/domain/prototype';
import type { RecordingHandle } from '../../src/contexts/testing/domain/ports';
import { PlaywrightRecorderBrowser } from '../../src/contexts/testing/infrastructure/playwright/playwright-recorder';
import { TINY_PNG } from './fake-recorder';

// Real Chromium (headless): opt-in, like the other browser tests.
const enabled = !!process.env.RUN_CHROMIUM_TESTS;

const LISTENER = {
  onDownload: () => undefined,
  onEvent: () => undefined,
  onCaptureRequest: () => undefined,
  onPauseToggle: () => undefined,
  onCheckpointRequest: () => undefined,
  onPrototypeRequest: () => undefined,
  onClosed: () => undefined,
};

// The e-Cidade desktop: the main page holds a window whose frame wraps the routine's own frame.
const DESKTOP = `<!doctype html><title>e-Cidade</title><body style="margin:0">
<div id="menu">MENU</div>
<iframe id="win" src="/w/1/extension/desktop/window/index/?action=emp1_empconsulta001.php"
  style="position:absolute;left:100px;top:60px;width:1000px;height:600px;border:0"></iframe>
<iframe id="tiny" src="/w/2/pequena.php" style="position:absolute;left:0;top:0;width:60px;height:40px;border:0"></iframe>
</body>`;
const WRAPPER = `<!doctype html><title>Janela</title><body style="margin:0">
<div style="height:30px;background:#ccc">Consulta Empenho</div>
<iframe src="/w/1/emp1_empconsulta001.php?id=7" style="width:100%;height:560px;border:0"></iframe></body>`;
const ROUTINE = `<!doctype html><html><head><title>Consulta Empenho</title>
<link rel="stylesheet" href="/estilos.css">
<link rel="stylesheet" href="@EXTERNAL@/externo.css">
<style>.interno{color:rgb(10,20,30)} .logo{background:url(/fundo.png) no-repeat}</style>
<script>window.__ran = true; document.addEventListener('DOMContentLoaded', () => { document.title = 'Consulta Empenho'; });</script>
</head><body onload="window.__onload = true">
<h1 class="interno">Consulta de empenho</h1>
<img id="logo" src="/logo.png" alt="Logo" width="20" height="20">
<div class="logo" style="width:10px;height:10px"></div>
<form id="f">
  <label for="nome">Nome:</label><input id="nome" type="text" value="">
  <label for="uf">UF:</label>
  <select id="uf"><option value="RJ">Rio de Janeiro</option><option value="SP">São Paulo</option></select>
  <input id="ok" type="checkbox"><label for="ok">Ativo</label>
  <textarea id="obs"></textarea>
  <input id="senha" type="password">
  <input type="submit" value="Pesquisar" onclick="return false">
</form>
<table id="grid"><thead><tr><th>Empenho</th><th>Credor</th></tr></thead>
<tbody><tr><td>2026/0001</td><td>Maria da Silva</td></tr></tbody></table>
<span class="ext">externo</span>
</body></html>`;
const PEQUENA = `<!doctype html><title>Pequena</title><body><p>pequena</p></body>`;

describe.skipIf(!enabled)('prototype capture (real Chromium)', () => {
  let server: http.Server;
  let external: http.Server;
  let base: string;
  const listen = (s: http.Server) =>
    new Promise<string>((resolve) =>
      s.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`),
      ),
    );

  beforeAll(async () => {
    external = http.createServer((req, res) => {
      if (req.url?.startsWith('/externo.css')) {
        res.setHeader('content-type', 'text/css');
        res.end('.ext{color:rgb(1,2,3)} .ext::before{content:"";background:url(img/x.png)}');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const externalBase = await listen(external);
    server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/estilos.css')) {
        res.setHeader('content-type', 'text/css');
        res.end('h1{font-family:serif} #grid th{background:rgb(200,200,200)}');
      } else if (url === '/logo.png' || url === '/fundo.png') {
        res.setHeader('content-type', 'image/png');
        res.end(Buffer.from(TINY_PNG));
      } else if (url.startsWith('/w/1/extension/')) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(WRAPPER);
      } else if (url.startsWith('/w/1/')) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(ROUTINE.replace('@EXTERNAL@', externalBase));
      } else if (url.startsWith('/w/2/')) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(PEQUENA);
      } else {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(url === '/solta' ? '<title>Solta</title><h1>Sem frames</h1>' : DESKTOP);
      }
    });
    base = await listen(server);
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => external.close(() => r()));
  });

  /** Frames appear a moment after the page: waits for the one whose address has `part`. */
  async function frameOf(page: Page, part: string) {
    let found;
    await vi.waitFor(() => {
      found = page.frames().find((f) => f.url().includes(part));
      expect(found).toBeDefined();
    });
    await found!.waitForLoadState('load');
    return found!;
  }

  async function open(path: string) {
    let page: Page | undefined;
    const recorder = new PlaywrightRecorderBrowser({
      headless: true,
      onPageOpened: (p) => (page ??= p),
    });
    const handle: RecordingHandle = await recorder.start(
      { url: `${base}${path}`, viewport: { width: 1200, height: 800 } },
      LISTENER,
    );
    return { handle, page: page! };
  }

  it('captures the innermost routine frame with CSS, pictures and form state, and no scripts', async () => {
    const { handle, page } = await open('/');
    try {
      const routine = await frameOf(page, '/w/1/emp1_empconsulta001.php');
      await routine.fill('#nome', 'João da Silva');
      await routine.selectOption('#uf', 'SP');
      await routine.check('#ok');
      await routine.fill('#obs', 'observação sigilosa');
      await routine.fill('#senha', 'segredo');

      const screen = (await handle.capturePrototype(null))!;
      // the screen is named after the routine inside the window
      expect(screen.url).toBe(`${base}/w/1/emp1_empconsulta001.php?id=7`);
      expect(screen.title).toBe('Consulta Empenho');
      // the e-Cidade window the routine is in (its wrapper frame), not the whole desktop
      expect(screen.width).toBe(1000);
      expect(screen.height).toBe(600);
      expect(screen.flattenedFrames).toBe(1);
      expect(screen.blankFrames).toBe(0);
      expect(screen.html).toMatch(/<div data-tf-frame="1" style="[^"]*width:\s*1000px/);
      expect(screen.html).toContain(
        '<div style="height:30px;background:#ccc">Consulta Empenho</div>',
      );

      // CSS: linked sheet, inline <style>, the sheet from another origin (downloaded by the server)
      // (the frame's own sheets only apply inside its div: every selector is scoped to it)
      expect(screen.css).toContain('[data-tf-frame="1"]{all:initial');
      expect(screen.css).toMatch(/\[data-tf-frame="1"\] h1\{\s*font-family:\s*serif/);
      expect(screen.css).toContain('[data-tf-frame="1"] .interno');
      expect(screen.css).toMatch(/\.ext\s*\{[^}]*rgb\(1,\s*2,\s*3\)/);
      // picture in a CSS rule and <img>: inlined as data URIs
      expect(screen.css).toMatch(/url\("data:image\/png;base64,/);
      expect(screen.html).toMatch(/<img[^>]+src="data:image\/png;base64,/);
      // a picture of another origin stays an absolute address
      expect(screen.css).toMatch(/url\("http:\/\/127\.0\.0\.1:\d+\/img\/x\.png"\)/);

      // form state became attributes
      expect(screen.html).toMatch(/<input[^>]*id="nome"[^>]*value="João da Silva"/);
      expect(screen.html).toMatch(/<option value="SP" selected="">/);
      expect(screen.html).toMatch(/<input[^>]*id="ok"[^>]*checked=""/);
      expect(screen.html).toMatch(/<textarea[^>]*id="obs"[^>]*>observação sigilosa<\/textarea>/);
      expect(screen.html).not.toContain('segredo'); // passwords never leave the page

      // nothing that runs or loads: scripts, links, styles, handlers, the recorder toolbar
      expect(screen.html).not.toMatch(/<script|<link|<style|<iframe/i);
      expect(screen.html).not.toMatch(/onload=/); // the child's <body> became the div: no handler survives
      expect(screen.html).not.toContain('__thinkflow_recorder_toolbar');
      expect(screen.html).toMatch(/<h1 class="interno">Consulta de empenho<\/h1>/);

      // what the service stores: sanitized and scrubbed
      const stored = prepareSnapshot(screen, { scrub: true });
      expect(stored.html).not.toMatch(/onload|<script/i);
      expect(stored.html).not.toContain('João da Silva');
      expect(stored.html).not.toContain('observação sigilosa');
      expect(stored.html).not.toContain('2026/0001');
      expect(stored.html).not.toContain('Maria da Silva');
      expect(stored.html).toContain('<th>Empenho</th><th>Credor</th>');
      expect(stored.html).toContain('Rio de Janeiro</option>');
      expect(stored.html).toContain('São Paulo</option>');
      expect(stored.html).toContain('value="Pesquisar"');
      expect(stored.html).toContain('<label for="nome">Nome:</label>');
      expect(stored.html).toContain('data:image/png;base64,');
      expect(stored.width).toBe(1000);
      expect(stored.height).toBe(600);
    } finally {
      await handle.close();
    }
  });

  it('follows the frame the user last worked in, and falls back to the main page', async () => {
    const { handle, page } = await open('/');
    try {
      const routine = await frameOf(page, '/w/1/emp1_empconsulta001.php');
      const tiny = await frameOf(page, '/w/2/pequena.php');
      // the user clicked in the routine: its frame, even though it is not the main page
      await routine.click('h1');
      expect((await handle.capturePrototype(null))!.url).toContain('/w/1/emp1_empconsulta001.php');
      // working in the other (small) frame moves the capture there
      await tiny.click('p');
      expect((await handle.capturePrototype(null))!.url).toContain('/w/2/pequena.php');
    } finally {
      await handle.close();
    }

    const flat = await open('/solta');
    try {
      const screen = (await flat.handle.capturePrototype(null))!;
      expect(screen.url).toBe(`${base}/solta`);
      expect(screen.title).toBe('Solta');
      expect(screen.html).toContain('Sem frames');
    } finally {
      await flat.handle.close();
    }
  });

  it('the toolbar button reports the request', async () => {
    const requests: string[] = [];
    let page: Page | undefined;
    const recorder = new PlaywrightRecorderBrowser({
      headless: true,
      onPageOpened: (p) => (page ??= p),
    });
    const handle = await recorder.start(
      { url: `${base}/solta`, viewport: { width: 900, height: 600 } },
      { ...LISTENER, onPrototypeRequest: (id) => requests.push(id) },
    );
    try {
      await page!.waitForLoadState('load');
      await page!.evaluate("window.__tfRecord({ kind: 'prototype' })");
      await new Promise((r) => setTimeout(r, 300));
      expect(requests).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });
});
