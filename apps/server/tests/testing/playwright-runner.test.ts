import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestDefinition, TestStep } from '@thinkflow/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunStepOutcome } from '../../src/contexts/testing/domain/ports';
import { newDefinition } from '../../src/contexts/testing/domain/session';
import { PlaywrightRunner } from '../../src/contexts/testing/infrastructure/playwright/playwright-runner';

const enabled = !!process.env.RUN_CHROMIUM_TESTS;
const FIXTURE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/test-recorder-page.html'),
  'utf8',
);

const base = { at: 1, page: null, comment: null } as const;
const target = (locators: NonNullable<TestStep['target']>['locators'], description: string) => ({
  locators,
  description,
  bbox: null,
  frameUrl: null,
});

function definition(url: string): TestDefinition {
  return {
    ...newDefinition({ viewport: { width: 1000, height: 700 } }),
    parameters: [
      { id: 'p1', name: 'email', label: 'E-mail', type: 'text', secret: false },
      { id: 'p2', name: 'senha', label: 'Senha', type: 'password', secret: true },
      { id: 'p3', name: 'uf', label: 'UF', type: 'option', secret: false },
    ],
    steps: [
      { ...base, id: 's1', kind: 'goto', url, target: null },
      {
        ...base,
        id: 's2',
        kind: 'fill',
        value: { param: 'p1' },
        target: target(
          [
            { kind: 'role', role: 'textbox', name: 'E-mail' },
            { kind: 'css', selector: '#email' },
          ],
          'campo "E-mail"',
        ),
      },
      {
        ...base,
        id: 's3',
        kind: 'fill',
        value: { param: 'p2' },
        target: target([{ kind: 'label', text: 'Senha' }], 'campo "Senha"'),
      },
      {
        ...base,
        id: 's4',
        kind: 'select',
        value: { param: 'p3' },
        target: target([{ kind: 'role', role: 'combobox', name: 'UF' }], 'lista "UF"'),
      },
      {
        ...base,
        id: 's5',
        kind: 'check',
        target: target([{ kind: 'label', text: 'Aceito os termos' }], 'caixa "Aceito os termos"'),
      },
      { ...base, id: 'n1', kind: 'note', comment: 'Usuário de homologação', target: null },
      { ...base, id: 'c1', kind: 'capture', target: null },
      {
        ...base,
        id: 's6',
        kind: 'click',
        target: target([{ kind: 'testid', value: 'entrar' }], 'botão "Entrar"'),
      },
      { ...base, id: 'k1', kind: 'checkpoint', target: null },
      {
        ...base,
        id: 's7',
        kind: 'assert',
        assertion: { type: 'textVisible', text: 'Bem-vinda, ana@exemplo.com' },
        target: null,
      },
      {
        ...base,
        id: 's8',
        kind: 'assert',
        assertion: { type: 'value', value: { param: 'p3' } },
        target: target([{ kind: 'role', role: 'combobox', name: 'UF' }], 'lista "UF"'),
      },
      {
        ...base,
        id: 's9',
        kind: 'assert',
        assertion: { type: 'title', text: 'Entrar' },
        target: null,
      },
    ],
  };
}

describe.skipIf(!enabled)('PlaywrightRunner (real Chromium)', () => {
  let server: http.Server;
  let url: string;
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(FIXTURE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/login`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function run(def: TestDefinition, values: Record<string, string>) {
    const results: (RunStepOutcome & { stepId: string })[] = [];
    await new PlaywrightRunner({ stepTimeoutMs: 2000 }).run(
      {
        definition: def,
        values,
        headed: false,
        maskCss: ['input[type=password]'],
        signal: new AbortController().signal,
        maxDownloadBytes: 1024 * 1024,
        onDownload: () => undefined,
      },
      async (stepId, outcome) => {
        results.push({ stepId, ...outcome });
      },
    );
    return results;
  }

  const values = { p1: 'ana@exemplo.com', p2: 'segredo', p3: 'Rio de Janeiro' };

  it('replays the recorded values and passes every check', async () => {
    const results = await run(definition(url), values);
    expect(results.map((r) => [r.stepId, r.status])).toEqual([
      ['s1', 'passed'],
      ['s2', 'passed'],
      ['s3', 'passed'],
      ['s4', 'passed'],
      ['s5', 'passed'],
      ['n1', 'skipped'],
      ['c1', 'skipped'], // a print is documentation, not an action
      ['s6', 'passed'],
      ['k1', 'passed'], // "Verificar": passes without interacting
      ['s7', 'passed'],
      ['s8', 'passed'],
      ['s9', 'passed'],
    ]);
    expect(results[1]!.locatorUsed).toBe(0);
    // the checkpoint keeps a screenshot of that moment (and only it, among the passed steps)
    expect(results.filter((r) => r.screenshot).map((r) => r.stepId)).toEqual(['k1']);
    expect(results.find((r) => r.stepId === 'k1')!.screenshot!.byteLength).toBeGreaterThan(1000);
  }, 60_000);

  it('fails the check with other data, with a screenshot, and skips the rest', async () => {
    const results = await run(definition(url), { ...values, p1: 'bia@exemplo.com' });
    const failed = results.find((r) => r.status === 'failed')!;
    expect(failed.stepId).toBe('s7');
    expect(failed.error).toBe('Texto não encontrado na página: "Bem-vinda, ana@exemplo.com"');
    expect(failed.screenshot!.byteLength).toBeGreaterThan(1000);
    expect(results.slice(-2).map((r) => r.status)).toEqual(['skipped', 'skipped']);
  }, 60_000);

  it('falls back to the next locator when the best one no longer matches', async () => {
    const def = definition(url);
    const email = def.steps[1]!;
    email.target!.locators[0] = { kind: 'role', role: 'textbox', name: 'Endereço de e-mail' };
    const results = await run(def, values);
    expect(results.find((r) => r.stepId === 's2')).toMatchObject({
      status: 'passed',
      locatorUsed: 1,
    });
    expect(results.every((r) => r.status !== 'failed')).toBe(true);
  }, 60_000);

  it('explains an element that is gone', async () => {
    const def = definition(url);
    def.steps[7]!.target!.locators = [{ kind: 'testid', value: 'nao-existe' }];
    const results = await run(def, values);
    expect(results.find((r) => r.status === 'failed')).toMatchObject({
      stepId: 's6',
      error: 'Elemento não encontrado: botão "Entrar"',
    });
  }, 60_000);

  describe('frames and empty space', () => {
    let site: http.Server;
    let origin: string;
    const clicked: string[] = [];
    beforeAll(async () => {
      site = http.createServer((req, res) => {
        const u = req.url ?? '/';
        if (u.startsWith('/clicked')) {
          clicked.push(decodeURIComponent(u.split('?f=')[1] ?? ''));
          res.end('ok');
          return;
        }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        if (u.startsWith('/w/')) {
          res.end(
            `<button onclick="fetch('/clicked?f=' + encodeURIComponent(location.pathname + location.search))">Gravar</button>`,
          );
          return;
        }
        // html has no height here, like the desktop that motivated the "empty space" no-op
        res.end(
          '<title>Desktop</title><style>html,body{height:0;margin:0}</style>' +
            '<iframe src="/w/2/rotina?codigo=77"></iframe>' +
            '<iframe src="/w/5/rotina?codigo=88"></iframe>',
        );
      });
      await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
      origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => site.close(() => r())));

    const frameClick = (frameUrl: string | null, id: string): TestStep => ({
      ...base,
      id,
      kind: 'click',
      target: {
        locators: [{ kind: 'role', role: 'button', name: 'Gravar' }],
        description: 'botão "Gravar"',
        bbox: null,
        frameUrl,
      },
    });

    const flow = (steps: TestStep[]): TestDefinition => ({
      ...newDefinition({ viewport: { width: 800, height: 600 } }),
      steps: [{ ...base, id: 'g', kind: 'goto', url: `${origin}/`, target: null }, ...steps],
    });

    it('finds the frame when its query or numbered window differs from the recording', async () => {
      clicked.length = 0;
      const results = await run(
        flow([
          // same path, other query (typed data changed)
          frameClick(`${origin}/w/2/rotina?codigo=1`, 'a'),
          // other window number, other query: the numbered segment is ignored
          frameClick(`${origin}/w/9/rotina?codigo=1`, 'b'),
          // nothing alike: every frame is searched, the first one with a single match wins
          frameClick(`${origin}/sumiu/rotina`, 'c'),
        ]),
        {},
      );
      expect(results.map((r) => [r.stepId, r.status])).toEqual([
        ['g', 'passed'],
        ['a', 'passed'],
        ['b', 'passed'],
        ['c', 'passed'],
      ]);
      // "a" prefers the same path (window 2); "b" and "c" fall to the first frame in order
      await vi.waitFor(() =>
        expect(clicked).toEqual([
          '/w/2/rotina?codigo=77',
          '/w/2/rotina?codigo=77',
          '/w/2/rotina?codigo=77',
        ]),
      );
    }, 60_000);

    it('prefers the closer frame over the one that comes first', async () => {
      clicked.length = 0;
      const results = await run(
        flow([
          frameClick(`${origin}/w/5/rotina?codigo=1`, 'a'), // same path as the 2nd frame
          frameClick(`${origin}/w/5/rotina?codigo=88`, 'b'), // identical to the 2nd frame
        ]),
        {},
      );
      expect(results.every((r) => r.status === 'passed')).toBe(true);
      await vi.waitFor(() =>
        expect(clicked).toEqual(['/w/5/rotina?codigo=88', '/w/5/rotina?codigo=88']),
      );
    }, 60_000);

    it('passes clicks recorded on empty space (html/body) without touching the page', async () => {
      const empty = (id: string, kind: 'click' | 'dblclick', selector: string): TestStep => ({
        ...base,
        id,
        kind,
        target: {
          locators: [{ kind: 'css', selector }],
          description: 'elemento',
          bbox: null,
          frameUrl: null,
        },
      });
      const results = await run(
        flow([
          empty('h', 'click', 'html'),
          empty('b', 'dblclick', 'body'),
          {
            ...base,
            id: 't',
            kind: 'assert',
            assertion: { type: 'title', text: 'Desktop' },
            target: null,
          },
        ]),
        {},
      );
      expect(results.map((r) => [r.stepId, r.status, r.locatorUsed])).toEqual([
        ['g', 'passed', null],
        ['h', 'passed', null],
        ['b', 'passed', null],
        ['t', 'passed', null],
      ]);
    }, 60_000);
  });
});
