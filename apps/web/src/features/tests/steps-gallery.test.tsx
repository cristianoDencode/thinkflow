import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TestSessionDto, TestStep, TestStepImageDto } from '@thinkflow/shared';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
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

const base = { at: 1, page: null, comment: null, target: null } as const;

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

const KEY = 'thinkflow-steps-view';

describe('steps tab: images gallery and verification filter', () => {
  let session: TestSessionDto;
  let calls: { method: string; url: string; body: unknown }[];

  beforeEach(() => {
    localStorage.clear();
    const steps: TestStep[] = [
      { ...base, id: 'a', kind: 'goto', url: 'https://a.b/login' },
      { ...base, id: 'b', at: 2, kind: 'note', comment: 'Somente texto' },
      { ...base, id: 'k', at: 3, kind: 'checkpoint', comment: 'Saldo atualizado' },
      { ...base, id: 'z', at: 4, kind: 'capture' },
    ];
    session = sessionDetail({
      stepCount: 4,
      imageCount: 3,
      mode: 'record',
      definition: { ...sessionDetail().definition, mode: 'record', steps },
      images: {
        a: image('a', { include: false }),
        k: image('k', { include: true, comment: 'legenda' }),
        z: image('z', { include: false }),
      },
    });
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (method !== 'GET') calls.push({ method, url, body });
        if (url === '/api/tests/support')
          return json({ recording: { supported: true, message: '' } });
        if (url.endsWith('/evidences/i-k') && method === 'PATCH') {
          session = { ...session, images: { ...session.images, k: image('k', body) } };
          return json(session.images.k);
        }
        if (url === '/api/tests/sessions/s1') return json(session);
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  const gallery = () => screen.findByRole('list', { name: 'Prints dos passos' });

  it('lists the steps by default and switches to the gallery of prints, in order', async () => {
    renderPage();
    expect(await screen.findByText('Abrir https://a.b/login')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Prints dos passos' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Imagens' }));
    const cards = within(await gallery()).getAllByRole('listitem');
    // only the steps with a print (the note has none), in the order of the steps
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByAltText('Print do passo 1')).toBeTruthy();
    expect(within(cards[1]!).getByAltText('Print do passo 3')).toBeTruthy();
    expect(within(cards[2]!).getByAltText('Print do passo 4')).toBeTruthy();
    // checkpoint: badge, comment and "in the document"; the others have no badge
    expect(within(cards[1]!).getByText('Verificação')).toBeTruthy();
    expect(within(cards[1]!).getByText('Saldo atualizado')).toBeTruthy();
    expect(within(cards[1]!).getByText('No documento')).toBeTruthy();
    expect(within(cards[0]!).queryByText('Verificação')).toBeNull();
    expect(within(cards[0]!).getByText('Fora do documento')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Imagens' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('opens the annotation editor of the clicked print', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Imagens' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir print do passo 3' }));
    expect(await screen.findByRole('toolbar', { name: 'Ferramentas de anotação' })).toBeTruthy();
    expect(screen.getByText('Print do passo 3', { selector: 'h2' })).toBeTruthy();
  });

  it('turns the print on/off for the document right on its card', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Imagens' }));
    const off = await screen.findByRole('switch', {
      name: 'Incluir print do passo 1 no documento',
    });
    expect(off.getAttribute('aria-checked')).toBe('false');
    const on = screen.getByRole('switch', { name: 'Incluir print do passo 3 no documento' });
    expect(on.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(on);
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      url: '/api/tests/sessions/s1/evidences/i-k',
      body: { include: false },
    });
    // the click did not open the editor
    expect(screen.queryByRole('toolbar', { name: 'Ferramentas de anotação' })).toBeNull();
    await waitFor(() =>
      expect(
        screen
          .getByRole('switch', { name: 'Incluir print do passo 3 no documento' })
          .getAttribute('aria-checked'),
      ).toBe('false'),
    );
  });

  it('filters only the verifications, in the gallery and in the list', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Imagens' }));
    await userEvent.click(screen.getByRole('button', { name: 'Só verificações' }));
    expect(within(await gallery()).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByAltText('Print do passo 3')).toBeTruthy();
    expect(screen.queryByAltText('Print do passo 1')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Lista' }));
    expect(screen.getByText('Saldo atualizado')).toBeTruthy();
    expect(screen.queryByText('Abrir https://a.b/login')).toBeNull();
    expect(screen.queryByText('Somente texto')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Todas' }));
    expect(await screen.findByText('Abrir https://a.b/login')).toBeTruthy();
  });

  it('says so when there is no verification yet', async () => {
    session = {
      ...session,
      definition: {
        ...session.definition,
        steps: session.definition.steps.filter((s) => s.kind !== 'checkpoint'),
      },
      images: { a: session.images.a! },
    };
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Só verificações' }));
    expect(await screen.findByText('Nenhuma verificação ainda')).toBeTruthy();
  });

  it('remembers the choice in localStorage and restores it', async () => {
    const first = renderPage();
    void first;
    await userEvent.click(await screen.findByRole('button', { name: 'Imagens' }));
    await userEvent.click(screen.getByRole('button', { name: 'Só verificações' }));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ view: 'images', filter: 'checks' });
    cleanup();
    renderPage();
    expect(await gallery()).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Só verificações' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('works when localStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderPage();
    expect(await screen.findByText('Abrir https://a.b/login')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Imagens' }));
    expect(within(await gallery()).getAllByRole('listitem')).toHaveLength(3);
  });

  it('asks what was verified when commenting a checkpoint', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Comentar passo 3' }));
    expect(screen.getByPlaceholderText('O que foi verificado?')).toBeTruthy();
  });

  it('shows prints but does not open the editor while recording', async () => {
    session = { ...session, state: 'recording', recordingMode: 'record' };
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Imagens' }));
    expect((await gallery()).querySelectorAll('img')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Abrir print do passo 3' })).toBeNull();
    expect(
      screen
        .getByRole('switch', { name: 'Incluir print do passo 3 no documento' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });
});
