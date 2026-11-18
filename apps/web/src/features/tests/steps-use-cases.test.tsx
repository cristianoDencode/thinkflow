import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TestLocator, TestSessionDto, TestStep } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { json, sessionDetail } from './fixtures';
import { TestSessionPage } from './session-page';

const click = (
  id: string,
  locators: TestLocator[],
  description: string,
  comment: string | null = null,
): TestStep => ({
  id,
  at: 1,
  kind: 'click',
  target: { locators, description, bbox: null, frameUrl: null },
  page: null,
  comment,
});
const divider = (id: string, title: string, status: string): TestStep => ({
  id,
  at: 1,
  kind: 'usecase',
  target: null,
  page: null,
  comment: null,
  useCase: { title, status },
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/tests/:id', element: <TestSessionPage /> }], {
    initialEntries: ['/tests/s1'],
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('use cases, code comments and menu paths in the steps tab', () => {
  let session: TestSessionDto;
  let calls: { method: string; url: string; body: unknown }[];

  const setSteps = (steps: TestStep[]) => {
    session = sessionDetail({
      stepCount: steps.length,
      mode: 'record',
      definition: { ...sessionDetail().definition, mode: 'record', steps },
    });
  };

  beforeEach(() => {
    calls = [];
    setSteps([
      click(
        'a',
        [{ kind: 'role', role: 'button', name: 'Entrar' }],
        'botão "Entrar"',
        'Abre a tela',
      ),
      divider('d1', 'Cálculo', 'Reprovado'),
      click('b', [{ kind: 'role', role: 'button', name: 'Salvar' }], 'botão "Salvar"'),
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method !== 'GET') {
          calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
          return json(session);
        }
        if (url === '/api/tests/support')
          return json({ recording: { supported: true, message: '' } });
        if (url === '/api/tests/sessions/s1') return json(session);
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('numbers the use cases: the implicit first one, then each divider', async () => {
    renderPage();
    expect(await screen.findByLabelText('Título do caso de uso 2')).toHaveProperty(
      'value',
      'Cálculo',
    );
    expect(screen.getByLabelText('Status do caso de uso 2')).toHaveProperty('value', 'Reprovado');
    expect(screen.getByText(/Caso de Uso 1: os passos abaixo/)).toBeTruthy();
  });

  it('saves the title and status of a divider', async () => {
    renderPage();
    const status = await screen.findByLabelText('Status do caso de uso 2');
    const save = screen.getAllByRole('button', { name: 'Salvar' })[0]!;
    expect(save).toHaveProperty('disabled', true);
    await userEvent.clear(status);
    await userEvent.type(status, 'Finalizado');
    await userEvent.click(save);
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        method: 'PATCH',
        url: '/api/tests/sessions/s1/steps/d1',
        body: { useCase: { title: 'Cálculo', status: 'Finalizado' } },
      }),
    );
  });

  it('starts a use case before a step, or at the end of the list', async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Iniciar caso de uso no passo 3' }),
    );
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        method: 'POST',
        url: '/api/tests/sessions/s1/steps/use-cases',
        body: { beforeStepId: 'b' },
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Adicionar caso de uso/ }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ body: {} }));
    expect(calls.at(-1)!.url).toBe('/api/tests/sessions/s1/steps/use-cases');
  });

  it('moves and deletes a divider like any other step', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Subir caso de uso 2' }));
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        url: '/api/tests/sessions/s1/steps/reorder',
        body: { ids: ['d1', 'a', 'b'] },
      }),
    );
  });

  it('marks a comment as code/SQL', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Comentar passo 1' }));
    await userEvent.clear(screen.getByLabelText('Comentário do passo 1'));
    await userEvent.type(screen.getByLabelText('Comentário do passo 1'), 'SELECT 1');
    await userEvent.click(
      screen.getByRole('switch', { name: /Comentário do passo 1 é código ou SQL/ }),
    );
    await userEvent.click(screen.getAllByRole('button', { name: 'Salvar' })[0]!);
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        method: 'PATCH',
        url: '/api/tests/sessions/s1/steps/a',
        body: { comment: 'SELECT 1', commentIsCode: true },
      }),
    );
  });

  it('shows code comments in a code block', async () => {
    const steps = session.definition.steps.map((s) =>
      s.id === 'a' ? { ...s, comment: 'SELECT *', commentIsCode: true } : s,
    );
    setSteps(steps);
    renderPage();
    const block = await screen.findByText('SELECT *');
    expect(block.tagName).toBe('PRE');
  });

  it('offers the detected menu path as a one-click comment', async () => {
    const text = (value: string): TestLocator => ({ kind: 'text', text: value });
    setSteps([
      click(
        'm1',
        [
          { kind: 'title', text: 'Menu Principal' },
          { kind: 'css', selector: '#menu' },
        ],
        'botão "Menu Principal"',
      ),
      click(
        'm2',
        [text('DB:FINANCEIRO'), { kind: 'css', selector: '#areas > span:nth-of-type(2)' }],
        'texto "DB:FINANCEIRO"',
      ),
      click(
        'm3',
        [text('Empenho'), { kind: 'css', selector: '#modulos > span:nth-of-type(1)' }],
        'texto "Empenho"',
      ),
      click(
        'm4',
        [text('Consultas'), { kind: 'css', selector: '#menu_id_12' }],
        'texto "Consultas"',
      ),
    ]);
    renderPage();
    expect(
      await screen.findByText(/Caminho de menu detectado: DB:FINANCEIRO > Empenho > Consultas/),
    ).toBeTruthy();
    // offered once, on the first step of the run
    expect(screen.getAllByRole('button', { name: 'Usar como comentário' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Usar como comentário' }));
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        url: '/api/tests/sessions/s1/steps/m1',
        body: {
          comment: 'Após a correção, acessa o menu: DB:FINANCEIRO > Empenho > Consultas',
        },
      }),
    );
  });
});
