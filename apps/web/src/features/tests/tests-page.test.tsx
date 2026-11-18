import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TestSessionSummaryDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { json, sessionDetail, sessionSummary } from './fixtures';
import { TestSessionPage } from './session-page';
import { TestsPage } from './tests-page';

function renderAt(initial: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/tests', element: <TestsPage /> },
      { path: '/tests/:id', element: <TestSessionPage /> },
    ],
    { initialEntries: [initial] },
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

describe('Testes', () => {
  let sessions: TestSessionSummaryDto[];
  let supported: boolean;
  let posted: unknown;

  beforeEach(() => {
    sessions = [];
    supported = true;
    posted = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/tests/support')
          return json({
            recording: { supported, message: supported ? '' : 'Rode o servidor na sua máquina.' },
          });
        if (url === '/api/storage/status') return json(null, 404);
        if (url === '/api/tests/sessions' && init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          return json(sessionDetail({ id: 'new1', name: 'Login' }), 201);
        }
        if (url === '/api/tests/sessions') return json(sessions);
        if (url.startsWith('/api/tests/sessions/'))
          return json(
            sessionDetail({
              id: 'new1',
              name: 'Login',
              stepCount: 2,
              definition: {
                ...sessionDetail().definition,
                parameters: [
                  { id: 'p1', name: 'senha', label: 'Senha', type: 'password', secret: true },
                ],
                dataSets: [{ id: 'recorded', name: 'Gravado', values: { p1: { $secret: true } } }],
                steps: [
                  {
                    id: 'a',
                    at: 1,
                    kind: 'goto',
                    url: 'https://a.b/login',
                    target: null,
                    page: null,
                    comment: null,
                  },
                  {
                    id: 'b',
                    at: 2,
                    kind: 'fill',
                    value: { param: 'p1' },
                    target: {
                      locators: [{ kind: 'label', text: 'Senha' }],
                      description: 'campo Senha',
                      bbox: null,
                      frameUrl: null,
                    },
                    page: { url: 'https://a.b/login', title: 'Entrar' },
                    comment: null,
                  },
                ],
              },
            }),
          );
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the empty state and creates a session that opens its page', async () => {
    const router = renderAt('/tests');
    expect(screen.getByRole('heading', { name: 'Testes' })).toBeTruthy();
    expect(await screen.findByText('Nenhuma sessão de teste ainda')).toBeTruthy();

    await userEvent.click(screen.getAllByRole('button', { name: /Nova sessão/ })[0]!);
    await userEvent.type(screen.getByLabelText('Nome'), 'Login');
    const url = screen.getByLabelText('URL inicial');
    await userEvent.clear(url);
    await userEvent.type(url, 'https://a.b/login');
    await userEvent.click(screen.getByRole('switch', { name: 'Print automático a cada passo' }));
    await userEvent.click(screen.getByRole('button', { name: 'Criar sessão' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/tests/new1'));
    expect(posted).toEqual({ name: 'Login', startUrl: 'https://a.b/login', autoThumbnails: false });
    // the session page lists the steps, with secrets masked
    expect(await screen.findByText('Abrir https://a.b/login')).toBeTruthy();
    expect(screen.getByText('Preencher campo Senha com "••••••"')).toBeTruthy();
  });

  it('lists sessions with counters and warns when recording is not supported', async () => {
    supported = false;
    sessions = [
      sessionSummary({
        stepCount: 3,
        imageCount: 1,
        lastRun: { status: 'failed', finishedAt: 2 },
      }),
    ];
    renderAt('/tests');
    expect(await screen.findByText('Cadastro de contribuinte')).toBeTruthy();
    expect(screen.getByText('3 passos')).toBeTruthy();
    expect(screen.getByText('1 print')).toBeTruthy();
    expect(screen.getByText('Falhou')).toBeTruthy();
    expect(await screen.findByText('Gravação indisponível neste servidor')).toBeTruthy();
  });
});
