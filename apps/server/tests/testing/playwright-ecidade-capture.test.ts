import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prepareCapture, renderDocument } from '../../src/contexts/prototypes/domain/prototype';
import { ChromiumPrototypeRenderer } from '../../src/contexts/prototypes/infrastructure/chromium-prototype-renderer';
import { ChromiumBrowser } from '../../src/contexts/reports/infrastructure/chromium/chromium-browser';
import type { RecordingHandle } from '../../src/contexts/testing/domain/ports';
import { PlaywrightRecorderBrowser } from '../../src/contexts/testing/infrastructure/playwright/playwright-recorder';

// Real Chromium (headless): opt-in. A local imitation of the e-Cidade desktop, invented data:
// desktop page → window iframe (…/window/index/?action=…) → routine iframe + bottom iframe.
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

const CPF = '529.982.247-25';
const USER = 'João Pereira Souza';

const DESK_CSS = `
body{margin:0;background:#0a3a6b;font:12px Arial}
#userbar{position:absolute;left:0;top:0;right:0;height:28px;background:#222233;color:#fff;line-height:28px}
#taskbar{position:absolute;left:0;right:0;bottom:0;height:30px;background:#333366;color:#fff;line-height:30px}
.window{position:absolute;border:2px solid #556;background:#d4d0c8}
.wintitle{height:24px;line-height:24px;background:#1a5fb4;color:#fff;font-weight:bold;padding-left:6px}
.wintitle span{float:right;padding-right:6px}`;

const desktop = (titleInWrapper: boolean) => `<!doctype html><html><head><title>e-Cidade</title>
<link rel="stylesheet" href="/desk.css"></head><body>
<div id="userbar">Usuário: ${USER} — CPF ${CPF}</div>
<div class="window" id="back" style="left:60px;top:50px;width:1100px;height:700px;z-index:1">
  <iframe src="/w/0/extension/desktop/window/index/?action=outra.php" style="width:1100px;height:700px;border:0;display:block"></iframe></div>
<div class="window" id="front" style="left:150px;top:90px;width:900px;z-index:2">
  ${titleInWrapper ? '' : '<div class="wintitle">Consultas &gt; Consulta Empenho <span>_ □ X</span></div>'}
  <iframe id="winframe" src="/w/1/extension/desktop/window/index/?action=emp1_empconsulta001.php${titleInWrapper ? '&t=1' : ''}" style="width:900px;height:620px;border:0;display:block"></iframe></div>
<div id="taskbar">MENU</div></body></html>`;

const wrapper = (titleInWrapper: boolean) => `<!doctype html><html><head><title>Janela</title>
<link rel="stylesheet" href="/desk.css"><style>body{background:#d4d0c8}</style></head><body style="margin:0">
${titleInWrapper ? '<div class="wintitle">Consultas &gt; Consulta Empenho <span>_ □ X</span></div>' : ''}
<iframe src="/w/1/emp1_empconsulta001.php" style="width:100%;height:${titleInWrapper ? 566 : 590}px;border:0;display:block"></iframe>
<iframe src="/w/1/extension/desktop/window/bottom" style="width:100%;height:30px;border:0;display:block"></iframe>
</body></html>`;

const ROUTINE_CSS = `
body{background:#eeeeee;font-family:Arial,sans-serif;font-size:12px;margin:0}
fieldset{border:1px solid #666;margin:10px;padding:6px}
a.dbancora{color:#ff0000;text-decoration:underline}
input.desc{background-color:#deb887;border:1px solid #888}
input.btn{background:#cccccc}
td{font-size:12px}`;

const BTN = (name: string, value: string) =>
  `<input type="button" class="btn" name="${name}" value="${value}">`;
const LOOKUP = (label: string, name: string, desc: boolean) =>
  `<tr><td nowrap><a href="#" class="dbancora" onclick="return false"><b>${label}</b></a></td><td><input type="text" name="${name}" size="10" value="2026">${
    desc ? '<input type="text" class="desc" readonly size="40" value="DESCRIÇÃO EXEMPLO">' : ''
  }</td></tr>`;

const ROUTINE = `<html><head><title>Consulta Empenho</title><link rel="stylesheet" href="/estilos.css"></head>
<body>
<form name="form1"><fieldset><legend><b>Consulta Empenho</b></legend>
<table border="0">
${LOOKUP('Número do Empenho:', 'e60_codemp', true)}
${LOOKUP('Seq. Empenho:', 'e60_numemp', true)}
${LOOKUP('Reduzido:', 'o58_coddot', false)}
<tr><td><b>Data Emissão:</b></td><td><input type="text" name="d1" size="10">${BTN('b1', 'D')} a <input type="text" name="d2" size="10">${BTN('b2', 'D')}</td></tr>
<tr><td><b>Ordem:</b></td><td><select name="ordem"><option value="1">Número</option><option value="2">Data</option></select></td></tr>
<tr><td><b>Processo Administrativo:</b></td><td><input type="text" name="proc" size="30"></td></tr>
</table></fieldset>
<center>${BTN('pesquisar', 'Pesquisa')} ${BTN('limpar', 'Limpar campos')}</center></form></body></html>`;

const BOTTOM = `<html><head><link rel="stylesheet" href="/desk.css"></head><body style="margin:0;background:#c0c0c0;font:11px Arial">
<table width="100%"><tr><td>Instituição: PREFEITURA MUNICIPAL EXEMPLO</td><td>Departamento: SECRETARIA DE FINANÇAS</td><td>Usuário: ${USER}</td></tr></table></body></html>`;

/* ---- the real e-Cidade desktop (inspected live): window = #w1.dialog in the desktop page ---- */

const crc32 = (buf: Buffer): number => {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
};
/** A 1×1 PNG of one colour. */
function solidPng(r: number, g: number, b: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, r, g, b]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Rules nobody on the screen uses (the real e-Cidade ships whole stylesheets of them). */
const JUNK = Array.from(
  { length: 300 },
  (_, i) =>
    `.modulo-${i} .item-${i} > a:hover{color:#${(100000 + i).toString().slice(0, 6)};padding:${i}px}`,
).join('\n');

const ECIDADE_DESK_CSS = `
body{margin:0;background:#0a3a6b url(/assets/wallpaper.png) no-repeat fixed;background-size:cover;overflow:hidden;font:12px Arial}
.dialog{position:absolute;box-sizing:border-box}
.ecidade_window_buttons{position:absolute;right:8px;top:6px;z-index:5}
.ecidade_window_buttons .window_button{display:inline-block;margin-left:4px;cursor:pointer}
.ecidade_window_buttons .window_button:hover{opacity:.7}
.table_window{display:block;width:100%}
.top{height:28px;background:#4a789c;color:#fff}
.ecidade_n{height:28px;background:url(/assets/vendors/window/ecidade/n.png) repeat-x;overflow:hidden}
.ecidade_window_icon{float:left;width:25px;height:21px;margin-top:3px;background:url(/assets/vendors/window/ecidade/icon.png) center no-repeat}
.ecidade_title{font:14px/28px Arial;padding-left:4px}
.mid{height:801px;width:calc(100% - 6px);border-left:3px solid #4a789c;border-right:3px solid #4a789c;background:#e1dede;position:relative}
.ecidade_content{height:0}
#w1_content{border:0}
.bot{height:3px;width:calc(100% - 6px);background:#4a789c;border-left:3px solid #4a789c;border-right:3px solid #4a789c}
.ecidade_window_icon{animation:pisca 0s}
@keyframes pisca{from{opacity:.9}to{opacity:1}}
@keyframes gira-sem-uso{from{transform:rotate(0)}to{transform:rotate(1turn)}}
@font-face{font-family:FonteSemUso;src:local("Arial")}
@font-face{font-family:FonteUsada;src:local("Arial")}
.ecidade_title{font-family:FonteUsada,Arial}
.loader,.overlay-zero,.menu-oculto{position:absolute}
.loader{display:none}
.menu-oculto{visibility:hidden;width:200px;height:100px}
@media print{.dialog{display:none}}
@media (max-width:300px){.dialog{width:100px}}
.ecidade_title::after{content:""}
.sem-uso::before{content:"x"}
@media screen and (min-width:100px){.ecidade_title{letter-spacing:0}.sem-uso-media{color:red}}
${JUNK}`;

const ECIDADE_WINDOW_CSS = `
*{margin:0;padding:0;border:0}
iframe{width:100%;height:100%}
html,body,#sistema{width:100%;height:100%;position:absolute;top:0;left:0}
.quadro{width:100%}
#quadro-corpo{height:calc(100% - 20px)}
#quadro-status{height:20px}
.alertify-cover{position:fixed;inset:0;opacity:0}
.introjs-tooltip{max-width:300px}`;

const ECIDADE_ROUTINE_CSS = `
body{background:#e1dede;font-family:Arial,sans-serif;font-size:12px;margin:0}
fieldset{margin:10px auto;padding:6px;width:450px}
a.dbancora{color:#e02020;text-decoration:underline}
a.dbancora:hover{color:#0000ff}
input.desc{background-color:#deb887;border:1px solid #c08a50}
input.btn{background:#cccccc}
td{font-size:12px}
.nada-aqui:hover{color:red}`;

const ECIDADE_DESKTOP = `<!doctype html><html><head><title>e-Cidade</title>
<link rel="stylesheet" href="/ecidade-desk.css"></head><body>
<div id="w1" class="dialog ecidade" style="left:0;top:29px;width:1920px;height:832px;z-index:1">
  <div class="ecidade_window_buttons">
    <div data-type="dropdown" class="dropdown window_button"><img src="/assets/vendors/window/ecidade/help.png" alt="Central de Ajuda" title="Central de Ajuda" width="20" height="20"></div>
    <div class="window_button" title="Configurações da Janela"><img src="/assets/vendors/window/ecidade/setting.png" alt="Configurações" width="20" height="20"></div>
    <div class="window_button" title="Minimizar"><img src="/assets/vendors/window/ecidade/minimize.png" alt="Minimizar" width="20" height="20"></div>
    <div class="window_button" title="Maximizar"><img src="/assets/vendors/window/ecidade/maximize.png" alt="Maximizar" width="20" height="20"></div>
    <div class="window_button" title="Fechar"><img src="/assets/vendors/window/ecidade/close.png" alt="Fechar" width="20" height="20"></div>
  </div>
  <div id="w1_row1" class="top table_window top_draggable">
    <div class="ecidade_nw"></div><div class="ecidade_n"><div class="ecidade_window_icon"></div><div id="w1_top" class="ecidade_title title_window"> Consultas &gt; Consulta Empenho</div></div><div class="ecidade_ne"></div>
  </div>
  <div id="w1_row2" class="mid table_window">
    <div class="ecidade_w"></div>
    <div id="w1_table_content" class="ecidade_content">
      <iframe id="w1_content" src="/w/1/extension/desktop/window/index/?action=emp1_empconsulta001.php&eco=1" style="position:relative;height:801px;width:1914px"></iframe>
      <div id="w1_loader" class="loader">CARREGANDO_OCULTO</div>
      <div id="w1_overlay" class="overlay-zero" style="width:0;height:0"><span></span></div>
      <div class="menu-oculto"><a href="#">MENU_ESCONDIDO</a></div>
    </div>
  </div>
  <div class="bot"></div>
</div>
<div id="taskbar" style="position:absolute;left:0;bottom:0;height:30px">MENU DESKTOP CPF ${CPF}</div>
</body></html>`;

const ECIDADE_WINDOW = `<html><head><title>Janela</title><link rel="stylesheet" href="/ecidade-window.css"></head><body>
<div id="sistema"><div id="quadro-corpo" class="quadro"><iframe src="/w/1/emp1_empconsulta001.php?eco=1"></iframe></div>
<div id="quadro-status" class="quadro"><iframe src="/w/1/extension/desktop/window/bottom?eco=1"></iframe></div></div></body></html>`;

const ECIDADE_ROUTINE = ROUTINE.replace('/estilos.css', '/ecidade-estilos.css');

const ECIDADE_PNGS: Record<string, Buffer> = {
  '/assets/wallpaper.png': solidPng(200, 30, 30),
  '/assets/vendors/window/ecidade/n.png': solidPng(74, 120, 156),
  '/assets/vendors/window/ecidade/icon.png': solidPng(40, 160, 70),
  '/assets/vendors/window/ecidade/help.png': solidPng(20, 90, 160),
  '/assets/vendors/window/ecidade/setting.png': solidPng(20, 90, 160),
  '/assets/vendors/window/ecidade/minimize.png': solidPng(20, 90, 160),
  '/assets/vendors/window/ecidade/maximize.png': solidPng(20, 90, 160),
  '/assets/vendors/window/ecidade/close.png': solidPng(20, 90, 160),
};

describe.skipIf(!enabled)('e-Cidade desktop capture (real Chromium)', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '';
      const send = (type: string, body: string) => {
        res.setHeader('content-type', `${type}; charset=utf-8`);
        res.end(body);
      };
      const png = ECIDADE_PNGS[url.split('?')[0]!];
      if (png) {
        res.setHeader('content-type', 'image/png');
        res.end(png);
        return;
      }
      if (url.startsWith('/ecidade-desk.css')) send('text/css', ECIDADE_DESK_CSS);
      else if (url.startsWith('/ecidade-window.css')) send('text/css', ECIDADE_WINDOW_CSS);
      else if (url.startsWith('/ecidade-estilos.css')) send('text/css', ECIDADE_ROUTINE_CSS);
      else if (url.includes('eco=1') && url.startsWith('/w/1/extension/desktop/window/index/'))
        send('text/html', ECIDADE_WINDOW);
      else if (url.includes('eco=1') && url.startsWith('/w/1/extension/desktop/window/bottom'))
        send('text/html', BOTTOM);
      else if (url.includes('eco=1') && url.startsWith('/w/1/emp1_empconsulta001.php'))
        send('text/html', ECIDADE_ROUTINE);
      else if (url.startsWith('/ecidade')) send('text/html', ECIDADE_DESKTOP);
      else if (url.startsWith('/desk.css')) send('text/css', DESK_CSS);
      else if (url.startsWith('/estilos.css')) send('text/css', ROUTINE_CSS);
      else if (url.startsWith('/w/0/')) send('text/html', '<body>OUTRA JANELA</body>');
      else if (url.startsWith('/w/1/extension/desktop/window/index/'))
        send('text/html', wrapper(url.includes('t=1')));
      else if (url.startsWith('/w/1/extension/desktop/window/bottom')) send('text/html', BOTTOM);
      else if (url.startsWith('/w/1/emp1_empconsulta001.php')) send('text/html', ROUTINE);
      else send('text/html', desktop(url.includes('wrapper')));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function open(path: string, frames = 5, viewport = { width: 1280, height: 800 }) {
    let page: Page | undefined;
    const recorder = new PlaywrightRecorderBrowser({
      headless: true,
      onPageOpened: (p) => (page ??= p),
    });
    const handle: RecordingHandle = await recorder.start(
      { url: `${base}${path}`, viewport },
      LISTENER,
    );
    await vi.waitFor(() => expect(page!.frames()).toHaveLength(frames)); // desktop, 2 windows, routine, bottom
    for (const f of page!.frames()) await f.waitForLoadState('load');
    return { handle, page: page! };
  }

  for (const variant of [
    'title in the page around the window',
    'title inside the window',
  ] as const) {
    const wrapperTitle = variant === 'title inside the window';
    it(`captures the window, not the desktop (${variant})`, async () => {
      const { handle } = await open(
        wrapperTitle ? '/extension/desktop?wrapper' : '/extension/desktop',
      );
      try {
        // the user last worked on the desktop itself: the window in front is captured
        const screen = (await handle.capturePrototype(null))!;
        // size: the window (with its title bar and borders when those belong to the page around)
        if (wrapperTitle) expect([screen.width, screen.height]).toEqual([900, 620]);
        else expect([screen.width, screen.height]).toEqual([904, 648]);
        expect(screen.url).toBe(`${base}/w/1/emp1_empconsulta001.php`);
        expect(screen.title).toBe('Consulta Empenho');
        expect(screen.flattenedFrames).toBe(wrapperTitle ? 2 : 3);
        expect(screen.blankFrames).toBe(0);
        // nothing of the desktop around it
        for (const text of ['MENU', 'CPF', CPF, 'OUTRA JANELA'])
          expect(screen.html).not.toContain(text);
        // title bar, routine and status bar are all there
        expect(screen.html).toContain('Consultas &gt; Consulta Empenho');
        expect(screen.html).toContain('Número do Empenho:');
        expect(screen.html).toContain('Instituição: PREFEITURA MUNICIPAL EXEMPLO');
        expect(screen.html).not.toMatch(/<iframe|<script|<style|<link/i);
        // each frame's CSS is scoped to its div
        expect(screen.css).toMatch(/\[data-tf-frame="\d+"\] a\.dbancora/);

        const stored = prepareCapture(screen, { scrub: true });
        // LGPD: the user's name in the status bar went, the CPF never came
        expect(stored.snapshot.html).not.toContain(USER);
        expect(stored.snapshot.html).toContain('Usuário: Nome Exemplo');
        expect(stored.snapshot.html).not.toContain('2026"'); // typed values
        expect(stored.snapshot.html).not.toContain('DESCRIÇÃO EXEMPLO');
        expect(stored.components).toEqual({
          'window-title': 1,
          'status-bar': 1,
          fieldset: 1,
          lookup: 3,
          'date-range': 1,
          select: 1,
          field: 1,
          'button-bar': 1,
        });

        // render it as the editor would, then look at it
        const document = renderDocument(stored.snapshot.html, stored.snapshot.css);
        const browser = new ChromiumBrowser();
        const renderer = new ChromiumPrototypeRenderer(browser);
        const probe = await chromium.launch({ headless: true });
        try {
          const png = await renderer.render({
            document,
            width: stored.snapshot.width,
            height: stored.snapshot.height,
            scale: 1,
          });
          expect(png.ok).toBe(true);
          if (!png.ok) return;
          if (process.env.TF_PROTOTYPE_PNG) {
            writeFileSync(
              `${process.env.TF_PROTOTYPE_PNG}-${wrapperTitle ? 'wrapper' : 'page'}.png`,
              png.png,
            );
          }
          const page = await probe.newPage({
            viewport: { width: stored.snapshot.width, height: stored.snapshot.height },
          });
          await page.setContent(document);
          // computed styles: the scoped CSS applies inside the frame divs, and only there
          const styles = await page.evaluate(`(() => {
            const cs = (sel) => { const e = sel === 'ROUTINE' ? document.querySelector('[data-ec=lookup]').closest('[data-tf-frame]') : document.querySelector(sel); const c = getComputedStyle(e); return { color: c.color, deco: c.textDecorationLine, bg: c.backgroundColor, font: c.fontFamily, size: c.fontSize }; };
            return {
              label: cs('[data-ec-part=label]'),
              desc: cs('[data-ec-part=desc]'),
              routine: cs('ROUTINE'),
              status: cs('[data-ec=status-bar]'),
              title: document.querySelector('[data-ec=window-title]') ? cs('[data-ec=window-title]') : null,
            };
          })()`);
          const s = styles as Record<
            string,
            { color: string; deco: string; bg: string; font: string; size: string } | null
          >;
          expect(s.label!.color).toBe('rgb(255, 0, 0)');
          expect(s.label!.deco).toBe('underline');
          expect(s.desc!.bg).toBe('rgb(222, 184, 135)');
          expect(s.routine!.bg).toBe('rgb(238, 238, 238)');
          expect(s.routine!.font).toContain('Arial');
          expect(s.routine!.size).toBe('12px');
          expect(s.title!.bg === 'rgba(0, 0, 0, 0)' || s.title!.bg === 'rgb(26, 95, 180)').toBe(
            true,
          );

          // pixels of the rendered PNG: the blue title bar, the beige description, the grey routine
          const pixels = (await page.evaluate(
            `(async (b64) => {
              const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
              const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
              const g = c.getContext('2d'); g.drawImage(img, 0, 0);
              const at = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); const d = g.getImageData(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), 1, 1).data; return [d[0], d[1], d[2]]; };
              const t = document.querySelector('.wintitle');
              return { desc: at('[data-ec-part=desc]'), title: t ? at('.wintitle') : null, routine: [...g.getImageData(8, ${stored.snapshot.height} - 60, 1, 1).data].slice(0, 3) };
            })(${JSON.stringify(Buffer.from(png.png).toString('base64'))})`,
          )) as { desc: number[]; title: number[] | null; routine: number[] };
          expect(pixels.desc).toEqual([222, 184, 135]);
          if (pixels.title)
            expect(pixels.title.every((v, i) => Math.abs(v - [26, 95, 180][i]!) < 40)).toBe(true);
        } finally {
          await probe.close();
          await browser.close();
        }
      } finally {
        await handle.close();
      }
    }, 90_000);
  }

  it('captures the whole e-Cidade window (title bar, buttons, routine, status bar) with pruned CSS', async () => {
    const { handle } = await open('/ecidade', 4, { width: 1920, height: 1000 });
    try {
      const screen = (await handle.capturePrototype(null))!;
      // the window element of the desktop page (#w1), not just the iframe inside it
      expect([screen.width, screen.height]).toEqual([1920, 832]);
      expect(screen.flattenedFrames).toBe(3); // window, routine, status bar
      expect(screen.blankFrames).toBe(0);
      expect(screen.url).toBe(`${base}/w/1/emp1_empconsulta001.php?eco=1`);
      expect(screen.title).toBe('Consulta Empenho');

      const html = screen.html;
      expect(html).toContain('Consultas &gt; Consulta Empenho');
      expect(html).toContain('ecidade_window_buttons');
      expect(html.match(/class="window_button"|class="dropdown window_button"/g)).toHaveLength(5);
      // the routine and the status bar are inside the window, in this order
      const at = (text: string) => html.indexOf(text);
      expect(at('id="w1"')).toBeGreaterThanOrEqual(0);
      expect(at('id="w1"')).toBeLessThan(at('Consultas &gt; Consulta Empenho'));
      expect(at('Consultas &gt; Consulta Empenho')).toBeLessThan(at('Número do Empenho:'));
      expect(at('Número do Empenho:')).toBeLessThan(
        at('Instituição: PREFEITURA MUNICIPAL EXEMPLO'),
      );
      // nothing of the desktop around it, nothing hidden
      for (const text of [
        'MENU DESKTOP',
        CPF,
        'CARREGANDO_OCULTO',
        'MENU_ESCONDIDO',
        'w1_loader',
        'w1_overlay',
      ])
        expect(html).not.toContain(text);
      expect(html).not.toMatch(/<iframe|<script|<style|<link/i);
      // window chrome pictures are inlined (same origin), in the markup and in the CSS
      expect(html).not.toContain('/assets/vendors/window/ecidade/');
      expect(screen.css).not.toContain('/assets/vendors/window/ecidade/');
      expect(html.match(/src="data:image\/png/g)).toHaveLength(5);
      expect(screen.css).toMatch(/\.ecidade_n[^{]*\{[^}]*url\("data:image\/png/);
      expect(screen.css).toMatch(/\.ecidade_window_icon[^{]*\{[^}]*url\("data:image\/png/);

      // CSS pruned to what the screen uses
      const served = [ECIDADE_DESK_CSS, ECIDADE_WINDOW_CSS, ECIDADE_ROUTINE_CSS, DESK_CSS].join('');
      console.info(
        `e-Cidade fixture CSS: ${served.length} bytes served → ${screen.css.length} captured`,
      );
      expect(screen.css.length).toBeLessThan(30_000);
      expect(screen.css.length).toBeLessThan(served.length / 3);
      for (const unused of [
        '.modulo-12',
        'gira-sem-uso',
        'FonteSemUso',
        '@media print',
        'max-width:300px',
        'nada-aqui',
        'alertify',
        'wallpaper',
        'sem-uso',
      ])
        expect(screen.css).not.toContain(unused);
      expect(screen.css).not.toMatch(/data:image\/png[^"]*"\)\s*no-repeat\s*fixed/); // the desktop wallpaper
      expect(screen.css).toMatch(/@keyframes pisca-tf0|@keyframes pisca/);
      expect(screen.css).toContain('FonteUsada');
      expect(screen.css).toMatch(/\.ecidade_title:not\([^{]*\)::after/); // pseudo-elements are tested on their element
      expect(screen.css).toMatch(/@media screen and \(min-width: 100px\)\s*\{\s*\.ecidade_title/);
      expect(screen.css).toMatch(/\.ecidade_window_buttons \.window_button:hover/);
      expect(screen.css).toMatch(/a\.dbancora:hover/);
      // each document's rules stay in its own frame: the wrapper's `* { border: 0 }` never reaches the routine
      expect(screen.css).toMatch(
        /\[data-tf-frame="1"\] \*:not\(\[data-tf-frame="1"\] \[data-tf-frame\]/,
      );
      expect(screen.css).toContain('[data-tf-frame="1"]{all:initial;box-sizing:border-box}');
      expect(screen.css).not.toMatch(/\[data-tf-frame="\d+"\] [^{]*\{[^}]*all:\s*initial/);

      const stored = prepareCapture(screen, { scrub: true });
      expect(stored.snapshot.html).not.toContain(USER);
      expect(stored.components).toMatchObject({
        'window-title': 1,
        'status-bar': 1,
        fieldset: 1,
        lookup: 3,
        'date-range': 1,
      });

      // render it as the editor would, then look at it
      const browser = new ChromiumBrowser();
      const renderer = new ChromiumPrototypeRenderer(browser);
      const probe = await chromium.launch({ headless: true });
      try {
        const document = renderDocument(stored.snapshot.html, stored.snapshot.css);
        const png = await renderer.render({ document, width: 1920, height: 832, scale: 1 });
        expect(png.ok).toBe(true);
        if (!png.ok) return;
        if (process.env.TF_PROTOTYPE_PNG) {
          writeFileSync(`${process.env.TF_PROTOTYPE_PNG}-ecidade.png`, png.png);
        }
        const page = await probe.newPage({ viewport: { width: 1920, height: 832 } });
        await page.setContent(document);
        const look = (await page.evaluate(`(async (b64) => {
          const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          const px = (x, y) => [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
          const fs = document.querySelector('fieldset');
          const r = fs.getBoundingClientRect();
          const cs = getComputedStyle(fs);
          const title = document.querySelector('.title_window').getBoundingClientRect();
          const legend = document.querySelector('legend').getBoundingClientRect();
          const btn = document.querySelector('.ecidade_window_buttons').getBoundingClientRect();
          return {
            border: { width: cs.borderTopWidth, style: cs.borderTopStyle },
            fieldsetEdge: px(r.left + 1, r.top + r.height / 2),
            fieldsetOutside: px(r.left - 6, r.top + r.height / 2),
            titleBar: px(900, title.top + 2),
            legendBox: [Math.round(legend.width), Math.round(legend.height)],
            buttonsTop: Math.round(btn.top),
            inputBorder: getComputedStyle(document.querySelector('input[name=e60_codemp]')).borderTopWidth,
          };
        })(${JSON.stringify(Buffer.from(png.png).toString('base64'))})`)) as {
          border: { width: string; style: string };
          fieldsetEdge: number[];
          fieldsetOutside: number[];
          titleBar: number[];
          buttonsTop: number;
          inputBorder: string;
        };
        // the user-agent fieldset border survives (it used to be reset by the wrapper's `* { border: 0 }`)
        expect(parseFloat(look.border.width)).toBeGreaterThan(0);
        expect(look.border.style).not.toBe('none');
        expect(look.fieldsetEdge).not.toEqual(look.fieldsetOutside);
        // inputs keep the browser's own borders too
        expect(parseFloat(look.inputBorder)).toBeGreaterThan(0);
        // the blue title bar is painted
        expect(look.titleBar.every((v, i) => Math.abs(v - [74, 120, 156][i]!) < 30)).toBe(true);
        expect(look.buttonsTop).toBeLessThan(30);
      } finally {
        await probe.close();
        await browser.close();
      }
    } finally {
      await handle.close();
    }
  }, 120_000);

  it('walks up from the routine the user worked in, and picks the window in front on the desktop', async () => {
    const { handle, page } = await open('/extension/desktop');
    try {
      const routine = page.frames().find((f) => f.url().includes('/w/1/emp1_empconsulta001.php'))!;
      await routine.click('legend');
      const screen = (await handle.capturePrototype(null))!;
      expect(screen.html).toContain('Número do Empenho:');
      expect(screen.html).not.toContain('OUTRA JANELA');
    } finally {
      await handle.close();
    }
  }, 60_000);

  it('leaves frames of another origin as empty boxes and counts them', async () => {
    const other = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<body>OUTRA ORIGEM</body>');
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    const flat = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<title>Solta</title><body><p>Oi</p><iframe src="${otherBase}/x" style="width:300px;height:100px"></iframe></body>`,
      );
    });
    await new Promise<void>((r) => flat.listen(0, '127.0.0.1', r));
    const flatBase = `http://127.0.0.1:${(flat.address() as AddressInfo).port}`;
    let page: Page | undefined;
    const recorder = new PlaywrightRecorderBrowser({
      headless: true,
      onPageOpened: (p) => (page ??= p),
    });
    const handle = await recorder.start(
      { url: flatBase, viewport: { width: 800, height: 600 } },
      LISTENER,
    );
    try {
      await vi.waitFor(() => expect(page!.frames()).toHaveLength(2));
      const screen = (await handle.capturePrototype(null))!;
      expect(screen.flattenedFrames).toBe(0);
      expect(screen.blankFrames).toBe(1);
      expect(screen.html).toContain('data-tf-blank');
      expect(screen.html).not.toContain('OUTRA ORIGEM');
    } finally {
      await handle.close();
      await new Promise<void>((r) => other.close(() => r()));
      await new Promise<void>((r) => flat.close(() => r()));
    }
  }, 60_000);
});
