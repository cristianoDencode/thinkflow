import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { HistoryPage } from './history-page';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function conv(overrides: Partial<ConversationDto> & { id: string }): ConversationDto {
  const now = Date.now();
  return {
    title: overrides.id,
    mode: 'chat',
    model: 'groq/llama',
    createdAt: now,
    updatedAt: now,
    pinned: false,
    parentConversationId: null,
    forkedFromMessageId: null,
    messageCount: 2,
    preview: 'prévia da conversa',
    hasSummary: false,
    libraryId: null,
    preset: null,
    databaseId: null,
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/history', element: <HistoryPage /> },
      { path: '/', element: <p>chat aberto</p> },
      { path: '/dados', element: <p>dados aberto</p> },
    ],
    { initialEntries: ['/history'] },
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

describe('HistoryPage', () => {
  let urls: string[];
  let patches: { url: string; body: unknown }[];

  beforeEach(() => {
    urls = [];
    patches = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          patches.push({ url, body: JSON.parse(String(init.body)) });
          return json({});
        }
        if (url.startsWith('/api/conversations')) {
          urls.push(url);
          return json([
            conv({ id: 'a', title: 'Fixada importante', pinned: true }),
            conv({ id: 'b', title: 'Conversa de hoje', parentConversationId: 'a' }),
            conv({ id: 'c', title: 'Antiga', updatedAt: Date.now() - 10 * 86_400_000 }),
            conv({
              id: 'd',
              title: 'Débitos do IPTU',
              mode: 'data',
              databaseId: 'db-1',
              updatedAt: Date.now() - 60_000,
            }),
            conv({
              id: 'e',
              title: 'Relatório de arrecadação',
              preset: { kind: 'report', templateId: 't1' },
              libraryId: 'lib-1',
              updatedAt: Date.now() - 120_000,
            }),
            conv({ id: 'f', title: 'Tarefa do agente', mode: 'agent' }),
          ]);
        }
        if (url === '/api/databases') return json([{ id: 'db-1', name: 'e-Cidade' }]);
        if (url === '/api/libraries') return json([{ id: 'lib-1', name: 'Manuais' }]);
        return json({});
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders date group headers and the derived badge', async () => {
    renderPage();
    expect(await screen.findByText('Fixada importante')).toBeInTheDocument();
    for (const label of ['Fixadas', 'Hoje', 'Últimos 30 dias'])
      expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
    expect(screen.getByText('Derivada')).toBeInTheDocument();
  });

  it('sends the debounced search to the server', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Fixada importante');
    await user.type(screen.getByLabelText('Buscar conversas'), 'banco');
    await waitFor(() => expect(urls.some((u) => u.includes('q=banco'))).toBe(true));
  });

  it('renames through the dialog with PATCH', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Conversa de hoje');
    await user.click(screen.getByRole('button', { name: 'Renomear conversa Conversa de hoje' }));
    const input = screen.getByLabelText('Título');
    await user.clear(input);
    await user.type(input, 'Novo nome');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(patches).toEqual([{ url: '/api/conversations/b', body: { title: 'Novo nome' } }]),
    );
  });

  it('toggles pin and navigates on Continuar', async () => {
    const user = userEvent.setup();
    const router = renderPage();
    await screen.findByText('Conversa de hoje');
    await user.click(screen.getByRole('button', { name: 'Fixar conversa Conversa de hoje' }));
    await waitFor(() =>
      expect(patches).toEqual([{ url: '/api/conversations/b', body: { pinned: true } }]),
    );
    await user.click(screen.getAllByRole('button', { name: 'Continuar' })[1]!);
    await waitFor(() => expect(router.state.location.search).toBe('?c=b'));
  });

  it('labels each conversation with its origin (connection, document kind, library)', async () => {
    renderPage();
    await screen.findByText('Débitos do IPTU');
    expect(screen.getByText('Dados com IA · e-Cidade')).toBeInTheDocument();
    expect(screen.getByText('Documento · Relatório')).toBeInTheDocument();
    expect(screen.getByText('Biblioteca · Manuais')).toBeInTheDocument();
    expect(screen.getAllByText('Pergunte à AI').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Agente').length).toBeGreaterThan(0);
  });

  it('filters by origin and connection on the server', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Conversa de hoje');
    await user.click(screen.getByRole('tab', { name: 'Documentos' }));
    await waitFor(() => expect(urls.some((u) => u.includes('origin=document'))).toBe(true));
    await user.click(screen.getByRole('tab', { name: 'Dados com IA' }));
    await waitFor(() => expect(urls.some((u) => u.includes('origin=data'))).toBe(true));
    await user.selectOptions(screen.getByLabelText('Conexão de banco'), 'db-1');
    await waitFor(() =>
      expect(urls.some((u) => u.includes('origin=data') && u.includes('databaseId=db-1'))).toBe(
        true,
      ),
    );
  });

  it('filters by period (preset and custom days) and clears the filters', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Conversa de hoje');
    await user.selectOptions(screen.getByLabelText('Período'), '7d');
    await waitFor(() => expect(urls.some((u) => /from=\d+/.test(u))).toBe(true));

    await user.selectOptions(screen.getByLabelText('Período'), 'custom');
    await user.type(screen.getByLabelText('Data inicial'), '2026-01-05');
    await user.type(screen.getByLabelText('Data final'), '2026-01-10');
    const from = new Date(2026, 0, 5).getTime();
    const to = new Date(2026, 0, 10, 23, 59, 59, 999).getTime();
    await waitFor(() =>
      expect(urls.some((u) => u.includes(`from=${from}`) && u.includes(`to=${to}`))).toBe(true),
    );

    await user.click(screen.getByRole('switch', { name: 'Só fixadas' }));
    await waitFor(() => expect(urls.at(-1)).toContain('pinned=true'));
    await user.click(screen.getByRole('button', { name: /Limpar filtros/ }));
    await waitFor(() => expect(urls.at(-1)).toBe('/api/conversations?limit=50'));
  });

  it('continues a data conversation on /dados', async () => {
    const user = userEvent.setup();
    const router = renderPage();
    await screen.findByText('Débitos do IPTU');
    await user.click(screen.getByRole('button', { name: 'Abrir conversa Débitos do IPTU' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/dados'));
    expect(router.state.location.search).toBe('?c=d');
  });
});
