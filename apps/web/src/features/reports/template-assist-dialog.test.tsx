import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { templateInputSchema, type TemplateAssistResultDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notify } from '../../lib/notify';
import { ThemeProvider } from '../../lib/theme';
import { json } from './fixtures';
import { ReportsPage } from './reports-page';
import type { TemplateDraft } from './template-draft';

function Editor() {
  const loc = useLocation();
  const draft = (loc.state as { draft?: TemplateDraft } | null)?.draft;
  return <p data-testid="draft">{draft ? draft.name : 'sem rascunho'}</p>;
}

const draft = templateInputSchema.parse({
  name: 'Guia importado',
  kind: 'report',
  spec: { sections: [{ id: 'resumo', title: 'Resumo' }] },
});

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/reports', element: <ReportsPage /> },
      { path: '/reports/templates/new', element: <Editor /> },
    ],
    { initialEntries: ['/reports?tab=modelos'] },
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

describe('template assistant dialogs', () => {
  let results: TemplateAssistResultDto[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    results = [];
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/models')
        return json([{ id: 'groq/llama', label: 'groq/llama', kind: 'model' }]);
      if (url === '/api/report-templates/assist' && init?.method === 'POST')
        return json(results.shift());
      if (url.startsWith('/api/report-templates')) return json([]);
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const lastBody = () => {
    const calls = fetchMock.mock.calls.filter(([u]) => u === '/api/report-templates/assist');
    return JSON.parse((calls.at(-1)![1] as RequestInit).body as string) as Record<string, unknown>;
  };

  it('imports a pasted prompt and opens the editor with the draft and warnings', async () => {
    const warn = vi.spyOn(notify, 'warning');
    results = [{ kind: 'draft', draft, warnings: ['Revise as variáveis'] }];
    const user = userEvent.setup();
    const router = renderTab();
    await user.click(await screen.findByRole('button', { name: /Importar de prompt/ }));
    const importButton = screen.getByRole('button', { name: 'Importar' });
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByLabelText('Prompt'));
    await user.paste('Você é um arquiteto.\n\n1. Resumo\n2. Fluxo');
    await waitFor(() => expect((importButton as HTMLButtonElement).disabled).toBe(false));
    await user.click(importButton);

    expect(await screen.findByTestId('draft')).toHaveProperty('textContent', 'Guia importado');
    expect(router.state.location.pathname).toBe('/reports/templates/new');
    expect(warn).toHaveBeenCalledWith('Revise as variáveis');
    expect(lastBody()).toMatchObject({
      mode: 'import',
      model: 'groq/llama',
      kind: 'report',
      text: expect.stringContaining('1. Resumo'),
    });
  });

  it('interviews: asks the goal, shows the questions, sends the answers and opens the editor', async () => {
    results = [
      { kind: 'questions', questions: ['Quem lê?', 'Quais seções?'] },
      { kind: 'draft', draft, warnings: [] },
    ];
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: /Criar com IA/ }));
    await user.type(screen.getByLabelText('Objetivo do modelo'), 'Guia de débitos');
    await user.click(screen.getByRole('button', { name: 'Começar' }));

    await user.type(await screen.findByLabelText('Quem lê?'), 'Analistas');
    await user.click(screen.getByRole('button', { name: 'Continuar' }));

    expect(await screen.findByTestId('draft')).toHaveProperty('textContent', 'Guia importado');
    expect(lastBody()).toMatchObject({
      mode: 'interview',
      goal: 'Guia de débitos',
      round: 1,
      answers: [
        { question: 'Quem lê?', answer: 'Analistas' },
        { question: 'Quais seções?', answer: '' },
      ],
    });
  });

  it('shows the error and keeps the dialog open when the request fails', async () => {
    const error = vi.spyOn(notify, 'error');
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/report-templates/assist' && init?.method === 'POST'
        ? json({ error: { message: 'Falhou' } }, 500)
        : url === '/api/models'
          ? json([{ id: 'groq/llama', label: 'groq/llama', kind: 'model' }])
          : json([]),
    );
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: /Criar com IA/ }));
    await user.type(screen.getByLabelText('Objetivo do modelo'), 'Guia de débitos');
    await user.click(screen.getByRole('button', { name: 'Começar' }));
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
