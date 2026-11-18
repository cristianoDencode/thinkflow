import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReportDto, ReportTemplateSummaryDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { json, report, summary, template } from './fixtures';
import { ReportsPage } from './reports-page';

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname}</p>;
}

function renderPage(initial = '/reports') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/reports', element: <ReportsPage /> },
      { path: '/reports/templates/new', element: <Where /> },
      { path: '/reports/:id', element: <Where /> },
      { path: '/reports/templates/:id', element: <Where /> },
    ],
    { initialEntries: [initial] },
  );
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { router, ...view };
}

describe('ReportsPage', () => {
  let templates: ReportTemplateSummaryDto[];
  let reports: ReportDto[];
  let posted: unknown;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    templates = [
      summary({
        id: 'b1',
        name: 'Análise técnica (genérico)',
        builtIn: true,
        usesMcp: true,
        sectionCount: 8,
        variableCount: 2,
      }),
      summary({ id: 'b2', name: 'PRD de funcionalidade', kind: 'prd', builtIn: true }),
      summary({ id: 'u1', name: 'Meu guia', description: 'Guia meu' }),
    ];
    reports = [];
    posted = null;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/report-templates/b1/duplicate' && init?.method === 'POST')
        return json({ id: 'copy1', name: 'Análise técnica (genérico) (cópia)' }, 201);
      if (url === '/api/report-templates/u1' && init?.method === 'DELETE') {
        templates = templates.filter((t) => t.id !== 'u1');
        return json({ ok: true });
      }
      if (url.startsWith('/api/report-templates/b1')) return json(template({ id: 'b1' }));
      if (url.startsWith('/api/report-templates')) return json(templates);
      if (url === '/api/reports/renderer')
        return json({
          pdf: false,
          diagrams: false,
          reason: 'Chromium não encontrado.',
          executablePath: null,
        });
      if (url === '/api/reports/settings') return json({ defaultModel: '' });
      if (url === '/api/models') return json([{ id: 'auto', label: 'Auto', kind: 'combo' }]);
      if (url === '/api/libraries') return json([{ id: 'lib1', name: 'Docs' }]);
      if (url === '/api/reports' && init?.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return json(report({ id: 'new1' }), 201);
      }
      if (url.startsWith('/api/reports')) return json(reports);
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the generated-reports placeholder first and the two tabs', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Relatórios' })).toBeTruthy();
    expect(
      screen.getByRole('tab', { name: 'Relatórios gerados' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByRole('tab', { name: 'Modelos' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(await screen.findByText('Nenhum relatório gerado ainda')).toBeTruthy();
  });

  it('lists reports with status labels and progress, and the renderer notice', async () => {
    reports = [
      report({
        id: 'r1',
        title: 'Relatório de IA',
        status: 'writing',
        progress: { phase: 'writing', current: 2, total: 4, label: 'Escrevendo seção 2 de 4' },
      }),
      report({ id: 'r2', title: 'Resumo pronto', kind: 'summary', status: 'done', hasPdf: false }),
    ];
    renderPage();
    expect(await screen.findByText('Relatório de IA')).toBeTruthy();
    expect(screen.getAllByText('Escrevendo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Concluído').length).toBeGreaterThan(1);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('Escrevendo seção 2 de 4')).toBeTruthy();
    expect(await screen.findByText('PDF indisponível neste servidor')).toBeTruthy();
    // no renderer -> no PDF link
    expect(screen.queryByRole('link', { name: /Baixar PDF/ })).toBeNull();
  });

  it('creates a report from the dialog, validating required variables', async () => {
    const user = userEvent.setup();
    const { router } = renderPage();
    await user.click(await screen.findByRole('button', { name: /Novo relatório/ }));
    const dialog = await screen.findByRole('dialog');
    const tema = await within(dialog).findByLabelText(/Tema/);
    await user.click(within(dialog).getByRole('button', { name: 'Gerar' }));
    expect(within(dialog).getByText('Campo obrigatório')).toBeTruthy();
    expect(posted).toBeNull();
    await user.type(tema, 'IA generativa');
    await user.type(within(dialog).getByLabelText(/Instruções adicionais/), 'Foque em custos');
    await user.click(within(dialog).getByRole('switch', { name: /MCP/ }));
    expect(within(dialog).getByRole('note').textContent).toMatch(/sem supervisão/);
    await user.selectOptions(within(dialog).getByLabelText('Biblioteca'), 'lib1');
    await user.click(within(dialog).getByRole('button', { name: 'Gerar' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/reports/new1'));
    expect(posted).toEqual({
      templateId: 'b1',
      model: 'auto',
      variables: { tema: 'IA generativa' },
      brief: 'Foque em custos',
      libraryId: 'lib1',
      useMcp: true,
    });
  });

  it('switches to Modelos, syncs ?tab=modelos and groups templates by kind', async () => {
    const user = userEvent.setup();
    const { router } = renderPage();
    await user.click(screen.getByRole('tab', { name: 'Modelos' }));
    expect(router.state.location.search).toBe('?tab=modelos');
    expect(await screen.findByText('Análise técnica (genérico)')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Relatório' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'PRD' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Protótipo' })).toBeNull();
    expect(screen.getAllByText('Padrão')).toHaveLength(2);
    expect(screen.getByText('Usa MCP')).toBeTruthy();
    expect(screen.getByText(/8 seções · 2 variáveis/)).toBeTruthy();
  });

  it('opens directly on the Modelos tab from the URL', async () => {
    renderPage('/reports?tab=modelos');
    expect(await screen.findByText('Meu guia')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Novo modelo/ })).toBeTruthy();
  });

  it('offers only Ver/Duplicar for built-in templates and Editar/Duplicar/Excluir for custom ones', async () => {
    renderPage('/reports?tab=modelos');
    await screen.findByText('Meu guia');
    expect(screen.getByRole('link', { name: 'Ver Análise técnica (genérico)' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Duplicar para editar Análise técnica (genérico)' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Excluir Análise técnica (genérico)' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Editar Meu guia' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Duplicar Meu guia' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Excluir Meu guia' })).toBeTruthy();
  });

  it('duplicates a built-in and opens the copy in the editor', async () => {
    const user = userEvent.setup();
    renderPage('/reports?tab=modelos');
    await user.click(
      await screen.findByRole('button', {
        name: 'Duplicar para editar Análise técnica (genérico)',
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/reports/templates/copy1'),
    );
    expect(
      fetchMock.mock.calls.some(
        ([u, i]) =>
          u === '/api/report-templates/b1/duplicate' && (i as RequestInit).method === 'POST',
      ),
    ).toBe(true);
  });

  it('deletes a custom template after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage('/reports?tab=modelos');
    await user.click(await screen.findByRole('button', { name: 'Excluir Meu guia' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) => u === '/api/report-templates/u1' && (i as RequestInit)?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('Meu guia')).toBeNull());
  });

  it('keeps the template when the confirmation is refused', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderPage('/reports?tab=modelos');
    await user.click(await screen.findByRole('button', { name: 'Excluir Meu guia' }));
    expect(
      fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);
    expect(within(document.body).getByText('Meu guia')).toBeTruthy();
  });
});
