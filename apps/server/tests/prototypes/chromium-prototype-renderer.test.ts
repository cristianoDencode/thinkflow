import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { afterAll, describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES } from '../../src/contexts/prototypes/domain/builtin-templates';
import { prepareSnapshot, renderDocument } from '../../src/contexts/prototypes/domain/prototype';
import { blockDocument, markSceneLayers } from '../../src/contexts/prototypes/domain/scene';
import { ChromiumPrototypeRenderer } from '../../src/contexts/prototypes/infrastructure/chromium-prototype-renderer';
import { pngSize } from '../../src/contexts/testing/application/evidence-service';
import { ChromiumBrowser } from '../../src/contexts/reports/infrastructure/chromium/chromium-browser';

// 2x2 red PNG as a data URI, drawn at 100x100 so the pixels are easy to find
const RED =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4EIwESMolGFBA0A5JgDEYgLjbMAAAAASUVORK5CYII=';

// Real Chromium: slow and needs the browser installed, so it is opt-in (RUN_CHROMIUM_TESTS=1).
describe.skipIf(!process.env.RUN_CHROMIUM_TESTS)(
  'ChromiumPrototypeRenderer (real Chromium)',
  () => {
    const browser = new ChromiumBrowser();
    const renderer = new ChromiumPrototypeRenderer(browser);
    afterAll(async () => {
      await browser.close();
    });

    const doc = (extra = '') =>
      renderDocument(
        `<body style="margin:0;background:#fff"><h1 style="font-family:sans-serif">Consulta</h1><img src="${RED}" width="100" height="100" style="display:block">${extra}</body>`,
        'h1{color:#036}',
      );

    it('renders at exactly width×height, and at twice that with scale 2', async () => {
      const one = await renderer.render({ document: doc(), width: 640, height: 480, scale: 1 });
      expect(one.ok).toBe(true);
      if (!one.ok) return;
      expect(pngSize(one.png)).toEqual({ width: 640, height: 480 });
      expect(one).toMatchObject({ width: 640, height: 480, blockedRequests: 0 });

      const two = await renderer.render({ document: doc(), width: 640, height: 480, scale: 2 });
      expect(two.ok).toBe(true);
      if (two.ok) expect(pngSize(two.png)).toEqual({ width: 1280, height: 960 });
    }, 60_000);

    it('renders the built-in e-Cidade window at both sizes with every image inlined', async () => {
      const { html, css } = BUILTIN_TEMPLATES[0]!.snapshot;
      for (const [width, height] of [
        [1366, 768],
        [1920, 1080],
      ] as const) {
        const res = await renderer.render({
          document: renderDocument(html, css),
          width,
          height,
          scale: 1,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(pngSize(res.png)).toEqual({ width, height });
        expect(res.blockedRequests).toBe(0);
        expect(res.png.byteLength).toBeGreaterThan(5_000); // not a blank page
      }
    }, 60_000);

    it('has no JavaScript and no network: external requests are blocked and counted', async () => {
      let hits = 0;
      const server = http.createServer((_req, res) => {
        hits += 1;
        res.end('x');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const res = await renderer.render({
          document: doc(
            `<img src="http://127.0.0.1:${port}/a.png"><link rel="stylesheet" href="http://127.0.0.1:${port}/s.css"><script>document.title='x';fetch('http://127.0.0.1:${port}/js')</script>`,
          ),
          width: 400,
          height: 300,
          scale: 1,
        });
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.blockedRequests).toBeGreaterThanOrEqual(2);
        expect(hits).toBe(0);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }, 60_000);

    describe('decompose and renderBlock', () => {
      // a red box and a blue box on a grey page; the second one is half outside the viewport
      const page = (extra = '') =>
        renderDocument(
          `<body style="margin:0;background:#ccc"><div data-tf-layer="1" style="position:absolute;left:30px;top:40px;width:120px;height:50px;background:red"></div><div data-tf-layer="2" style="position:absolute;left:350px;top:260px;width:100px;height:100px;background:blue"></div><div data-tf-layer="3" style="display:none">x</div><div data-tf-layer="4" style="position:absolute;left:500px;top:10px;width:20px;height:20px"></div><p>fundo</p>${extra}</body>`,
          'p{margin:200px 0 0 10px;font:14px sans-serif}',
        );

      it('cuts the marked elements out and hides them in the background (JavaScript off)', async () => {
        const res = await renderer.decompose({
          document: page(),
          width: 400,
          height: 300,
          scale: 1,
          layerCount: 4,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(
          res.layers.map((l) => ({ n: l.n, x: l.x, y: l.y, width: l.width, height: l.height })),
        ).toEqual([
          { n: 1, x: 30, y: 40, width: 120, height: 50 },
          { n: 2, x: 350, y: 260, width: 50, height: 40 }, // clipped to the 400×300 viewport
        ]);
        expect(res.layers.map((l) => pngSize(l.png))).toEqual([
          { width: 120, height: 50 },
          { width: 50, height: 40 },
        ]);
        expect(pngSize(res.background)).toEqual({ width: 400, height: 300 });

        // the background is the page with those elements hidden — same layout, nothing moved
        const hidden = await renderer.render({
          document: page('<style>[data-tf-layer]{visibility:hidden!important}</style>'),
          width: 400,
          height: 300,
          scale: 1,
        });
        expect(hidden.ok).toBe(true);
        if (hidden.ok)
          expect(Buffer.from(res.background).equals(Buffer.from(hidden.png))).toBe(true);
        // ...and differs from the page with them visible
        const shown = await renderer.render({
          document: page(),
          width: 400,
          height: 300,
          scale: 1,
        });
        if (shown.ok)
          expect(Buffer.from(res.background).equals(Buffer.from(shown.png))).toBe(false);
      }, 60_000);

      it('cuts a container without the layers inside it, and a loose control as a layer', async () => {
        // a fieldset-like frame (container, depth 0) with a field inside, plus a loose button
        const fixture = (inner: string, button: string) =>
          renderDocument(
            `<body style="margin:0;background:#ccc"><div data-tf-layer="1" data-tf-container="0" style="position:absolute;left:20px;top:20px;width:200px;height:150px;box-sizing:border-box;border:2px solid #000;background:#eef">${inner}</div>${button}</body>`,
            '',
          );
        const field = (attrs: string, extra = '') =>
          `<div ${attrs} style="position:absolute;left:20px;top:40px;width:80px;height:30px;background:red;${extra}"></div>`;
        const button = (attrs: string) =>
          `<div ${attrs} style="position:absolute;left:250px;top:200px;width:60px;height:24px;background:blue"></div>`;
        const size = { width: 400, height: 300, scale: 1 as const, layerCount: 3 };

        const res = await renderer.decompose({
          document: fixture(field('data-tf-layer="2"'), button('data-tf-layer="3"')),
          ...size,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.layers.map((l) => [l.n, l.x, l.y, l.width, l.height])).toEqual([
          [1, 20, 20, 200, 150],
          [2, 42, 62, 80, 30],
          [3, 250, 200, 60, 24],
        ]);
        const bytes = (png: Uint8Array) => Buffer.from(png);
        const container = bytes(res.layers[0]!.png);

        // the container image = the frame with the field (hidden by its own style) not drawn...
        const without = await renderer.decompose({
          document: fixture(field('', 'visibility:hidden'), button('data-tf-layer="3"')),
          ...size,
          layerCount: 3,
        });
        expect(without.ok).toBe(true);
        if (without.ok) expect(container.equals(bytes(without.layers[0]!.png))).toBe(true);
        // ...and differs from the frame with the field drawn inside it
        const withField = await renderer.decompose({
          document: fixture(field(''), button('data-tf-layer="3"')),
          ...size,
        });
        expect(withField.ok).toBe(true);
        if (withField.ok) expect(container.equals(bytes(withField.layers[0]!.png))).toBe(false);

        // the background has neither the frame, the field nor the button
        const empty = await renderer.render({
          document: fixture('', '').replace('data-tf-layer="1"', 'style="display:none"'),
          width: 400,
          height: 300,
          scale: 1,
        });
        expect(empty.ok).toBe(true);
        if (empty.ok) expect(bytes(res.background).equals(bytes(empty.png))).toBe(true);
      }, 60_000);

      it('draws a block on the window background and cuts it to its own size', async () => {
        const res = await renderer.renderBlock({
          document: blockDocument('<input value="abc" style="width:80px;height:16px">', ''),
          width: 1600,
          height: 1200,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        const size = pngSize(res.png)!;
        expect(size.width).toBe(res.width);
        expect(size.height).toBe(res.height);
        expect(size.width).toBeLessThan(200); // the element, not the 1600px viewport
        expect(size.height).toBeLessThan(60);
      }, 60_000);
    });

    describe('freeLayout', () => {
      // contextual selectors (`form table td`, an `#id` rule) only match inside the original
      // surroundings: the copies must carry what they give
      const FIXTURE_CSS = `body{margin:0;background:#e0e0e0;font:11px Arial}
form table td{font:bold 12px Arial;color:#036;padding:3px}
#ro{background:#deb887;text-transform:uppercase}
fieldset{border:2px groove #888;margin:10px 20px;padding:6px;width:300px}
legend{color:#a00;font-weight:bold}
form input[type=button]{padding:3px 12px;margin:4px 40px;border:1px solid #444;background:#ccc}`;
      const FIXTURE_HTML = `<body><form><fieldset data-ec="fieldset"><legend data-ec-part="legend">Filtros</legend>
<table cellpadding="2"><tbody>
<tr data-ec="lookup"><td data-ec-part="label">Reduzido:</td><td><input data-ec-part="input" size="8" value="12"></td><td><input id="ro" data-ec-part="desc" size="14" readonly value="descrição"></td></tr>
<tr data-ec="date"><td data-ec-part="label">Emissão:</td><td colspan="2"><input data-ec-part="input" size="10" value="01/01/2026"></td></tr>
</tbody></table></fieldset>
<input type="button" value="Limpar campos"></form></body>`;
      const SIZE = { width: 480, height: 260 } as const;

      const convert = async (html: string, css: string) => {
        const marked = markSceneLayers(html);
        const res = await renderer.freeLayout({
          document: renderDocument(marked.html, css),
          ...SIZE,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error(res.error);
        return { marked, html: prepareSnapshot({ html: res.html, css, ...SIZE }).html };
      };

      /** Share of pixels whose colors differ by more than a few levels (PNG decoded with canvas). */
      const diffRatio = async (a: Uint8Array, b: Uint8Array): Promise<number> => {
        const pixels = async (png: Uint8Array) => {
          const img = await loadImage(Buffer.from(png));
          const canvas = createCanvas(img.width, img.height);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          return {
            n: img.width * img.height,
            data: ctx.getImageData(0, 0, img.width, img.height).data,
          };
        };
        const [pa, pb] = [await pixels(a), await pixels(b)];
        expect(pb.n).toBe(pa.n);
        let different = 0;
        for (let i = 0; i < pa.n; i++) {
          const d = Math.max(
            Math.abs(pa.data[4 * i]! - pb.data[4 * i]!),
            Math.abs(pa.data[4 * i + 1]! - pb.data[4 * i + 1]!),
            Math.abs(pa.data[4 * i + 2]! - pb.data[4 * i + 2]!),
          );
          if (d > 24) different += 1;
        }
        return different / pa.n;
      };

      const draw = async (html: string, css: string) => {
        const res = await renderer.render({
          document: renderDocument(html, css),
          ...SIZE,
          scale: 1,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error(res.error);
        return res.png;
      };

      it('copies every component into a positioned wrapper and hides the originals', async () => {
        const { marked, html } = await convert(FIXTURE_HTML, FIXTURE_CSS);
        // fieldset (group), the two rows, the loose button; the inputs belong to their rows
        expect(marked.layers.map((l) => l.kind)).toEqual(['fieldset', 'lookup', 'date', 'button']);
        const wrappers = [...html.matchAll(/<div data-tf-free="(\d+)" style="([^"]*)"/g)];
        expect(wrappers.map((m) => m[1])).toEqual(['1', '2', '3', '4']);
        for (const m of wrappers) {
          expect(m[2]).toMatch(/position:\s*absolute/);
          expect(m[2]).toMatch(/left:\s*[\d.]+px/);
          expect(m[2]).toMatch(/top:\s*[\d.]+px/);
          expect(m[2]).toMatch(new RegExp(`z-index:\\s*${m[1]}`));
        }
        for (const n of [1, 2, 3, 4]) expect(html).toContain(`data-tf-free-src="${n}"`);
        expect(html).toMatch(/<body[^>]*position:\s*relative/);
        // marks never leak; recognizable components stay recognizable
        expect(html).not.toMatch(/data-tf-layer|data-tf-container|data-tf-ph/);
        expect(html).toContain('data-ec="lookup"');
        expect(html).toContain('data-ec-part="label"');
        // the rows are wrapped in a table; the group copy has no row left but keeps its size
        expect(html).toMatch(/data-tf-free="2"[^>]*><table/);
        const group = /data-tf-free="1"[\s\S]*?(?=<div data-tf-free="2")/.exec(html)![0];
        expect(group).not.toContain('data-ec="lookup"');
        expect(group).toContain('<legend');
        expect(group).toMatch(/width:\s*[\d.]+px;\s*height:\s*[\d.]+px/);
        // no duplicated ids: the copies have none, the originals keep theirs
        expect(html.match(/ id="ro"/g)).toHaveLength(1);
      }, 60_000);

      it('draws the converted screen the same as the original (≤ 2% of the pixels differ)', async () => {
        const { html } = await convert(FIXTURE_HTML, FIXTURE_CSS);
        const before = await draw(FIXTURE_HTML, FIXTURE_CSS);
        expect(await diffRatio(before, await draw(html, FIXTURE_CSS))).toBeLessThanOrEqual(0.02);

        // independent of the context: without the rules that depend on it (`form table td`, `#ro`,
        // `form input[type=button]`) the copies still look the same, the original does not
        const plain = `body{margin:0;background:#e0e0e0;font:11px Arial}
fieldset{border:2px groove #888;margin:10px 20px;padding:6px;width:300px}
legend{color:#a00;font-weight:bold}`;
        expect(await diffRatio(before, await draw(html, plain))).toBeLessThanOrEqual(0.02);
        expect(await diffRatio(before, await draw(FIXTURE_HTML, plain))).toBeGreaterThan(0.05);
      }, 60_000);

      it('keeps the copies independent: moving a wrapper moves the component, not its twin', async () => {
        const { html } = await convert(FIXTURE_HTML, FIXTURE_CSS);
        const moved = html.replace(
          /(<div data-tf-free="4" style="[^"]*?)left:\s*[\d.]+px/,
          '$1left: 300px',
        );
        expect(moved).not.toBe(html);
        const [a, b] = [await draw(html, FIXTURE_CSS), await draw(moved, FIXTURE_CSS)];
        expect(await diffRatio(a, b)).toBeGreaterThan(0.001);
      }, 60_000);

      it('runs no script of the page, loads nothing from the network and leaves a screen with no layer alone', async () => {
        let hits = 0;
        const server = http.createServer((_req, res) => {
          hits += 1;
          res.end('x');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as AddressInfo;
        try {
          // deliberately NOT sanitized: the CSP must stop what the sanitizer already removes
          const raw = `<body data-x="1"><script>document.body.setAttribute('data-ran','1');fetch('http://127.0.0.1:${port}/js')</script><img src="x" onerror="document.body.setAttribute('data-ran','2')"><img src="http://127.0.0.1:${port}/a.png"><input type="button" data-tf-layer="1" value="Ok" style="position:absolute;left:10px;top:10px"></body>`;
          const res = await renderer.freeLayout({ document: renderDocument(raw, ''), ...SIZE });
          expect(res.ok).toBe(true);
          if (!res.ok) return;
          expect(res.html).not.toMatch(/data-ran=/);
          expect(res.html).toContain('data-tf-free="1"');
          expect(hits).toBe(0);
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      }, 60_000);
    });
  },
);
