import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TestSessionDto, TestStep, TestStepImageDto } from '@thinkflow/shared';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { nextBadge, useHistory } from './annotation-editor';
import { json, sessionDetail } from './fixtures';
import { TestSessionPage } from './session-page';

// Konva needs a real canvas: in jsdom the stage is a plain element with the same handlers
vi.mock('react-konva', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Stage: ({ children, onMouseDown }: { children?: ReactNode; onMouseDown?: () => void }) => (
      <div data-testid="stage" onMouseDown={onMouseDown}>
        {children}
      </div>
    ),
    Layer: passthrough,
    Group: passthrough,
    Rect: () => <span data-testid="shape-rect" />,
    Ellipse: () => <span data-testid="shape-ellipse" />,
    Line: () => <span data-testid="shape-line" />,
    Transformer: () => null,
    Arrow: () => <span data-testid="shape-arrow" />,
    Circle: () => <span data-testid="shape-badge" />,
    Text: ({ text }: { text: string }) => <span data-testid="shape-text">{text}</span>,
    Image: () => <span data-testid="shape-image" />,
  };
});
vi.mock('konva', () => ({ default: { Filters: { Pixelate: () => undefined } } }));

const target = {
  locators: [{ kind: 'role', role: 'button', name: 'Entrar' }],
  description: 'botão "Entrar"',
  bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
  frameUrl: null,
} as const;

const clickStep = (id: string, at: number): TestStep => ({
  id,
  at,
  kind: 'click',
  target: { ...target, locators: [...target.locators] },
  page: null,
  comment: null,
});

function image(stepId: string, over: Partial<TestStepImageDto> = {}): TestStepImageDto {
  const id = `i-${stepId}`;
  return {
    id,
    sessionId: 's1',
    stepId,
    seq: 1,
    at: 1,
    width: 1366,
    height: 768,
    annotations: [],
    crop: null,
    annotated: false,
    comment: '',
    include: true,
    updatedAt: 1,
    originalUrl: `/api/tests/sessions/s1/images/evidences/${id}/original.png`,
    imageUrl: `/api/tests/sessions/s1/images/evidences/${id}/original.png`,
    ...over,
  };
}

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

describe('step prints in the steps tab', () => {
  let session: TestSessionDto;
  let calls: { method: string; url: string; body: unknown }[];

  beforeEach(() => {
    session = sessionDetail({
      stepCount: 2,
      imageCount: 1,
      mode: 'record',
      definition: {
        ...sessionDetail().definition,
        mode: 'record',
        steps: [clickStep('a', 1), clickStep('b', 2)],
      },
      images: { b: image('b', { comment: 'Tela inicial' }) },
    });
    calls = [];
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body =
          init?.body instanceof FormData
            ? Object.fromEntries(init.body.entries())
            : init?.body
              ? JSON.parse(String(init.body))
              : undefined;
        if (method !== 'GET') calls.push({ method, url, body });
        if (url === '/api/tests/support')
          return json({ recording: { supported: true, message: '' } });
        if (url.endsWith('/evidences/i-b') && method === 'PATCH') {
          session = { ...session, images: { b: image('b', body) } };
          return json(session.images.b);
        }
        if (url.endsWith('/evidences/i-b/annotated') && method === 'PUT') return json(image('b'));
        if (url.endsWith('/evidences/i-b') && method === 'DELETE') {
          session = { ...session, imageCount: 0, images: {} };
          return json({ ok: true });
        }
        if (url.endsWith('/steps/captures') && method === 'POST') {
          const added: TestStep = {
            id: 'c',
            at: 3,
            kind: 'capture',
            target: null,
            page: null,
            comment: null,
          };
          session = {
            ...session,
            stepCount: 3,
            imageCount: 2,
            definition: { ...session.definition, steps: [...session.definition.steps, added] },
            images: { ...session.images, c: image('c', { seq: 2 }) },
          };
          return json(image('c', { seq: 2 }), 201);
        }
        if (url === '/api/tests/sessions/s1') return json(session);
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the print of each step and leaves the steps without one alone', async () => {
    renderPage();
    const thumb = await screen.findByAltText('Print do passo 2');
    expect(thumb.getAttribute('src')).toContain('/evidences/i-b/original.png?v=1');
    expect(screen.queryByAltText('Print do passo 1')).toBeNull();
    expect(screen.queryByRole('switch', { name: /passo 1 no documento/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Evidências/ })).toBeNull();
  });

  it('includes/excludes the print in the document', async () => {
    renderPage();
    const toggle = await screen.findByRole('switch', {
      name: 'Incluir print do passo 2 no documento',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(toggle);
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      url: '/api/tests/sessions/s1/evidences/i-b',
      body: { include: false },
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole('switch', { name: 'Incluir print do passo 2 no documento' })
          .getAttribute('aria-checked'),
      ).toBe('false'),
    );
  });

  it('removes only the print: the step stays', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Remover print do passo 2' }));
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: '/api/tests/sessions/s1/evidences/i-b',
    });
    await waitFor(() => expect(screen.queryByAltText('Print do passo 2')).toBeNull());
    expect(screen.getAllByText('Clicar botão "Entrar"')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Editar print do passo 2' })).toBeNull();
  });

  it('edits the print in the editor and saves the annotated version', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Editar print do passo 2' }));
    expect(await screen.findByRole('toolbar', { name: 'Ferramentas de anotação' })).toBeTruthy();
    // the print belongs to the step: there is no step to pick anymore
    expect(screen.getByText('Print do passo 2', { selector: 'h2' })).toBeTruthy();
    expect(screen.queryByLabelText('Passo documentado')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Número de passo' }));
    // the mocked stage has no pointer position: the badge is not placed, the comment still saves
    await userEvent.clear(screen.getByLabelText('Comentário'));
    await userEvent.type(screen.getByLabelText('Comentário'), 'Login aceito');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar print' }));
    await waitFor(() => expect(calls.at(-1)?.method).toBe('PUT'));
    expect(calls.at(-1)!.url).toBe('/api/tests/sessions/s1/evidences/i-b/annotated');
    expect(JSON.parse(String((calls.at(-1)!.body as { data: string }).data))).toEqual({
      annotations: [],
      crop: null,
      comment: 'Login aceito',
      include: true,
    });
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: 'Ferramentas de anotação' })).toBeNull(),
    );
  });

  it('adds a pasted/chosen PNG as a print step and opens it in the editor', async () => {
    renderPage();
    const input = await screen.findByLabelText('Escolher imagem PNG');
    await userEvent.upload(input, new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        method: 'POST',
        url: '/api/tests/sessions/s1/steps/captures',
      }),
    );
    expect(await screen.findByRole('toolbar', { name: 'Ferramentas de anotação' })).toBeTruthy();
    expect(screen.getByText('Print do passo 3', { selector: 'h2' })).toBeTruthy();
  });
});

describe('prints taken in "Só prints"', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens the editor of a new capture step; recorded steps get their print quietly', async () => {
    let session = sessionDetail({
      state: 'recording',
      recordingMode: 'capture',
      mode: 'capture',
      definition: { ...sessionDetail().definition, mode: 'capture', steps: [] },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url === '/api/tests/support')
          return json({ recording: { supported: true, message: '' } });
        if (url.endsWith('/capture') && method === 'POST') {
          const step: TestStep = {
            id: 'c1',
            at: 1,
            kind: 'capture',
            target: null,
            page: null,
            comment: null,
          };
          session = {
            ...session,
            stepCount: 1,
            imageCount: 1,
            definition: { ...session.definition, steps: [step] },
            images: { c1: image('c1') },
          };
          return json(image('c1'), 201);
        }
        if (url === '/api/tests/sessions/s1') return json(session);
        return json({}, 404);
      }),
    );
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Capturar/ }));
    expect(await screen.findByRole('toolbar', { name: 'Ferramentas de anotação' })).toBeTruthy();
    expect(screen.getByText('Print do passo 1', { selector: 'h2' })).toBeTruthy();
  });

  it('does not interrupt while recording steps', async () => {
    let session = sessionDetail({
      state: 'recording',
      recordingMode: 'record',
      mode: 'record',
      definition: { ...sessionDetail().definition, mode: 'record', steps: [clickStep('a', 1)] },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/tests/support')
          return json({ recording: { supported: true, message: '' } });
        if (url === '/api/tests/sessions/s1') return json(session);
        return json({}, 404);
      }),
    );
    renderPage();
    await screen.findByText('Clicar botão "Entrar"');
    // the automatic print shows up in the next poll
    session = { ...session, imageCount: 1, images: { a: image('a') } };
    expect(
      await screen.findByAltText('Print do passo 1', undefined, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByRole('toolbar', { name: 'Ferramentas de anotação' })).toBeNull();
  });
});

describe('annotation history', () => {
  it('undoes and redoes, and numbers badges in sequence', () => {
    const { result } = renderHook(() => useHistory([]));
    act(() => result.current.set([{ type: 'badge', x: 0.1, y: 0.1, n: 1, color: '#f00' }]));
    act(() =>
      result.current.set([
        ...result.current.items,
        { type: 'badge', x: 0.2, y: 0.2, n: nextBadge(result.current.items), color: '#f00' },
      ]),
    );
    expect(result.current.items.map((a) => (a.type === 'badge' ? a.n : 0))).toEqual([1, 2]);
    act(() => result.current.undo());
    expect(result.current.items).toHaveLength(1);
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.items).toHaveLength(2);
    act(() => result.current.undo());
    act(() => result.current.undo());
    expect(result.current.items).toEqual([]);
    expect(result.current.canUndo).toBe(false);
  });
});
