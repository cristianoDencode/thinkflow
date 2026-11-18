import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CapturedDownload, DownloadFile } from '../../src/contexts/testing/domain/download';
import type { RunStepOutcome } from '../../src/contexts/testing/domain/ports';
import { newDefinition } from '../../src/contexts/testing/domain/session';
import { PlaywrightRecorderBrowser } from '../../src/contexts/testing/infrastructure/playwright/playwright-recorder';
import { PlaywrightRunner } from '../../src/contexts/testing/infrastructure/playwright/playwright-runner';

// Real Chromium (headless): opt-in, like the other browser tests.
const enabled = !!process.env.RUN_CHROMIUM_TESTS;
const FIXTURE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/test-downloads-page.html'),
  'utf8',
);

describe.skipIf(!enabled)('downloads in the recorded and replayed browser (real Chromium)', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/files/rel.csv') {
        res.setHeader('content-type', 'text/csv');
        res.end('a;b\n1;2\n');
      } else if (url.startsWith('/attachment')) {
        res.setHeader('content-type', 'text/plain');
        res.setHeader('content-disposition', 'attachment; filename="anexo.txt"');
        res.end('conteudo do anexo');
      } else if (url === '/popup') {
        // a new tab that only exists to download
        res.setHeader('content-type', 'text/html');
        res.end(
          '<title>Popup</title><script>location.href = "/attachment?from=popup"; setTimeout(() => window.close(), 300);</script>',
        );
      } else if (url === '/big') {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(Buffer.alloc(5000, 1));
      } else if (url === '/broken') {
        // promises 1000 bytes and drops the connection after 10
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': '1000',
          'content-disposition': 'attachment; filename="quebrado.bin"',
        });
        res.write(Buffer.alloc(10));
        setTimeout(() => res.destroy(), 100);
      } else if (url === '/slow') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="lento.bin"',
        });
        res.write('inicio-');
        setTimeout(() => res.end('fim'), 700);
      } else {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(FIXTURE);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const text = (file: DownloadFile) =>
    file.status === 'ready' ? new TextDecoder().decode(file.bytes) : file.status;

  async function openRecorder(maxDownloadBytes = 1024 * 1024) {
    const captures: { download: CapturedDownload; pageId: string }[] = [];
    let page: Page | undefined;
    const recorder = new PlaywrightRecorderBrowser({
      headless: true,
      onPageOpened: (p) => (page ??= p),
    });
    const handle = await recorder.start(
      { url: `${base}/`, viewport: { width: 1000, height: 700 }, maxDownloadBytes },
      {
        onDownload: (download, pageId) => captures.push({ download, pageId }),
        onEvent: () => undefined,
        onCaptureRequest: () => undefined,
        onPauseToggle: () => undefined,
        onCheckpointRequest: () => undefined,
        onPrototypeRequest: () => undefined,
        onClosed: () => undefined,
      },
    );
    return { captures, handle, page: () => page! };
  }

  it('recorder: takes the file of every page, with the suggested name and no query string', async () => {
    const { captures, handle, page } = await openRecorder(1500);
    try {
      const p = page();
      await p.locator('#attr').click(); // <a download>
      await vi.waitFor(() => expect(captures).toHaveLength(1));
      await p.locator('#attach').click(); // Content-Disposition: attachment
      await vi.waitFor(() => expect(captures).toHaveLength(2));
      await p.locator('#popup').click(); // a new tab that downloads
      await vi.waitFor(() => expect(captures).toHaveLength(3));
      await p.locator('#big').click();
      await vi.waitFor(() => expect(captures).toHaveLength(4));
      await p.locator('#broken').click();
      await vi.waitFor(() => expect(captures).toHaveLength(5));

      const [attr, attach, popup, big, broken] = captures;
      expect(attr!.download).toMatchObject({
        fileName: 'relatório.csv',
        url: `${base}/files/rel.csv`,
      });
      expect(text(await attr!.download.file)).toBe('a;b\n1;2\n');
      expect(attach!.download.fileName).toBe('anexo.txt');
      expect(attach!.download.url).toBe(`${base}/attachment`); // ?token=… is gone
      expect(text(await attach!.download.file)).toBe('conteudo do anexo');
      // the popup is another page: its own id
      expect(popup!.pageId).not.toBe(attr!.pageId);
      expect(popup!.download.url).toBe(`${base}/attachment`);
      expect(text(await popup!.download.file)).toBe('conteudo do anexo');
      // over the limit: measured, never read
      expect(await big!.download.file).toEqual({ status: 'skipped', size: 5000 });
      // the connection dropped halfway
      expect(await broken!.download.file).toMatchObject({ status: 'failed' });
      expect(Math.abs(attr!.download.at - Date.now())).toBeLessThan(30_000);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it('recorder: closing waits for the downloads still in flight', async () => {
    const { captures, handle, page } = await openRecorder();
    await page().locator('#slow').click();
    await vi.waitFor(() => expect(captures).toHaveLength(1));
    await handle.close(); // the file is still arriving: close waits for it
    expect(text(await captures[0]!.download.file)).toBe('inicio-fim');
  }, 60_000);

  it('runner: reports the downloads of the replay with the step that was running', async () => {
    const step = (id: string, selector: string) => ({
      id,
      at: 1,
      page: null,
      comment: null,
      kind: 'click' as const,
      target: {
        locators: [{ kind: 'css' as const, selector }],
        description: selector,
        bbox: null,
        frameUrl: null,
      },
    });
    const definition = {
      ...newDefinition({ viewport: { width: 1000, height: 700 } }),
      steps: [
        {
          id: 'g',
          at: 1,
          page: null,
          comment: null,
          kind: 'goto' as const,
          url: `${base}/`,
          target: null,
        },
        step('s-attr', '#attr'),
        step('s-attach', '#attach'),
        step('s-popup', '#popup'),
      ],
    };
    const downloads: { stepId: string | null; download: CapturedDownload }[] = [];
    const outcomes: (RunStepOutcome & { stepId: string })[] = [];
    await new PlaywrightRunner({ stepTimeoutMs: 5000 }).run(
      {
        definition,
        values: {},
        headed: false,
        maskCss: [],
        signal: new AbortController().signal,
        maxDownloadBytes: 1024 * 1024,
        onDownload: (download, stepId) => downloads.push({ stepId, download }),
      },
      async (stepId, outcome) => {
        outcomes.push({ stepId, ...outcome });
      },
    );
    expect(outcomes.map((o) => o.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(downloads.map((d) => [d.stepId, d.download.fileName])).toEqual([
      ['s-attr', 'relatório.csv'],
      ['s-attach', 'anexo.txt'],
      ['s-popup', 'anexo.txt'],
    ]);
    expect(text(await downloads[0]!.download.file)).toBe('a;b\n1;2\n');
    expect(text(await downloads[2]!.download.file)).toBe('conteudo do anexo');
  }, 60_000);
});
