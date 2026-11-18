import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReportDetailDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { json, reportDetail } from './fixtures';
import { ReportDetailPage } from './report-detail-page';

vi.mock('../chat/markdown', () => ({
  Markdown: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/reports/:id', element: <ReportDetailPage /> },
      { path: '/reports', element: <p>lista</p> },
    ],
    { initialEntries: ['/reports/r1'] },
  );
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return router;
}

describe('ReportDetailPage', () => {
  let detail: ReportDetailDto;
  let renderer: unknown;
  let calls: { url: string; method: string; body: unknown }[];

  beforeEach(() => {
    detail = reportDetail();
    renderer = { pdf: true, diagrams: true, reason: null, executablePath: '/usr/bin/chromium' };
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url === '/api/reports/renderer')
          return renderer ? json(renderer) : json({ error: { message: 'nf' } }, 404);
        if (url === '/api/reports/r1' && method === 'GET') return json(detail);
        if (url === '/api/models') return json([{ id: 'auto', label: 'Auto', kind: 'combo' }]);
        if (url === '/api/libraries') return json([{ id: 'lib1', name: 'Docs' }]);
        if (method === 'POST') return json({ ok: true, documentId: 'd1' }, 202);
        return json({});
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the pending-upload hint only when storage is pending', async () => {
    detail = reportDetail({ storage: 'pending' });
    renderPage();
    expect(
      await screen.findByText(/Documento salvo localmente; será enviado ao armazenamento/),
    ).toBeTruthy();
  });

  it('renders sections, TOC, warnings and the metadata card', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: '1. Resumo' })).toBeTruthy();
    expect(screen.getByText('Texto dos detalhes')).toBeTruthy();
    expect(screen.getByText('Dado não verificado')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Seções' })).toBeTruthy();
    expect(screen.getByText('Sobre este documento')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Baixar PDF/ })).toBeTruthy();
  });

  it('disables the PDF button when the renderer is unavailable', async () => {
    renderer = { pdf: false, diagrams: false, reason: 'Sem Chromium', executablePath: null };
    renderPage();
    await screen.findByRole('heading', { name: '1. Resumo' });
    const btn = await screen.findByRole('button', { name: /Baixar PDF/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
    expect(btn.getAttribute('title')).toBe('Sem Chromium');
  });

  it('falls back to Markdown only when /renderer does not exist', async () => {
    renderer = null;
    renderPage();
    await screen.findByRole('heading', { name: '1. Resumo' });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Baixar PDF/ })).toBeNull());
    expect(screen.getByRole('button', { name: /Markdown/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Adicionar à Biblioteca/ })).toBeNull();
  });

  it('regenerates a section with instructions', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Regenerar a seção Detalhes' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Instruções/), 'mais curto');
    await user.click(within(dialog).getByRole('button', { name: 'Regenerar' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/reports/r1/sections/2/regenerate')?.body).toEqual({
        instructions: 'mais curto',
        model: 'auto',
      }),
    );
  });

  it('adds the report to a library', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Adicionar à Biblioteca/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Docs' });
    await user.click(within(dialog).getByRole('button', { name: 'Adicionar' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/reports/r1/library')?.body).toEqual({
        libraryId: 'lib1',
      }),
    );
    expect(await within(dialog).findByRole('status')).toBeTruthy();
  });

  it('polls every 2 s while the job is running and offers cancel', async () => {
    detail = reportDetail({
      status: 'writing',
      progress: { phase: 'writing', current: 1, total: 2, label: 'Escrevendo seção 1 de 2' },
      sections: reportDetail().sections.map((s, i) => ({
        ...s,
        status: i === 0 ? 'writing' : 'pending',
      })),
    });
    renderPage();
    expect(await screen.findByText('Escrevendo seção 1 de 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cancelar/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Regenerar a seção/ })).toBeNull();
    const count = () => calls.filter((c) => c.url === '/api/reports/r1').length;
    const before = count();
    await waitFor(() => expect(count()).toBeGreaterThan(before), { timeout: 4000 });
  });

  it('shows Retomar for failed jobs and posts retry', async () => {
    const user = userEvent.setup();
    detail = reportDetail({ status: 'error', error: 'falhou', sections: [] });
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Retomar/ }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/reports/r1/retry')).toBe(true));
    expect(screen.getByRole('alert').textContent).toMatch(/falhou/);
  });
});
