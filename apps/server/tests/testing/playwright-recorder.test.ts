import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RecorderEvent } from '../../src/contexts/testing/domain/recorder-events';
import type { RecordingHandle } from '../../src/contexts/testing/domain/ports';
import { createScreenSettler } from '../../src/contexts/testing/domain/settle';
import { PlaywrightRecorderBrowser } from '../../src/contexts/testing/infrastructure/playwright/playwright-recorder';
import { newDefinition } from '../../src/contexts/testing/domain/session';
import {
  applyRecorderEvent,
  type RecordingState,
} from '../../src/contexts/testing/domain/step-builder';

// Real Chromium (headless): opt-in, like the PDF/diagram renderer tests.
const enabled = !!process.env.RUN_CHROMIUM_TESTS;
const FIXTURE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/test-recorder-page.html'),
  'utf8',
);

describe.skipIf(!enabled)('PlaywrightRecorderBrowser (real Chromium)', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url === '/host') {
        res.end(
          '<title>Host</title><iframe src="/w/1/rotina?q=1" style="position:absolute;left:0;top:0;width:300px;height:200px;border:0"></iframe>',
        );
        return;
      }
      if (req.url === '/slow-data') {
        // a request that is still in flight while the page looks idle
        setTimeout(() => res.end('{"ok":true}'), 900);
        return;
      }
      if (req.url === '/lenta') {
        res.end(
          '<title>Lenta</title><h1>Carregando…</h1><script>setTimeout(() => fetch("/slow-data").then(() => { document.body.insertAdjacentHTML("beforeend", "<p id=late>Dados prontos</p>"); }), 300);</script>',
        );
        return;
      }
      if (req.url?.startsWith('/w/')) {
        res.end('<button id="ok" style="position:absolute;left:0;top:0">Confirmar</button>');
        return;
      }
      res.end(req.url === '/outra' ? '<title>Outra</title><h1>Outra</h1>' : FIXTURE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('records clean steps with unique locators, masks the password and reports captures', async () => {
    const events: RecorderEvent[] = [];
    const captures: string[] = [];
    const checkpoints: string[] = [];
    let closed = false;
    let page: Page | undefined;
    const recorder = new PlaywrightRecorderBrowser({
      headless: true,
      navigationGraceMs: 1500,
      onPageOpened: (p) => (page ??= p),
    });
    const handle: RecordingHandle = await recorder.start(
      { url: `${base}/login`, viewport: { width: 1000, height: 700 } },
      {
        onDownload: () => undefined,
        onEvent: (e) => events.push(e),
        onCaptureRequest: (id) => captures.push(id),
        onPauseToggle: () => undefined,
        onCheckpointRequest: (id) => checkpoints.push(id),
        onPrototypeRequest: () => undefined,
        onClosed: () => (closed = true),
      },
    );
    try {
      const p = page!;
      await p.getByLabel('E-mail').fill('ana@exemplo.com');
      await p.getByLabel('Senha').fill('segredo-123');
      await p.getByLabel('UF').selectOption({ label: 'Rio de Janeiro' });
      await p.getByLabel('Aceito os termos').check();
      await p.getByTestId('entrar').click();
      await vi.waitFor(() => expect(events.some((e) => e.type === 'click')).toBe(true));

      // recording steps has no manual print: Ctrl+Shift+S does nothing
      await p.keyboard.press('Control+Shift+S');
      await new Promise((r) => setTimeout(r, 200));
      expect(captures).toHaveLength(0);

      // the toolbar never appears in screenshots, the password field is masked, and the print is
      // a real PNG at the window's size
      const shot = await handle.screenshot(null, { maskCss: ['input[type=password]'] });
      expect(shot).toMatchObject({ width: 1000, height: 700, page: { title: 'Entrar' } });
      expect(shot!.bytes.byteLength).toBeGreaterThan(1000);
      expect([...shot!.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

      let n = 0;
      let state: RecordingState = { definition: newDefinition({}), secrets: {} };
      for (const e of events) state = applyRecorderEvent(state, e, null, () => `id${++n}`);
      const steps = state.definition.steps;
      expect(steps.map((s) => s.kind)).toEqual(['fill', 'fill', 'select', 'check', 'click']);
      expect(steps[0]!.target!.locators[0]).toEqual({
        kind: 'role',
        role: 'textbox',
        name: 'E-mail',
      });
      expect(steps[1]!.target!.locators[0]).toEqual({ kind: 'label', text: 'Senha' });
      expect(steps[2]!.target!.locators[0]).toEqual({ kind: 'role', role: 'combobox', name: 'UF' });
      expect(steps[4]!.target!.locators[0]).toEqual({ kind: 'testid', value: 'entrar' });
      expect(state.definition.parameters.map((x) => [x.name, x.secret])).toEqual([
        ['e_mail', false],
        ['senha', true],
        ['uf', false],
      ]);
      expect(JSON.stringify(state.definition)).not.toContain('segredo-123');
      expect(Object.values(state.secrets.recorded ?? {})).toEqual(['segredo-123']);
      const uf = state.definition.parameters.find((x) => x.name === 'uf')!;
      expect(state.definition.dataSets[0]!.values[uf.id]).toBe('Rio de Janeiro');

      // "Verificar" (toolbar): reported as a checkpoint request; the page is left untouched and
      // the click on the page is a plain click again (no element-pick mode anymore)
      const before = events.length;
      await p.evaluate("window.__tfRecord({ kind: 'checkpoint' })");
      await vi.waitFor(() => expect(checkpoints).toHaveLength(1));
      expect(events.length).toBe(before);
      await p.getByTestId('entrar').click();
      await vi.waitFor(() => expect(events.length).toBe(before + 1));

      // "Só prints" (a session mode): actions are not reported, the capture shortcut works
      await handle.setState({ mode: 'capture' });
      const recorded = events.length;
      await p.getByLabel('E-mail').fill('outra@exemplo.com');
      await p.getByLabel('Aceito os termos').uncheck();
      await p.keyboard.press('Control+Shift+S');
      await vi.waitFor(() => expect(captures).toHaveLength(1));
      expect(events.length).toBe(recorded);
      await handle.setState({ mode: 'record' });

      // a navigation typed in the address bar (no action right before) becomes a goto
      await new Promise((r) => setTimeout(r, 1600));
      await p.goto(`${base}/outra`);
      await vi.waitFor(() =>
        expect(events.at(-1)).toMatchObject({ type: 'navigate', url: `${base}/outra` }),
      );
    } finally {
      await handle.close();
    }
    expect(closed).toBe(true);
  }, 60_000);

  it('knows when the screen settled: load, requests in flight and DOM changes', async () => {
    let page: Page | undefined;
    const recorder = new PlaywrightRecorderBrowser({
      headless: true,
      onPageOpened: (p) => (page ??= p),
    });
    const handle = await recorder.start(
      { url: `${base}/lenta`, viewport: { width: 1000, height: 700 } },
      {
        onDownload: () => undefined,
        onEvent: () => undefined,
        onCaptureRequest: () => undefined,
        onPauseToggle: () => undefined,
        onCheckpointRequest: () => undefined,
        onPrototypeRequest: () => undefined,
        onClosed: () => undefined,
      },
    );
    try {
      const p = page!;
      // soon after the load the page is still fetching: it is not settled
      await vi.waitFor(async () => {
        const r = await handle.settleReading(null);
        expect(r!.pendingRequests).toBeGreaterThan(0);
      });
      const started = Date.now();
      const outcome = await createScreenSettler().settle(() => handle.settleReading(null), {
        maxMs: 8000,
      });
      expect(outcome).toBe('settled');
      // the late content is there when the wait ends, and it did wait for it
      expect(await p.locator('#late').count()).toBe(1);
      expect(Date.now() - started).toBeGreaterThan(500);
      const quiet = await handle.settleReading(null);
      expect(quiet).toMatchObject({ loaded: true, pendingRequests: 0 });
      expect(quiet!.networkQuietMs).toBeGreaterThanOrEqual(500);
      expect(quiet!.domQuietMs).toBeGreaterThanOrEqual(400);
      // a page that was closed has nothing to read
      await p.close();
      expect(await handle.settleReading(null)).toBeNull();
    } finally {
      await handle.close();
    }
  }, 60_000);

  it('does not record clicks on empty space, in the page or in a frame', async () => {
    const events: RecorderEvent[] = [];
    let page: Page | undefined;
    const recorder = new PlaywrightRecorderBrowser({
      headless: true,
      navigationGraceMs: 1500,
      onPageOpened: (p) => (page ??= p),
    });
    const handle = await recorder.start(
      { url: `${base}/host`, viewport: { width: 1000, height: 700 } },
      {
        onDownload: () => undefined,
        onEvent: (e) => events.push(e),
        onCaptureRequest: () => undefined,
        onPauseToggle: () => undefined,
        onCheckpointRequest: () => undefined,
        onPrototypeRequest: () => undefined,
        onClosed: () => undefined,
      },
    );
    try {
      const p = page!;
      await p.waitForSelector('iframe');
      await p.mouse.click(900, 600); // the page background (html)
      await p.mouse.click(280, 190); // the frame's background
      await p.mouse.dblclick(900, 600);
      await p.frames()[1]!.getByRole('button', { name: 'Confirmar' }).click();
      await vi.waitFor(() => expect(events.some((e) => e.type === 'click')).toBe(true));
      const clicks = events.filter((e) => e.type === 'click' || e.type === 'dblclick');
      expect(clicks).toHaveLength(1);
      expect(clicks[0]).toMatchObject({
        facts: { tag: 'button', frameUrl: `${base}/w/1/rotina?q=1` },
      });
    } finally {
      await handle.close();
    }
  }, 60_000);

  it('reports the inner size of the window it opened', async () => {
    const recorder = new PlaywrightRecorderBrowser({ headless: true });
    const handle = await recorder.start(
      { url: `${base}/login`, viewport: { width: 1000, height: 700 } },
      {
        onDownload: () => undefined,
        onEvent: () => undefined,
        onCaptureRequest: () => undefined,
        onPauseToggle: () => undefined,
        onCheckpointRequest: () => undefined,
        onPrototypeRequest: () => undefined,
        onClosed: () => undefined,
      },
    );
    try {
      expect(handle.viewport).toEqual({ width: 1000, height: 700 });
    } finally {
      await handle.close();
    }
  }, 60_000);
});
