import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TestDownloadDto, TestSessionDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { cleanValues } from './data-tab';
import { json, sessionDetail, testDownload, testRun } from './fixtures';
import { TestSessionPage } from './session-page';

const base = { page: null, comment: null } as const;

function session(over: Partial<TestSessionDto> = {}): TestSessionDto {
  return sessionDetail({
    stepCount: 2,
    definition: {
      ...sessionDetail().definition,
      parameters: [
        { id: 'p1', name: 'email', label: 'E-mail', type: 'text', secret: false },
        { id: 'p2', name: 'senha', label: 'Senha', type: 'password', secret: true },
      ],
      dataSets: [
        { id: 'recorded', name: 'Gravado', values: { p1: 'ana@x.com', p2: { $secret: true } } },
      ],
      steps: [
        { ...base, id: 'a', at: 1, kind: 'goto', url: 'https://a.b', target: null },
        {
          ...base,
          id: 'b',
          at: 2,
          kind: 'click',
          target: {
            locators: [{ kind: 'role', role: 'button', name: 'Entrar' }],
            description: 'botão "Entrar"',
            bbox: null,
            frameUrl: null,
          },
        },
      ],
    },
    ...over,
  });
}

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/tests/:id', element: <TestSessionPage /> }], {
    initialEntries: ['/tests/s1?tab=data'],
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('data tab', () => {
  let current: TestSessionDto;
  let downloads: TestDownloadDto[];
  let calls: { method: string; url: string; body: unknown }[];

  beforeEach(() => {
    current = session();
    downloads = [];
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (method !== 'GET') calls.push({ method, url, body });
        if (url === '/api/tests/support')
          return json({ recording: { supported: true, message: '' } });
        if (url.startsWith('/api/tests/sessions/s1/downloads')) return json(downloads);
        if (url.endsWith('/data')) return json(current);
        if (url.endsWith('/runs')) return json([], 202);
        if (url === '/api/tests/sessions/s1') return json(current);
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('adds a data set, keeps the stored secret and saves', async () => {
    renderTab();
    expect(await screen.findByLabelText('E-mail em Gravado')).toBeTruthy();
    const secret = screen.getByLabelText('Senha em Gravado') as HTMLInputElement;
    expect(secret.type).toBe('password');
    expect(secret.placeholder).toBe('•••••• (guardado)');

    await userEvent.click(screen.getByRole('button', { name: /Conjunto de dados/ }));
    const name = screen.getByLabelText('Nome do conjunto 2');
    await userEvent.clear(name);
    await userEvent.type(name, 'E-mail inválido');
    await userEvent.type(screen.getByLabelText('E-mail em E-mail inválido'), 'ana@');
    await userEvent.click(screen.getByRole('button', { name: /Salvar dados/ }));

    await waitFor(() => expect(calls.at(-1)?.url).toBe('/api/tests/sessions/s1/data'));
    const body = calls.at(-1)!.body as { dataSets: { name: string; values: unknown }[] };
    expect(body.dataSets[0]!.values).toEqual({ p1: 'ana@x.com', p2: { $secret: true } });
    expect(body.dataSets[1]).toMatchObject({ name: 'E-mail inválido', values: { p1: 'ana@' } });
  });

  it('runs the chosen data set and shows the failing step with its screenshot', async () => {
    current = session({
      runs: [
        testRun({
          id: 'r1',
          status: 'failed',
          error: null,
          createdAt: 1,
          results: [
            {
              stepId: 'a',
              status: 'passed',
              durationMs: 5,
              error: null,
              locatorUsed: null,
              screenshotKey: null,
              screenshotUrl: null,
            },
            {
              stepId: 'b',
              status: 'failed',
              durationMs: 5,
              error: 'Elemento não encontrado: botão "Entrar"',
              locatorUsed: null,
              screenshotKey: 's1/runs/r1/b.png',
              screenshotUrl: '/api/tests/sessions/s1/images/runs/r1/b.png',
            },
          ],
        }),
      ],
    });
    renderTab();
    expect(await screen.findByText('Falhou')).toBeTruthy();
    expect(screen.getByText('Elemento não encontrado: botão "Entrar"')).toBeTruthy();
    expect(screen.getByAltText('Tela na falha do passo 2')).toBeTruthy();

    await userEvent.selectOptions(
      screen.getByLabelText('Conjunto de dados a executar'),
      'recorded',
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Ver a execução no navegador' }));
    await userEvent.click(screen.getByRole('button', { name: /Executar$/ }));
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/tests/sessions/s1/runs',
      body: { dataSetId: 'recorded', headed: true },
    });
  });

  describe('run history', () => {
    const rerun = (over = {}) => ({
      source: 'snapshot' as const,
      notice: null,
      warnings: [],
      possible: true,
      ...over,
    });
    const data = {
      dataSetName: 'Gravado',
      entries: [
        { paramId: 'p1', label: 'E-mail', secret: false, value: 'ana@x.com' },
        { paramId: 'p2', label: 'Senha', secret: true, value: null },
      ],
    };
    const result = (stepId: string, status: 'passed' | 'failed' = 'passed') => ({
      stepId,
      status,
      durationMs: 1,
      error: status === 'failed' ? 'Elemento não encontrado: botão "Entrar"' : null,
      locatorUsed: null,
      screenshotKey: null,
      screenshotUrl: null,
    });

    it('starts only the most recent run expanded; older ones open on click', async () => {
      current = session({
        runs: [
          testRun({ id: 'r3', seq: 3, createdAt: 3, results: [result('a')], rerun: rerun() }),
          testRun({
            id: 'r2',
            seq: 2,
            createdAt: 2,
            status: 'failed',
            results: [result('b', 'failed')],
            rerun: rerun(),
          }),
          testRun({
            id: 'r1',
            seq: 1,
            createdAt: 1,
            status: 'failed',
            results: [result('b', 'failed')],
          }),
        ],
      });
      renderTab();
      const toggles = await screen.findAllByRole('button', { name: /resultado/ });
      expect(toggles.map((b) => b.getAttribute('aria-expanded'))).toEqual([
        'true',
        'false',
        'false',
      ]);
      // an older failed run stays collapsed: its failure is not on the screen
      expect(screen.queryByText('Elemento não encontrado: botão "Entrar"')).toBeNull();

      await userEvent.click(toggles[1]!);
      expect(screen.getByText('Elemento não encontrado: botão "Entrar"')).toBeTruthy();
      expect(toggles[1]!.getAttribute('aria-expanded')).toBe('true');
      await userEvent.click(toggles[1]!);
      expect(screen.queryByText('Elemento não encontrado: botão "Entrar"')).toBeNull();
      // the latest one can be collapsed too
      await userEvent.click(toggles[0]!);
      expect(toggles[0]!.getAttribute('aria-expanded')).toBe('false');
    });

    it('expands the run in progress even when it is not the latest', async () => {
      current = session({
        state: 'running',
        runs: [
          testRun({ id: 'r2', seq: 2, createdAt: 2, status: 'queued', results: [] }),
          testRun({ id: 'r1', seq: 1, createdAt: 1, status: 'running', results: [result('a')] }),
        ],
      });
      renderTab();
      const toggles = await screen.findAllByRole('button', { name: /resultado/ });
      expect(toggles.map((b) => b.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
    });

    it('reproduces a finished run with its own data, as a new run', async () => {
      current = session({
        runs: [
          testRun({
            id: 'r1',
            seq: 4,
            status: 'failed',
            data,
            results: [result('b', 'failed')],
            rerun: rerun({ warnings: ['Valores alterados desde esta execução: "E-mail".'] }),
          }),
        ],
      });
      renderTab();
      await userEvent.click(
        await screen.findByRole('button', { name: 'Reproduzir esta execução' }),
      );
      expect(screen.getByText(/Valores alterados desde esta execução/)).toBeTruthy();
      // the data of the run, secret masked
      expect(screen.getAllByText('ana@x.com').length).toBeGreaterThan(0);
      expect(document.body.textContent).not.toContain('segredo');
      await userEvent.click(screen.getByRole('switch', { name: /Ver a reprodução da execução 4/ }));
      await userEvent.click(screen.getByRole('button', { name: /Executar reprodução/ }));
      await waitFor(() =>
        expect(calls.at(-1)).toMatchObject({
          method: 'POST',
          url: '/api/tests/sessions/s1/runs',
          body: { rerunOf: 'r1', headed: true },
        }),
      );
      expect(calls.at(-1)!.body).not.toHaveProperty('dataSetId');
    });

    it('says when an old run kept no data, and refuses when there is nothing to reproduce it with', async () => {
      current = session({
        runs: [
          testRun({
            id: 'r2',
            seq: 2,
            createdAt: 2,
            rerun: rerun({
              source: 'current',
              notice:
                'Valores atuais do conjunto "Gravado": a execução original não guardou os dados.',
            }),
          }),
          testRun({
            id: 'r1',
            seq: 1,
            createdAt: 1,
            rerun: rerun({
              source: 'current',
              possible: false,
              notice:
                'A execução original não guardou os dados e o conjunto de dados dela foi removido: não há como reproduzi-la.',
            }),
          }),
        ],
      });
      renderTab();
      const buttons = await screen.findAllByRole('button', { name: 'Reproduzir esta execução' });
      await userEvent.click(buttons[0]!);
      expect(
        screen.getByText(
          /Valores atuais do conjunto "Gravado": a execução original não guardou os dados/,
        ),
      ).toBeTruthy();
      expect(screen.getByText(/não guardou os dados que usou/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Executar reprodução/ })).toBeTruthy();

      // the second run cannot be reproduced: the notice explains, no run button
      await userEvent.click(
        screen.getAllByRole('button', { name: 'Reproduzir esta execução' })[1]!,
      );
      expect(screen.getByText(/conjunto de dados dela foi removido/)).toBeTruthy();
      expect(screen.getAllByRole('button', { name: /Executar reprodução/ })).toHaveLength(1);
    });

    it('offers no reproduction while something runs, nor for runs that did not finish', async () => {
      current = session({
        state: 'running',
        runs: [testRun({ id: 'r1', status: 'running', rerun: null })],
      });
      renderTab();
      await screen.findAllByText('Executando');
      expect(screen.queryByRole('button', { name: 'Reproduzir esta execução' })).toBeNull();
    });

    it('links a reproduction to the run it reproduces and lists the files a run downloaded', async () => {
      current = session({
        runs: [
          testRun({ id: 'r2', seq: 2, createdAt: 2, rerunOf: 'r1', rerunOfSeq: 1 }),
          testRun({ id: 'r1', seq: 1, createdAt: 1 }),
        ],
      });
      downloads = [
        testDownload({
          id: 'd1',
          runId: 'r2',
          runSeq: 2,
          source: 'replay',
          fileName: 'extrato.csv',
          fileUrl: '/api/tests/sessions/s1/downloads/d1/file',
        }),
      ];
      renderTab();
      expect(await screen.findByText('reprodução da execução #1')).toBeTruthy();
      expect(await screen.findByText('extrato.csv')).toBeTruthy();
      expect(screen.getByText('1 arquivo')).toBeTruthy();
      const link = screen.getByRole('link', { name: 'Baixar extrato.csv' });
      expect(link.getAttribute('href')).toBe('/api/tests/sessions/s1/downloads/d1/file');
    });
  });
});

describe('cleanValues', () => {
  const params = [
    { id: 'p1', name: 'email', label: 'E-mail', type: 'text' as const, secret: false },
    { id: 'p2', name: 'senha', label: 'Senha', type: 'password' as const, secret: true },
  ];
  it('keeps a cleared secret, drops blanks of other sets and keeps blanks of the recorded set', () => {
    const original = [
      { id: 'recorded', name: 'Gravado', values: { p1: 'a', p2: { $secret: true as const } } },
    ];
    expect(
      cleanValues(
        { id: 'recorded', name: 'Gravado', values: { p1: '', p2: '' } },
        0,
        params,
        original,
      ).values,
    ).toEqual({
      p1: '',
      p2: { $secret: true },
    });
    expect(
      cleanValues({ id: 'x', name: ' ', values: { p1: '', p2: 'nova' } }, 1, params, original),
    ).toEqual({
      id: 'x',
      name: 'Conjunto 2',
      values: { p2: 'nova' },
    });
  });
});
