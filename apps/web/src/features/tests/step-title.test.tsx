import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TestSessionDto, TestStep } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { json, sessionDetail } from './fixtures';
import { TestSessionPage } from './session-page';

const click = (title?: string): TestStep => ({
  id: 'a',
  at: 1,
  kind: 'click',
  target: {
    locators: [{ kind: 'role', role: 'button', name: 'Entrar' }],
    description: 'botão "Entrar"',
    bbox: null,
    frameUrl: null,
  },
  page: null,
  comment: null,
  ...(title ? { title } : {}),
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

describe('inline step title editor', () => {
  let session: TestSessionDto;
  let calls: { method: string; url: string; body: unknown }[];

  const setup = (step: TestStep, state: TestSessionDto['state'] = 'idle') => {
    session = sessionDetail({
      stepCount: 1,
      mode: 'record',
      state,
      definition: { ...sessionDetail().definition, mode: 'record', steps: [step] },
    });
  };

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method !== 'GET') {
          const body = init?.body ? JSON.parse(String(init.body)) : undefined;
          calls.push({ method, url, body });
          if (body && 'title' in body) {
            const step = { ...session.definition.steps[0]!, title: body.title };
            session = {
              ...session,
              definition: { ...session.definition, steps: [step] },
            };
          }
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

  const patches = () => calls.filter((c) => c.method === 'PATCH');

  it('click to edit, then Enter saves the new title', async () => {
    setup(click());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Editar título do passo 1' }));
    const box = screen.getByLabelText('Título do passo 1');
    await userEvent.clear(box);
    await userEvent.type(box, 'Entrar no portal{Enter}');
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.body).toEqual({ title: 'Entrar no portal' });
    expect(await screen.findByRole('button', { name: 'Editar título do passo 1' })).toHaveProperty(
      'textContent',
      'Entrar no portal',
    );
  });

  it('auto-saves once after the user stops typing', async () => {
    setup(click());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Editar título do passo 1' }));
    const box = screen.getByLabelText('Título do passo 1');
    await userEvent.clear(box);
    await userEvent.type(box, 'Meu passo');
    expect(patches()).toHaveLength(0);
    await waitFor(() => expect(patches()).toHaveLength(1), { timeout: 3000 });
    expect(patches()[0]!.body).toEqual({ title: 'Meu passo' });
    // blur right after: nothing new to send
    await userEvent.tab();
    await new Promise((r) => setTimeout(r, 50));
    expect(patches()).toHaveLength(1);
  });

  it('Esc cancels without saving', async () => {
    setup(click());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Editar título do passo 1' }));
    await userEvent.type(screen.getByLabelText('Título do passo 1'), ' extra{Escape}');
    expect(screen.getByRole('button', { name: 'Editar título do passo 1' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1000));
    expect(patches()).toHaveLength(0);
  });

  it('restores the automatic title', async () => {
    setup(click('Título próprio'));
    renderPage();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Restaurar título automático do passo 1' }),
    );
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.body).toEqual({ title: null });
  });

  it('is read-only while recording', async () => {
    setup(click('Título próprio'), 'recording');
    renderPage();
    expect(await screen.findByText('Título próprio')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Editar título do passo 1' })).toBeNull();
    expect(screen.queryByText('Restaurar título automático')).toBeNull();
  });
});
