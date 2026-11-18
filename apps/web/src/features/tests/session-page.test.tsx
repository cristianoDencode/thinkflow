import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TestSessionDto, TestStep, TestStepImageDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { json, sessionDetail } from './fixtures';
import { TestSessionPage } from './session-page';

function renderPage(initial = '/tests/s1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/tests/:id', element: <TestSessionPage /> }], {
    initialEntries: [initial],
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

const base = { page: null, comment: null, target: null } as const;

const image = (over: Partial<TestStepImageDto> = {}): TestStepImageDto => ({
  id: 'i-b',
  sessionId: 's1',
  stepId: 'b',
  seq: 1,
  at: 2,
  width: 1366,
  height: 768,
  annotations: [],
  crop: null,
  annotated: false,
  comment: '',
  include: true,
  updatedAt: 1,
  originalUrl: '/api/tests/sessions/s1/images/evidences/i-b/original.png',
  imageUrl: '/api/tests/sessions/s1/images/evidences/i-b/original.png',
  ...over,
});

function steps(): TestStep[] {
  return [
    { ...base, id: 'a', at: 1, kind: 'goto', url: 'https://a.b/login' },
    {
      ...base,
      id: 'b',
      at: 2,
      kind: 'click',
      target: {
        locators: [{ kind: 'role', role: 'button', name: 'Entrar' }],
        description: 'botão "Entrar"',
        bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
        frameUrl: null,
      },
    },
  ];
}

describe('TestSessionPage', () => {
  let session: TestSessionDto;
  let calls: { method: string; url: string; body: unknown }[];

  beforeEach(() => {
    session = sessionDetail({
      stepCount: 2,
      imageCount: 1,
      mode: 'record',
      definition: { ...sessionDetail().definition, mode: 'record', steps: steps() },
      images: { b: image() },
    });
    calls = [];
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (method !== 'GET') calls.push({ method, url, body });
        if (url === '/api/tests/support')
          return json({ recording: { supported: true, message: '' } });
        if (url.endsWith('/record/start')) {
          session = {
            ...session,
            state: 'recording',
            recordingMode: (body?.mode ?? session.mode) === 'capture' ? 'capture' : 'record',
          };
          return json(session);
        }
        if (url.endsWith('/record/stop')) {
          session = { ...session, state: 'idle' };
          return json(session);
        }
        if (url.endsWith('/steps/b') && method === 'DELETE') {
          session = {
            ...session,
            stepCount: 1,
            definition: { ...session.definition, steps: session.definition.steps.slice(0, 1) },
          };
          return json(session);
        }
        if (url.endsWith('/steps/b') && method === 'PATCH') {
          session = {
            ...session,
            definition: {
              ...session.definition,
              steps: session.definition.steps.map((s) => (s.id === 'b' ? { ...s, ...body } : s)),
            },
          };
          return json(session);
        }
        if (url.endsWith('/evidences/i-b') && method === 'PATCH') {
          session = { ...session, images: { b: image(body) } };
          return json(session.images.b);
        }
        if (url.endsWith('/evidences/i-b') && method === 'DELETE') {
          session = { ...session, imageCount: 0, images: {} };
          return json({ ok: true });
        }
        if (url.endsWith('/steps/reorder') || url.endsWith('/steps/notes')) return json(session);
        if (url.endsWith('/record/checkpoint') && method === 'POST') {
          session = {
            ...session,
            stepCount: session.stepCount + 1,
            definition: {
              ...session.definition,
              steps: [
                ...session.definition.steps,
                { ...base, id: 'k', at: 9, kind: 'checkpoint' as const },
              ],
            },
          };
          return json(session);
        }
        if (url.endsWith('/steps/c') && method === 'PATCH') return json(session);
        if (url === '/api/tests/sessions/s1') return json(session);
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts and stops the recording, and locks editing while it runs', async () => {
    renderPage();
    expect(await screen.findByText('Clicar botão "Entrar"')).toBeTruthy();
    expect(screen.getByAltText('Print do passo 2')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Continuar gravação/ }));
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/tests/sessions/s1/record/start',
    });
    expect(await screen.findByText('Gravando')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Excluir passo 2' })).toBeNull();
    expect(screen.getByText(/Pare a gravação para editá-los/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Parar/ }));
    expect(calls.at(-1)!.url).toBe('/api/tests/sessions/s1/record/stop');
    expect(await screen.findByRole('button', { name: 'Excluir passo 2' })).toBeTruthy();
  });

  it('continues in the session mode: no choice and no mode switch once there are steps', async () => {
    renderPage();
    await screen.findByText('Clicar botão "Entrar"');
    expect(screen.queryByRole('button', { name: /Só prints/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Gravar passos/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Continuar gravação/ }));
    expect(calls.at(-1)).toMatchObject({ url: '/api/tests/sessions/s1/record/start' });
    expect(calls.at(-1)!.body).not.toHaveProperty('mode');
    // recording steps: checks and pause, no manual capture, no mode toggle
    expect(await screen.findByRole('button', { name: /^Verificar$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pausar/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Parar/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Capturar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Só prints/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Gravar passos/ })).toBeNull();
  });

  it('lets an empty session choose its mode: record steps', async () => {
    session = sessionDetail();
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Gravar passos/ }));
    expect(calls.at(-1)).toMatchObject({
      url: '/api/tests/sessions/s1/record/start',
      body: { mode: 'record' },
    });
    expect(await screen.findByText('Gravando')).toBeTruthy();
  });

  it('opens the browser in "Só prints": only Capturar and Parar, nothing becomes a step', async () => {
    session = sessionDetail();
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Só prints/ }));
    expect(calls.at(-1)).toMatchObject({
      url: '/api/tests/sessions/s1/record/start',
      body: { mode: 'capture' },
    });
    expect(await screen.findByText(/nada que você fizer vira passo/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Capturar/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Parar/ })).toBeTruthy();
    // no checks, pause or mode switching
    expect(screen.queryByRole('button', { name: /Verificar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pausar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Gravar passos/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Só prints/ })).toBeNull();
  });

  it('a session of prints continues as prints and has no replay', async () => {
    session = sessionDetail({
      stepCount: 1,
      mode: 'capture',
      definition: {
        ...sessionDetail().definition,
        mode: 'capture',
        steps: [{ ...base, id: 'c1', at: 1, kind: 'capture' }],
      },
    });
    renderPage();
    expect((await screen.findAllByText('Print da tela')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('tab', { name: /Dados e replay/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /Documento/ })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /Evidências/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Continuar gravação/ }));
    expect(await screen.findByText(/nada que você fizer vira passo/)).toBeTruthy();
  });

  it('comments, reorders, adds notes and deletes steps', async () => {
    renderPage();
    await screen.findByText('Clicar botão "Entrar"');

    await userEvent.click(screen.getByRole('button', { name: 'Comentar passo 2' }));
    await userEvent.type(screen.getByLabelText('Comentário do passo 2'), 'Botão principal');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      url: '/api/tests/sessions/s1/steps/b',
      body: { comment: 'Botão principal' },
    });
    expect(await screen.findByText('Botão principal')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Subir passo 2' }));
    expect(calls.at(-1)).toMatchObject({
      url: '/api/tests/sessions/s1/steps/reorder',
      body: { ids: ['b', 'a'] },
    });

    await userEvent.type(screen.getByLabelText('Nova anotação'), 'Usuário já cadastrado');
    await userEvent.click(screen.getByRole('button', { name: /Anotar/ }));
    expect(calls.at(-1)).toMatchObject({
      url: '/api/tests/sessions/s1/steps/notes',
      body: { comment: 'Usuário já cadastrado' },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Excluir passo 2' }));
    await waitFor(() => expect(screen.queryByText('Clicar botão "Entrar"')).toBeNull());
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/tests/sessions/s1/steps/b' });
  });

  it('"Verificar" adds a full-screen checkpoint at once, with no element-pick mode', async () => {
    session = { ...session, state: 'recording', recordingMode: 'record' };
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /^Verificar$/ }));
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/tests/sessions/s1/record/checkpoint',
    });
    // recording goes on: no pick instructions, no "cancel", the button is a plain action
    expect(await screen.findByText('Verificação', { selector: 'span' })).toBeTruthy();
    expect(screen.queryByText(/no elemento que deve ser verificado/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancelar verificação/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Verificar$/ }).getAttribute('aria-pressed')).toBe(
      null,
    );
    // the URL check stays
    expect(screen.getByRole('button', { name: /Verificar URL/ })).toBeTruthy();
  });

  it('still edits an old element check', async () => {
    session = {
      ...session,
      definition: {
        ...session.definition,
        steps: [
          ...session.definition.steps,
          {
            ...base,
            id: 'c',
            at: 3,
            kind: 'assert',
            assertion: { type: 'textVisible', text: 'Bem-vinda' },
          },
        ],
      },
    };
    renderPage();
    expect(await screen.findByText('Verificar: texto visível "Bem-vinda"')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Editar passo 3' }));
    // a check without an element offers only page-level types
    const type = screen.getByLabelText('Tipo de verificação');
    expect([...(type as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      'textVisible',
      'urlContains',
      'title',
    ]);
    await userEvent.selectOptions(type, 'title');
    const text = screen.getByLabelText('Texto esperado');
    await userEvent.clear(text);
    await userEvent.type(text, 'Painel');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      url: '/api/tests/sessions/s1/steps/c',
      body: { assertion: { type: 'title', text: 'Painel' } },
    });
  });
});
