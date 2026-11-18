import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TestDownloadDto, TestSessionDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { json, sessionDetail, testDownload } from './fixtures';
import { TestSessionPage } from './session-page';

const base = { page: null, comment: null } as const;

function session(over: Partial<TestSessionDto> = {}): TestSessionDto {
  return sessionDetail({
    stepCount: 2,
    definition: {
      ...sessionDetail().definition,
      steps: [
        { ...base, id: 'a', at: 1, kind: 'goto', url: 'https://a.b', target: null },
        {
          ...base,
          id: 'b',
          at: 2,
          kind: 'click',
          target: {
            locators: [{ kind: 'role', role: 'button', name: 'Exportar' }],
            description: 'botão "Exportar"',
            bbox: null,
            frameUrl: null,
          },
        },
      ],
    },
    ...over,
  });
}

function renderPage(entry = '/tests/s1?tab=downloads') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/tests/:id', element: <TestSessionPage /> }], {
    initialEntries: [entry],
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return router;
}

describe('downloads', () => {
  let current: TestSessionDto;
  let downloads: TestDownloadDto[];
  let calls: { method: string; url: string }[];

  beforeEach(() => {
    current = session();
    downloads = [];
    calls = [];
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method !== 'GET') calls.push({ method, url });
        if (url === '/api/tests/support')
          return json({ recording: { supported: true, message: '' } });
        if (method === 'DELETE' && url.includes('/downloads/')) {
          const id = url.split('/').at(-1);
          downloads = downloads.filter((d) => d.id !== id);
          current = { ...current, downloadCount: downloads.length };
          return json({ ok: true });
        }
        if (url.startsWith('/api/tests/sessions/s1/downloads')) return json(downloads);
        if (url === '/api/tests/sessions/s1') return json(current);
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('explains the empty state: files are kept apart from the document', async () => {
    renderPage();
    expect(await screen.findByText('Nenhum download ainda')).toBeTruthy();
    expect(screen.getByText(/não fazem parte do documento/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Downloads/ })).toBeTruthy();
  });

  it('lists the files with date, size, origin, step and status', async () => {
    current = session({ downloadCount: 3 });
    downloads = [
      testDownload({
        id: 'd3',
        source: 'replay',
        runId: 'r2',
        runSeq: 2,
        stepId: 'b',
        fileName: 'extrato.csv',
        size: 3 * 1024 * 1024,
        createdAt: new Date(2026, 10, 12, 14, 30, 5).getTime(),
        fileUrl: '/api/tests/sessions/s1/downloads/d3/file',
      }),
      testDownload({ id: 'd2', stepId: 'removido', fileName: 'antigo.pdf', size: 900 }),
      testDownload({
        id: 'd1',
        stepId: null,
        fileName: 'enorme.zip',
        size: 300 * 1024 * 1024,
        status: 'skipped',
        reason: 'Arquivo maior que 100 MB: não foi salvo.',
        fileUrl: null,
      }),
    ];
    renderPage();
    const tab = await screen.findByRole('tab', { name: /Downloads/ });
    expect(tab.textContent).toContain('3');
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(rows).toHaveLength(3);

    const [replay, removed, skipped] = rows.map((r) => within(r)) as [
      ReturnType<typeof within>,
      ReturnType<typeof within>,
      ReturnType<typeof within>,
    ];
    expect(replay.getByText('extrato.csv')).toBeTruthy();
    expect(replay.getByText('3,0 MB')).toBeTruthy();
    expect(replay.getByText(/12\/11\/2026/)).toBeTruthy();
    expect(replay.getByRole('link', { name: 'Replay #2' }).getAttribute('href')).toBe(
      '/tests/s1?tab=data#run-r2',
    );
    expect(replay.getByRole('link', { name: /^2\. / }).getAttribute('href')).toBe(
      '/tests/s1#step-b',
    );
    expect(replay.getByText('Salvo')).toBeTruthy();
    expect(replay.getByRole('link', { name: 'Baixar extrato.csv' }).getAttribute('href')).toBe(
      '/api/tests/sessions/s1/downloads/d3/file',
    );

    expect(removed.getByText('Gravação')).toBeTruthy();
    expect(removed.getByText('Passo removido')).toBeTruthy();
    expect(removed.getByText('900 B')).toBeTruthy();

    expect(skipped.getByText('sem passo')).toBeTruthy();
    expect(skipped.getByText('Não salvo')).toBeTruthy();
    expect(skipped.getByText('Arquivo maior que 100 MB: não foi salvo.')).toBeTruthy();
    // nothing to download when no file was stored
    expect(skipped.queryByRole('link', { name: /Baixar/ })).toBeNull();
  });

  it('deletes a file after confirming', async () => {
    current = session({ downloadCount: 1 });
    downloads = [testDownload({ id: 'd1', fileName: 'relatorio.xlsx' })];
    renderPage();
    await screen.findByText('relatorio.xlsx');
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    await userEvent.click(screen.getByRole('button', { name: 'Excluir relatorio.xlsx' }));
    expect(ask).toHaveBeenCalledOnce();
    expect(calls).toEqual([]); // declined: nothing deleted

    vi.stubGlobal('confirm', () => true);
    await userEvent.click(screen.getByRole('button', { name: 'Excluir relatorio.xlsx' }));
    await waitFor(() =>
      expect(calls).toEqual([{ method: 'DELETE', url: '/api/tests/sessions/s1/downloads/d1' }]),
    );
    expect(await screen.findByText('Nenhum download ainda')).toBeTruthy();
  });

  it('shows a chip on the steps that produced downloads, linking to the tab', async () => {
    current = session({
      downloadCount: 1,
      stepDownloads: { b: [{ id: 'd1', fileName: 'relatorio.xlsx' }] },
    });
    downloads = [testDownload({ id: 'd1', stepId: 'b' })];
    const router = renderPage('/tests/s1');
    const chip = await screen.findByRole('link', { name: /relatorio\.xlsx/ });
    expect(chip.textContent).toContain('⬇');
    // only the step that downloaded has it
    expect(screen.getAllByRole('link', { name: /relatorio\.xlsx/ })).toHaveLength(1);
    await userEvent.click(chip);
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(router.state.location.search).toBe('?tab=downloads');
    expect(router.state.location.hash).toBe('#download-d1');
  });
});
