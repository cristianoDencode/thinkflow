import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PrototypeBlockDto, PrototypeDetailDto } from '@thinkflow/shared';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { sessionSummary } from '../tests/fixtures';
import { loadEditorAdapter } from './adapter-loader';
import type { EditorAdapter, EditorMount, EditorState } from './editor-adapter';
import { block, detail, json } from './fixtures';
import { PrototypeEditorPage } from './prototype-editor-page';

vi.mock('./adapter-loader', () => ({ loadEditorAdapter: vi.fn() }));

/** A fake engine: records what the shell asks and lets the test drive its state. */
function fakeAdapter() {
  let state: EditorState = {
    dirty: false,
    canUndo: false,
    canRedo: false,
    selection: null,
    selectionKind: null,
    selectionOffset: false,
    canGroup: false,
    canUngroup: false,
    zoom: 100,
    mode: 'html',
    revision: 0,
  };
  const listeners = new Set<(s: EditorState) => void>();
  const adapter: EditorAdapter = {
    load: vi.fn(),
    getSnapshot: vi.fn(() => ({ html: '<body><p>editado</p></body>', css: 'p{color:red}' })),
    setFrameSize: vi.fn(),
    setZoom: vi.fn(),
    fitZoom: vi.fn(() => 64),
    setUserBlocks: vi.fn(),
    insertBlock: vi.fn(),
    getSelectionAsBlock: vi.fn((): { label: string; html: string; css: string } | null => ({
      label: 'Campo',
      html: '<div class="ec-field">x</div>',
      css: '.ec-field{margin:3px}',
    })),
    getSelectionPath: vi.fn(() => null),
    // called by the page from inside its own effects: notify without `act` (nested act throws)
    setMode: vi.fn((mode: 'free' | 'html') => notify({ mode })),
    isInteracting: vi.fn(() => false),
    run: vi.fn(),
    markClean: vi.fn(() => notify({ dirty: false })),
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    destroy: vi.fn(),
  };
  const notify = (patch: Partial<EditorState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state));
  };
  const emit = (patch: Partial<EditorState>) => act(() => notify(patch));
  return { adapter, emit };
}

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: '/prototypes/:id',
        element: (
          <>
            <PrototypeEditorPage />
            <Link to="/prototypes">sair-para-lista</Link>
          </>
        ),
      },
      { path: '/prototypes', element: <p>LISTA</p> },
    ],
    { initialEntries: ['/prototypes/p1'] },
  );
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { router, unmount: view.unmount };
}

/** A free layout as `POST /free-layout` delivers it (wrappers + hidden originals). */
const FREE = {
  html: '<body><p data-tf-free-src="1" style="visibility:hidden">x</p><div data-tf-free="1" style="position:absolute;left:10px;top:20px;z-index:1"><p>x</p></div></body>',
  css: 'p{margin:0}',
};

describe('PrototypeEditorPage', () => {
  let engine: ReturnType<typeof fakeAdapter>;
  let current: PrototypeDetailDto;
  let blocks: PrototypeBlockDto[];
  let calls: { method: string; url: string; body: unknown }[];
  /** What `POST /free-layout` answers; null = the server fails. */
  let freeLayout: { html: string; css: string } | null;
  /** While set, PUT /api/prototypes/p1 waits for it. */
  let putGate: Promise<void> | null;

  beforeEach(() => {
    engine = fakeAdapter();
    vi.mocked(loadEditorAdapter).mockResolvedValue(() => engine.adapter);
    current = detail();
    blocks = [block()];
    calls = [];
    freeLayout = null; // by default the conversion fails: the page falls back to HTML mode
    putGate = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url, body });
        if (url === '/api/tests/sessions')
          return json([
            sessionSummary({ id: 's1', name: 'Fluxo de empenho' }),
            sessionSummary({ id: 's2', name: 'Outro fluxo' }),
          ]);
        if (url === '/api/prototypes/blocks' && method === 'POST')
          return json(block({ id: 'b2', name: body.name }), 201);
        if (url === '/api/prototypes/blocks') return json(blocks);
        if (url === '/api/prototypes/blocks/b1' && method === 'DELETE') {
          blocks = [];
          return json(null, 204);
        }
        if (url.startsWith('/api/prototypes/blocks/') && method === 'DELETE') {
          blocks = blocks.filter((b) => url !== `/api/prototypes/blocks/${b.id}`);
          return json(null, 204);
        }
        if (url.startsWith('/api/prototypes/blocks/') && method === 'PUT') {
          const found = blocks.find((b) => url === `/api/prototypes/blocks/${b.id}`);
          return found ? json({ ...found, ...body }) : json({}, 404);
        }
        if (url === '/api/prototypes/p1/save-as-template' && method === 'POST')
          return json(detail({ id: 't1', kind: 'template', name: body.name }), 201);
        if (url.startsWith('/api/prototypes/p1/render')) {
          return json({
            thumbnailUrl: '/api/prototypes/p1/thumbnail',
            width: 1280,
            height: 720,
            scale: 1,
            renderedVersionId: current.versionId,
            cached: false,
            blockedRequests: 0,
          });
        }
        if (url === '/api/prototypes/p1/assistant')
          return json({
            html: '<body><p>da IA</p></body>',
            css: 'p{color:blue}',
            explanation: 'Troquei o texto.',
            model: 'auto',
            usage: { inputTokens: 1, outputTokens: 1 },
            warnings: [],
          });
        if (url === '/api/models') return json([{ id: 'auto', label: 'Auto', kind: 'combo' }]);
        if (url === '/api/libraries' || url === '/api/mcp') return json([]);
        if (url === '/api/prototypes/p1/versions/v1')
          return json({ html: '<body><b>antiga</b></body>', css: 'b{}', width: 1000, height: 600 });
        if (url === '/api/prototypes/p1/versions/v1/restore' && method === 'POST') {
          current = detail({
            versionId: 'v3',
            html: '<body><b>antiga</b></body>',
            css: 'b{}',
            versions: [
              ...current.versions,
              { id: 'v3', createdAt: 1_700_000_200_000, note: 'Restaurado' },
            ],
          });
          return json(current);
        }
        if (url === '/api/prototypes/p1/free-layout' && method === 'POST')
          return freeLayout ? json(freeLayout) : json({ message: 'sem Chromium' }, 503);
        if (url === '/api/prototypes/p1' && method === 'PUT') {
          await putGate;
          current = detail({
            ...current,
            ...(body.name ? { name: body.name } : {}),
            ...('sessionId' in body
              ? { sessionId: body.sessionId, sessionName: 'Outro fluxo' }
              : {}),
            ...(body.snapshot
              ? {
                  ...body.snapshot,
                  versionId: 'v9',
                  versions: [
                    ...current.versions,
                    { id: 'v9', createdAt: 1_700_000_300_000, note: body.note },
                  ],
                }
              : {}),
          });
          return json(current);
        }
        if (url === '/api/prototypes/p1') return json(current);
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const loaded = async () => {
    renderEditor();
    await waitFor(() => expect(engine.adapter.load).toHaveBeenCalled());
  };
  const puts = () => calls.filter((c) => c.method === 'PUT' && c.url === '/api/prototypes/p1');

  it('loads the current version into the canvas at its exact size and fits the zoom', async () => {
    await loaded();
    expect(engine.adapter.load).toHaveBeenCalledWith(
      expect.objectContaining({
        html: current.html,
        css: current.css,
        width: 1280,
        height: 720,
      }),
    );
    expect((screen.getByLabelText('Largura da tela') as HTMLInputElement).value).toBe('1280');
    expect((screen.getByLabelText('Altura da tela') as HTMLInputElement).value).toBe('720');
    expect(engine.adapter.setZoom).toHaveBeenCalledWith(64);
    expect(screen.getByLabelText('Zoom atual').textContent).toBe('64%');
    expect(screen.getByText('Salvo')).toBeTruthy();
    // the user blocks reach the palette
    await waitFor(() => expect(engine.adapter.setUserBlocks).toHaveBeenCalledWith(blocks));
  });

  it('save sends snapshot {html, css, width, height} with the note "Edição"', async () => {
    const user = userEvent.setup();
    await loaded();
    const save = screen.getByRole('button', { name: /Salvar$/ });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    engine.emit({ dirty: true });
    expect(screen.getByText('Alterações não salvas')).toBeTruthy();
    await user.click(save);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toEqual({
      snapshot: {
        html: '<body><p>editado</p></body>',
        css: 'p{color:red}',
        width: 1280,
        height: 720,
      },
      note: 'Edição',
    });
    expect(engine.adapter.markClean).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Salvo')).toBeTruthy());
    // the canvas is not reloaded after saving
    expect(engine.adapter.load).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+S saves too, and does nothing when there is nothing to save', async () => {
    const user = userEvent.setup();
    await loaded();
    await user.keyboard('{Control>}s{/Control}');
    expect(puts()).toHaveLength(0);
    engine.emit({ dirty: true });
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(puts()).toHaveLength(1));
  });

  it('a changed frame size is saved and counts as an unsaved change', async () => {
    const user = userEvent.setup();
    await loaded();
    const width = screen.getByLabelText('Largura da tela');
    await user.clear(width);
    await user.type(width, '1000');
    await user.tab();
    expect(engine.adapter.setFrameSize).toHaveBeenCalledWith(1000, 720);
    expect(screen.getByText('Alterações não salvas')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Salvar$/ }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect((puts()[0]!.body as { snapshot: { width: number } }).snapshot.width).toBe(1000);
  });

  it('guards leaving with unsaved changes: stay, leave, or save and leave', async () => {
    const user = userEvent.setup();
    engine = fakeAdapter();
    vi.mocked(loadEditorAdapter).mockResolvedValue(() => engine.adapter);
    const { router } = renderEditor();
    await waitFor(() => expect(engine.adapter.load).toHaveBeenCalled());

    engine.emit({ dirty: true });
    await user.click(screen.getByText('sair-para-lista'));
    let dialog = await screen.findByRole('dialog', { name: 'Sair sem salvar?' });
    await user.click(within(dialog).getByRole('button', { name: 'Continuar editando' }));
    expect(router.state.location.pathname).toBe('/prototypes/p1');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByText('sair-para-lista'));
    dialog = await screen.findByRole('dialog', { name: 'Sair sem salvar?' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar e sair' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/prototypes'));
    expect(puts()).toHaveLength(1);
  });

  it('"Sair sem salvar" leaves without saving', async () => {
    const user = userEvent.setup();
    const { router } = renderEditor();
    await waitFor(() => expect(engine.adapter.load).toHaveBeenCalled());
    engine.emit({ dirty: true });
    await user.click(screen.getByText('sair-para-lista'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Sair sem salvar' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/prototypes'));
    expect(puts()).toHaveLength(0);
  });

  it('does not guard when nothing changed, and warns the browser on unload when dirty', async () => {
    const user = userEvent.setup();
    const { router } = renderEditor();
    await waitFor(() => expect(engine.adapter.load).toHaveBeenCalled());
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    engine.emit({ dirty: true });
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    engine.emit({ dirty: false });
    await user.click(screen.getByText('sair-para-lista'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/prototypes'));
  });

  it('restores a version after confirmation and loads it into the canvas', async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole('button', { name: /Versões \(2\)/ }));
    const menu = screen.getByRole('menu', { name: 'Versões' });
    expect(within(menu).getByText('Atual')).toBeTruthy();
    await user.click(within(menu).getByRole('button', { name: /Restaurar versão de/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Restaurar versão?' });
    // nothing happens until confirmed
    expect(calls.some((c) => c.url.endsWith('/restore'))).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Restaurar versão' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/prototypes/p1/versions/v1/restore')).toBe(true),
    );
    await waitFor(() => expect(engine.adapter.load).toHaveBeenCalledTimes(2));
    expect(engine.adapter.load).toHaveBeenLastCalledWith(
      expect.objectContaining({ html: '<body><b>antiga</b></body>', css: 'b{}' }),
    );
    expect(screen.getByText('Salvo')).toBeTruthy();
  });

  it('opens an old version as an unsaved draft', async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole('button', { name: /Versões \(2\)/ }));
    await user.click(screen.getByRole('button', { name: /Abrir versão de/ }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Abrir versão?' })).getByRole('button', {
        name: 'Abrir versão',
      }),
    );
    await waitFor(() => expect(engine.adapter.load).toHaveBeenCalledTimes(2));
    expect(engine.adapter.load).toHaveBeenLastCalledWith({
      html: '<body><b>antiga</b></body>',
      css: 'b{}',
      width: 1000,
      height: 600,
    });
    expect(screen.getByText('Alterações não salvas')).toBeTruthy();
    expect(puts()).toHaveLength(0);
  });

  it('links the prototype to a test session (and unlinks)', async () => {
    const user = userEvent.setup();
    await loaded();
    const select = await screen.findByLabelText('Teste vinculado');
    await waitFor(() => expect(within(select).getByText('Outro fluxo')).toBeTruthy());
    await user.selectOptions(select, 's2');
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toEqual({ sessionId: 's2' });
    expect(
      (await screen.findByRole('link', { name: 'Abrir o teste vinculado' })).getAttribute('href'),
    ).toBe('/tests/s2');
    // linking never reloads the canvas (unsaved edits are safe)
    expect(engine.adapter.load).toHaveBeenCalledTimes(1);
    await user.selectOptions(screen.getByLabelText('Teste vinculado'), '');
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]!.body).toEqual({ sessionId: null });
  });

  it('renames from the title field', async () => {
    const user = userEvent.setup();
    await loaded();
    const name = await screen.findByLabelText('Nome do protótipo');
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('Consulta Empenho'));
    await user.clear(name);
    await user.type(name, 'Novo nome');
    await user.tab();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toEqual({ name: 'Novo nome' });
  });

  describe('Livre / HTML (one document, two ways to edit it)', () => {
    const livre = () => screen.getByRole('radio', { name: 'Livre' });
    const html = () => screen.getByRole('radio', { name: 'HTML' });
    const posts = () => calls.filter((c) => c.url === '/api/prototypes/p1/free-layout');
    /** The saved version is already a free layout (and an older one is plain HTML). */
    const freeCurrent = () => {
      current = detail({
        versionId: 'v2',
        html: FREE.html,
        css: FREE.css,
        versions: [
          { id: 'v1', createdAt: 1_700_000_000_000, note: 'Captura' },
          { id: 'v2', createdAt: 1_700_000_100_000, note: 'Auto-save' },
        ],
      });
    };
    /** Timers under control from now on (the page is already loaded). */
    const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    /** Exactly `ms` of clock, nothing more. */
    const tick = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    /** Advances the clock, then lets the requests and renders that follow finish. */
    const advance = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
    };
    afterEach(() => vi.useRealTimers());

    it('opens in "Livre": converts the saved version and loads it WITHOUT marking a change', async () => {
      freeLayout = FREE;
      await loaded();
      await waitFor(() => expect(engine.adapter.load).toHaveBeenCalledTimes(2));
      expect(posts()).toHaveLength(1);
      expect(engine.adapter.load).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ html: current.html }),
      );
      expect(engine.adapter.load).toHaveBeenLastCalledWith({
        html: FREE.html,
        css: FREE.css,
        width: 1280,
        height: 720,
      });
      expect(engine.adapter.setMode).toHaveBeenLastCalledWith('free');
      expect(livre().getAttribute('aria-checked')).toBe('true');
      expect(screen.getByText('Salvo')).toBeTruthy();
      expect(engine.adapter.markClean).not.toHaveBeenCalled();
    });

    it('a version that is already a free layout is not converted again', async () => {
      freeCurrent();
      await loaded();
      expect(engine.adapter.setMode).toHaveBeenLastCalledWith('free');
      expect(posts()).toHaveLength(0);
      expect(engine.adapter.load).toHaveBeenCalledTimes(1);
    });

    it('if the conversion fails the page stays in HTML mode (the document is untouched)', async () => {
      freeLayout = null;
      await loaded();
      await waitFor(() => expect(html().getAttribute('aria-checked')).toBe('true'));
      expect(posts()).toHaveLength(1);
      expect(engine.adapter.load).toHaveBeenCalledTimes(1);
      expect(engine.adapter.setMode).toHaveBeenLastCalledWith('html');
      expect(screen.getByText('Salvo')).toBeTruthy();
    });

    it('until the first edit nothing is saved: not by auto-save, not by Ctrl+S; then the converted layout is', async () => {
      freeLayout = FREE;
      await loaded();
      await waitFor(() => expect(engine.adapter.load).toHaveBeenCalledTimes(2));
      fakeTimers();
      await advance(10_000);
      expect(puts()).toHaveLength(0);
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      await advance(10);
      expect(puts()).toHaveLength(0);
      // the first edit
      engine.emit({ dirty: true, revision: 1 });
      expect(screen.getByText('Alterações não salvas')).toBeTruthy();
      await advance(2000);
      expect(puts()).toHaveLength(1);
      expect(puts()[0]!.body).toEqual({
        snapshot: {
          html: '<body><p>editado</p></body>',
          css: 'p{color:red}',
          width: 1280,
          height: 720,
        },
        note: 'Auto-save',
        autosave: true,
      });
    });

    it('auto-saves 2s after the LAST change, as "Auto-save", quietly, and says so', async () => {
      await loaded();
      fakeTimers();
      engine.emit({ dirty: true, revision: 1 });
      await tick(1500);
      engine.emit({ revision: 2 }); // another change: the countdown restarts
      await tick(1999);
      expect(puts()).toHaveLength(0);
      expect(screen.getByText('Alterações não salvas')).toBeTruthy();
      await advance(1);
      expect(puts()).toHaveLength(1);
      expect(puts()[0]!.body).toMatchObject({ note: 'Auto-save', autosave: true });
      expect(screen.getByText('Salvo automaticamente')).toBeTruthy();
      expect(engine.adapter.markClean).toHaveBeenCalled();
      // no toast for an auto-save
      expect(screen.queryByText('Protótipo salvo')).toBeNull();
      expect(screen.queryByText('Versão criada')).toBeNull();
      // nothing more to save: no second request
      await advance(10_000);
      expect(puts()).toHaveLength(1);
    });

    it('shows "Salvando…" while the auto-save is in flight', async () => {
      await loaded();
      let release!: () => void;
      putGate = new Promise<void>((resolve) => (release = resolve));
      fakeTimers();
      engine.emit({ dirty: true, revision: 1 });
      await advance(2000);
      expect(screen.getByText('Salvando…')).toBeTruthy();
      await act(async () => release());
      await advance(0);
      expect(screen.getByText('Salvo automaticamente')).toBeTruthy();
    });

    it('postpones the auto-save while a drag, a resize or a text edit is running', async () => {
      await loaded();
      fakeTimers();
      vi.mocked(engine.adapter.isInteracting!).mockReturnValue(true);
      engine.emit({ dirty: true, revision: 1 });
      await advance(2000);
      await advance(3000);
      expect(puts()).toHaveLength(0);
      vi.mocked(engine.adapter.isInteracting!).mockReturnValue(false);
      await advance(500);
      expect(puts()).toHaveLength(1);
    });

    it('Ctrl+S is a normal save ("Edição", no autosave flag)', async () => {
      await loaded();
      engine.emit({ dirty: true, revision: 1 });
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      await waitFor(() => expect(puts()).toHaveLength(1));
      expect(puts()[0]!.body).toEqual({
        snapshot: {
          html: '<body><p>editado</p></body>',
          css: 'p{color:red}',
          width: 1280,
          height: 720,
        },
        note: 'Edição',
      });
      await waitFor(() => expect(screen.getByText('Salvo')).toBeTruthy());
      expect(screen.queryByText('Salvo automaticamente')).toBeNull();
    });

    it('does not auto-save an opened old version that was not touched (it is a draft)', async () => {
      const user = userEvent.setup();
      await loaded();
      await user.click(screen.getByRole('button', { name: /Versões \(2\)/ }));
      await user.click(screen.getByRole('button', { name: /Abrir versão de/ }));
      await user.click(
        within(await screen.findByRole('dialog', { name: 'Abrir versão?' })).getByRole('button', {
          name: 'Abrir versão',
        }),
      );
      await waitFor(() => expect(engine.adapter.load).toHaveBeenCalledTimes(2));
      fakeTimers();
      await advance(10_000);
      expect(puts()).toHaveLength(0);
      expect(screen.getByText('Alterações não salvas')).toBeTruthy();
    });

    it('the HTML / Livre toggle only switches the mode of the same editor', async () => {
      const user = userEvent.setup();
      freeLayout = FREE;
      await loaded();
      await waitFor(() => expect(engine.adapter.load).toHaveBeenCalledTimes(2));
      await user.click(html());
      expect(engine.adapter.setMode).toHaveBeenLastCalledWith('html');
      expect(html().getAttribute('aria-checked')).toBe('true');
      await user.click(livre());
      expect(engine.adapter.setMode).toHaveBeenLastCalledWith('free');
      // same document: no reload, no new conversion
      expect(engine.adapter.load).toHaveBeenCalledTimes(2);
      expect(posts()).toHaveLength(1);
    });

    it('Agrupar / Desagrupar: only in Livre, enabled by the engine state, routed to the engine', async () => {
      const user = userEvent.setup();
      freeLayout = FREE;
      await loaded();
      await waitFor(() => expect(engine.adapter.load).toHaveBeenCalledTimes(2));
      const group = () => screen.getByRole('button', { name: 'Agrupar' }) as HTMLButtonElement;
      const ungroup = () => screen.getByRole('button', { name: 'Desagrupar' }) as HTMLButtonElement;
      expect(group().title).toBe('Agrupar (Ctrl+G)');
      expect(ungroup().title).toBe('Desagrupar (Ctrl+Shift+G)');
      expect([group().disabled, ungroup().disabled]).toEqual([true, true]);
      engine.emit({ selection: 'Campo', canGroup: true });
      expect([group().disabled, ungroup().disabled]).toEqual([false, true]);
      await user.click(group());
      engine.emit({ selection: 'Grupo', canGroup: false, canUngroup: true });
      expect([group().disabled, ungroup().disabled]).toEqual([true, false]);
      await user.click(ungroup());
      const runs = vi.mocked(engine.adapter.run).mock.calls.map((c) => c[0]);
      expect(runs).toEqual(['group', 'ungroup']);
      // a disabled button never calls the engine
      engine.emit({ canUngroup: false });
      await user.click(ungroup());
      expect(vi.mocked(engine.adapter.run)).toHaveBeenCalledTimes(2);
      // HTML mode: the buttons are not there at all
      await user.click(html());
      expect(screen.queryByRole('button', { name: 'Agrupar' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Desagrupar' })).toBeNull();
      await user.click(livre());
      expect(screen.getByRole('button', { name: 'Agrupar' })).toBeTruthy();
    });

    it('switching to Livre on a plain document saves pending edits, then converts', async () => {
      const user = userEvent.setup();
      await loaded(); // the first conversion failed: HTML mode
      await waitFor(() => expect(html().getAttribute('aria-checked')).toBe('true'));
      freeLayout = FREE;
      engine.emit({ dirty: true, revision: 1 });
      await user.click(livre());
      await waitFor(() => expect(puts()).toHaveLength(1));
      expect((puts()[0]!.body as { note: string }).note).toBe('Edição');
      await waitFor(() => expect(posts()).toHaveLength(2));
      await waitFor(() => expect(engine.adapter.load).toHaveBeenCalledTimes(2));
      expect(engine.adapter.load).toHaveBeenLastCalledWith(
        expect.objectContaining({ html: FREE.html }),
      );
      expect(livre().getAttribute('aria-checked')).toBe('true');
    });

    it('"Pedir à IA" is available in both modes', async () => {
      const user = userEvent.setup();
      freeCurrent();
      await loaded();
      const ask = screen.getByRole('button', { name: /Pedir à IA/ }) as HTMLButtonElement;
      expect(livre().getAttribute('aria-checked')).toBe('true');
      expect(ask.disabled).toBe(false);
      await user.click(html());
      expect(ask.disabled).toBe(false);
    });

    it('keeps Blocos, Camadas, Estilo, Propriedades and IA in the free mode', async () => {
      freeCurrent();
      await loaded();
      for (const name of ['Blocos', 'Camadas', 'Estilo', 'Propriedades', 'IA'])
        expect(screen.getByRole('tab', { name })).toBeTruthy();
    });

    it('"Recriar a partir do HTML" restores the last plain version, converts it and loads it', async () => {
      const user = userEvent.setup();
      freeCurrent();
      freeLayout = { html: FREE.html.replace('left:10px', 'left:99px'), css: FREE.css };
      await loaded();
      await user.click(screen.getByRole('button', { name: 'Recriar a partir do HTML' }));
      const dialog = await screen.findByRole('dialog', { name: 'Recriar a partir do HTML?' });
      expect(posts()).toHaveLength(0); // nothing until confirmed
      await user.click(within(dialog).getByRole('button', { name: 'Recriar layout' }));
      await waitFor(() =>
        expect(calls.some((c) => c.url === '/api/prototypes/p1/versions/v1/restore')).toBe(true),
      );
      await waitFor(() => expect(posts()).toHaveLength(1));
      await waitFor(() =>
        expect(engine.adapter.load).toHaveBeenLastCalledWith(
          expect.objectContaining({ html: expect.stringContaining('left:99px') }),
        ),
      );
      expect(screen.getByText('Salvo')).toBeTruthy();
    });

    it('"Recriar a partir do HTML" converts the current version straight away when it is plain', async () => {
      const user = userEvent.setup();
      freeLayout = null;
      await loaded(); // plain current, the first conversion failed
      await waitFor(() => expect(html().getAttribute('aria-checked')).toBe('true'));
      await user.click(livre()); // fails again: still HTML
      freeLayout = FREE;
      await user.click(livre());
      await waitFor(() => expect(livre().getAttribute('aria-checked')).toBe('true'));
      await user.click(screen.getByRole('button', { name: 'Recriar a partir do HTML' }));
      const dialog = await screen.findByRole('dialog', { name: 'Recriar a partir do HTML?' });
      await user.click(within(dialog).getByRole('button', { name: 'Recriar layout' }));
      await waitFor(() => expect(posts().length).toBeGreaterThanOrEqual(3));
      expect(calls.some((c) => c.url.endsWith('/restore'))).toBe(false);
    });

    it('"Descartar modo livre" opens the last plain version as a draft, in HTML mode', async () => {
      const user = userEvent.setup();
      freeCurrent();
      await loaded();
      await user.click(screen.getByRole('button', { name: 'Descartar modo livre' }));
      const dialog = await screen.findByRole('dialog', { name: 'Descartar o modo livre?' });
      expect(engine.adapter.load).toHaveBeenCalledTimes(1);
      await user.click(within(dialog).getByRole('button', { name: 'Descartar' }));
      await waitFor(() => expect(engine.adapter.load).toHaveBeenCalledTimes(2));
      expect(engine.adapter.load).toHaveBeenLastCalledWith({
        html: '<body><b>antiga</b></body>',
        css: 'b{}',
        width: 1000,
        height: 600,
      });
      expect(engine.adapter.setMode).toHaveBeenLastCalledWith('html');
      expect(html().getAttribute('aria-checked')).toBe('true');
      expect(screen.getByText('Alterações não salvas')).toBeTruthy();
      expect(puts()).toHaveLength(0);
    });

    it('a version made by the old image editor (with a scene) opens as plain HTML and saves without it', async () => {
      current = {
        ...detail(),
        scene: { version: 1, background: null, layers: [] },
      };
      await loaded();
      expect(engine.adapter.load).toHaveBeenCalledWith(
        expect.not.objectContaining({ scene: expect.anything() }),
      );
      engine.emit({ dirty: true, revision: 1 });
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      await waitFor(() => expect(puts()).toHaveLength(1));
      expect((puts()[0]!.body as { snapshot: object }).snapshot).not.toHaveProperty('scene');
    });

    it('lists the shortcuts of each mode', async () => {
      const user = userEvent.setup();
      freeCurrent();
      await loaded();
      await user.click(screen.getByRole('button', { name: 'Atalhos do teclado' }));
      expect(screen.getByText('Mover livremente')).toBeTruthy(); // Arrastar
      expect(screen.getByText('Mover 1px / Shift 10px')).toBeTruthy(); // Setas
      expect(screen.getByText('Trazer para frente / enviar para trás')).toBeTruthy(); // Ctrl + ↑ / ↓
      expect(screen.queryByText('Alt + arrastar')).toBeNull();
      await user.click(html());
      expect(screen.getByText('Alt + arrastar')).toBeTruthy();
      expect(screen.getByText('Reordenar elemento')).toBeTruthy();
      expect(screen.queryByText('Trazer para frente / enviar para trás')).toBeNull();
    });
  });

  it('saves the selection as a block (POST /api/prototypes/blocks)', async () => {
    const user = userEvent.setup();
    await loaded();
    const button = screen.getByRole('button', { name: 'Salvar como bloco' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    engine.emit({ selection: 'Campo' });
    expect(screen.getByText('Selecionado: Campo')).toBeTruthy();
    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Salvar seleção como bloco' });
    const input = within(dialog).getByLabelText('Nome do bloco');
    expect((input as HTMLInputElement).value).toBe('Campo');
    await user.clear(input);
    await user.type(input, 'Campo código');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar bloco' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/prototypes/blocks')).toBe(
        true,
      ),
    );
    expect(
      calls.find((c) => c.method === 'POST' && c.url === '/api/prototypes/blocks')!.body,
    ).toEqual({
      name: 'Campo código',
      category: 'Meus blocos',
      html: '<div class="ec-field">x</div>',
      css: '.ec-field{margin:3px}',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('lists my blocks: insert into the canvas and delete with confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'Inserir Cabeçalho padrão' }));
    expect(engine.adapter.insertBlock).toHaveBeenCalledWith(blocks[0]);
    await user.click(screen.getByRole('button', { name: 'Excluir bloco Cabeçalho padrão' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'DELETE' && c.url === '/api/prototypes/blocks/b1'),
      ).toBe(true),
    );
  });

  it('routes the selection actions to the engine', async () => {
    const user = userEvent.setup();
    await loaded();
    engine.emit({ selection: 'Campo', canUndo: true, canRedo: true });
    await user.click(screen.getByRole('button', { name: 'Duplicar elemento' }));
    await user.click(screen.getByRole('button', { name: 'Excluir elemento' }));
    await user.click(screen.getByRole('button', { name: 'Selecionar elemento pai' }));
    await user.click(screen.getByRole('button', { name: 'Desfazer' }));
    await user.click(screen.getByRole('button', { name: 'Refazer' }));
    expect(vi.mocked(engine.adapter.run).mock.calls.map((c) => c[0])).toEqual([
      'duplicate',
      'delete',
      'select-parent',
      'undo',
      'redo',
    ]);
  });

  it('move up / down and "Restaurar posição" route to the engine', async () => {
    const user = userEvent.setup();
    await loaded();
    const up = screen.getByRole('button', { name: 'Mover para cima' }) as HTMLButtonElement;
    const down = screen.getByRole('button', { name: 'Mover para baixo' }) as HTMLButtonElement;
    const reset = screen.getByRole('button', { name: 'Restaurar posição' }) as HTMLButtonElement;
    // nothing selected: all disabled
    expect([up.disabled, down.disabled, reset.disabled]).toEqual([true, true, true]);
    engine.emit({ selection: 'Campo' });
    expect([up.disabled, down.disabled, reset.disabled]).toEqual([false, false, true]);
    engine.emit({ selectionOffset: true });
    expect(reset.disabled).toBe(false);
    await user.click(up);
    await user.click(down);
    await user.click(reset);
    expect(vi.mocked(engine.adapter.run).mock.calls.map((c) => c[0])).toEqual([
      'move-up',
      'move-down',
      'reset-offset',
    ]);
  });

  it('zoom controls drive the engine', async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Aumentar zoom' }));
    expect(engine.adapter.setZoom).toHaveBeenLastCalledWith(67);
    await user.click(screen.getByRole('button', { name: 'Diminuir zoom' }));
    expect(engine.adapter.setZoom).toHaveBeenLastCalledWith(50);
  });

  it('follows the zoom the engine reports (Ctrl+wheel) and keeps it for the next zoom step', async () => {
    const user = userEvent.setup();
    await loaded();
    expect(screen.getByLabelText('Zoom atual').textContent).toBe('64%');
    engine.emit({ zoom: 150 });
    expect(screen.getByLabelText('Zoom atual').textContent).toBe('150%');
    // an unrelated emit (same zoom) must not touch the display
    engine.emit({ selection: 'Campo' });
    expect(screen.getByLabelText('Zoom atual').textContent).toBe('150%');
    // the next step starts from the reported zoom
    await user.click(screen.getByRole('button', { name: 'Aumentar zoom' }));
    expect(engine.adapter.setZoom).toHaveBeenLastCalledWith(200);
  });

  it('lists the navigation shortcuts', async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Atalhos do teclado' }));
    expect(screen.getByText('Espaço + arrastar')).toBeTruthy();
    expect(screen.getByText('Botão do meio + arrastar')).toBeTruthy();
    expect(screen.getByText('Ctrl + roda')).toBeTruthy();
    expect(screen.getByText('Arrastar')).toBeTruthy();
    expect(screen.getByText('Alt + arrastar')).toBeTruthy();
    expect(screen.getByText('Mover livremente')).toBeTruthy();
    expect(screen.getByText('Ctrl + ↑ / ↓')).toBeTruthy();
    expect(screen.getByText('Shift + clique no bloco')).toBeTruthy();
    expect(screen.getByText('Inserir acima')).toBeTruthy();
  });

  it('"Gerar imagem" (P3 button) renders the saved version and shows the dialog', async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(await screen.findByRole('button', { name: /Gerar imagem/ }));
    expect(await screen.findByRole('dialog', { name: 'Imagem do protótipo' })).toBeTruthy();
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/prototypes/p1/render')).toBe(
        true,
      ),
    );
    // nothing was dirty: no save
    expect(puts()).toHaveLength(0);
  });

  it('"Gerar imagem" saves pending edits first, then renders', async () => {
    const user = userEvent.setup();
    await loaded();
    engine.emit({ dirty: true });
    await user.click(await screen.findByRole('button', { name: /Gerar imagem/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/prototypes/p1/render')).toBe(
        true,
      ),
    );
    const order = calls.map((c) => `${c.method} ${c.url}`);
    expect(order.indexOf('PUT /api/prototypes/p1')).toBeLessThan(
      order.indexOf('POST /api/prototypes/p1/render'),
    );
    expect(puts()).toHaveLength(1);
  });

  it('"Enviar ao documento" saves if dirty and opens the send dialog', async () => {
    const user = userEvent.setup();
    await loaded();
    engine.emit({ dirty: true });
    await user.click(await screen.findByRole('button', { name: /Enviar ao documento/ }));
    expect(await screen.findByRole('dialog', { name: 'Enviar para o documento' })).toBeTruthy();
    expect(puts()).toHaveLength(1);
  });

  it('"Enviar ao documento" does not save when clean', async () => {
    const user = userEvent.setup();
    await loaded();
    await user.click(await screen.findByRole('button', { name: /Enviar ao documento/ }));
    expect(await screen.findByRole('dialog', { name: 'Enviar para o documento' })).toBeTruthy();
    expect(puts()).toHaveLength(0);
  });

  it('shows where the image was sent, with links to the steps', async () => {
    current = detail({ sentTo: [{ sessionId: 's1', stepId: 'st1', at: 1 }] });
    await loaded();
    const link = await screen.findByRole('link', { name: /passo em/ });
    expect(link.getAttribute('href')).toBe('/tests/s1#step-st1');
    await waitFor(() => expect(link.textContent).toBe('passo em Fluxo de empenho'));
  });

  describe('assistant (Pedir à IA)', () => {
    const ask = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: /Pedir à IA/ }));
      await user.type(await screen.findByLabelText('Pedido livre'), 'Troque o texto');
      await user.click(screen.getByRole('button', { name: 'Enviar pedido' }));
      await screen.findByText('Troquei o texto.');
    };

    it('sends the current canvas to the assistant', async () => {
      const user = userEvent.setup();
      await loaded();
      engine.emit({ dirty: true });
      await ask(user);
      const request = calls.find((c) => c.url === '/api/prototypes/p1/assistant')!;
      expect(request.body).toMatchObject({
        prompt: 'Troque o texto',
        html: '<body><p>editado</p></body>',
        css: 'p{color:red}',
        width: 1280,
        height: 720,
      });
    });

    it('applies: loads the answer keeping the zoom, saves "IA: …" and marks clean', async () => {
      const user = userEvent.setup();
      await loaded();
      await ask(user);
      await user.click(screen.getByRole('button', { name: 'Aplicar' }));
      await waitFor(() => expect(puts()).toHaveLength(1));
      expect(engine.adapter.load).toHaveBeenLastCalledWith({
        html: '<body><p>da IA</p></body>',
        css: 'p{color:blue}',
        width: 1280,
        height: 720,
      });
      // zoom kept (fitZoom was only used by the first load)
      expect(engine.adapter.fitZoom).toHaveBeenCalledTimes(1);
      expect(engine.adapter.setZoom).toHaveBeenLastCalledWith(64);
      expect((puts()[0]!.body as { note: string }).note).toBe('IA: Troque o texto');
      expect(engine.adapter.markClean).toHaveBeenCalled();
      expect(screen.getByText('Salvo')).toBeTruthy();
    });

    it('truncates the version note to 150 characters of the prompt', async () => {
      const user = userEvent.setup();
      await loaded();
      await user.click(screen.getByRole('button', { name: /Pedir à IA/ }));
      await user.click(await screen.findByLabelText('Pedido livre'));
      await user.paste('x'.repeat(400));
      await user.click(screen.getByRole('button', { name: 'Enviar pedido' }));
      await screen.findByText('Troquei o texto.');
      await user.click(screen.getByRole('button', { name: 'Aplicar' }));
      await waitFor(() => expect(puts()).toHaveLength(1));
      expect((puts()[0]!.body as { note: string }).note).toBe(`IA: ${'x'.repeat(150)}`);
    });

    it('offers the selected component (html + path) as a scope', async () => {
      const user = userEvent.setup();
      vi.mocked(engine.adapter.getSelectionPath).mockReturnValue({
        html: '<div class="ec-field">x</div>',
        path: [0, 2],
      });
      await loaded();
      engine.emit({ selection: 'Campo' });
      await user.click(screen.getByRole('button', { name: /Pedir à IA/ }));
      await user.selectOptions(await screen.findByLabelText('Escopo'), 'Componente selecionado');
      await user.type(screen.getByLabelText('Pedido livre'), 'Troque');
      await user.click(screen.getByRole('button', { name: 'Enviar pedido' }));
      await screen.findByText('Troquei o texto.');
      const request = calls.find((c) => c.url === '/api/prototypes/p1/assistant')!;
      expect((request.body as { selection: unknown }).selection).toEqual({
        path: [0, 2],
        html: '<div class="ec-field">x</div>',
      });
    });
  });

  it('shows an error when the prototype cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/prototypes/p1'
          ? json({ error: { message: 'Protótipo não encontrado' } }, 404)
          : json([]),
      ),
    );
    renderEditor();
    expect(await screen.findByText(/Protótipo não encontrado/)).toBeTruthy();
    expect(engine.adapter.load).not.toHaveBeenCalled();
  });

  it('destroys the engine when leaving the page', async () => {
    const { unmount } = renderEditor();
    await waitFor(() => expect(engine.adapter.load).toHaveBeenCalled());
    expect(engine.adapter.destroy).not.toHaveBeenCalled();
    unmount();
    expect(engine.adapter.destroy).toHaveBeenCalled();
  });

  describe('favorites in the e-Cidade palette', () => {
    const LOOKUP =
      '<table class="layout"><tbody><tr data-ec="lookup"><td class="l" data-ec-part="label">Empenho:</td><td><input class="in" data-ec-part="input"></td></tr></tbody></table>';
    const posts = () =>
      calls.filter((c) => c.method === 'POST' && c.url === '/api/prototypes/blocks');
    const favorite = (over: Partial<PrototypeBlockDto> = {}) =>
      block({
        id: 'f1',
        name: 'Lookup de empenho',
        category: 'e-Cidade',
        html: LOOKUP,
        css: 'td{padding:0}',
        source: 'Favorito de Cobrança',
        ...over,
      });

    it('the toolbar star saves the selected recognized component as a favorite of the e-Cidade palette', async () => {
      const user = userEvent.setup();
      await loaded();
      const star = screen.getByRole('button', { name: 'Favoritar na paleta' });
      expect((star as HTMLButtonElement).disabled).toBe(true);
      // a selected element that is not a recognized component cannot be favorited
      engine.emit({ selection: 'Texto', selectionKind: null });
      expect((star as HTMLButtonElement).disabled).toBe(true);
      vi.mocked(engine.adapter.getSelectionAsBlock).mockReturnValue({
        label: 'Lookup: Empenho',
        html: LOOKUP,
        css: 'td{padding:0}\ninput{border:1px solid red}',
      });
      engine.emit({ selection: 'Lookup: Empenho', selectionKind: 'lookup' });
      expect((star as HTMLButtonElement).disabled).toBe(false);
      await user.click(star);
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]!.body).toEqual({
        name: 'Lookup: Empenho',
        category: 'e-Cidade',
        html: LOOKUP,
        css: 'td{padding:0}\ninput{border:1px solid red}',
        source: 'Favorito de Consulta Empenho',
      });
    });

    it('the star of a "Desta tela" tile (reported by the engine) favorites that component', async () => {
      let mount: EditorMount | undefined;
      vi.mocked(loadEditorAdapter).mockResolvedValue((m) => {
        mount = m;
        return engine.adapter;
      });
      await loaded();
      act(() => mount!.onFavorite!({ label: 'Lookup (Empenho)', html: LOOKUP, css: 'td{a:b}' }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]!.body).toMatchObject({
        name: 'Lookup (Empenho)',
        category: 'e-Cidade',
        css: 'td{a:b}',
        source: 'Favorito de Consulta Empenho',
      });
    });

    it('a component that came from a favorite is saved without its scope', async () => {
      let mount: EditorMount | undefined;
      vi.mocked(loadEditorAdapter).mockResolvedValue((m) => {
        mount = m;
        return engine.adapter;
      });
      await loaded();
      const scoped = ':where([data-ec-fav="f9"],[data-ec-fav="f9"] *):is(td){padding:0}\n.a{b:c}';
      act(() =>
        mount!.onFavorite!({
          label: 'Lookup',
          html: LOOKUP.replace('<tr ', '<tr data-ec-fav="f9" '),
          css: scoped,
        }),
      );
      await waitFor(() => expect(posts()).toHaveLength(1));
      const body = posts()[0]!.body as { html: string; css: string };
      expect(body.html).not.toContain('data-ec-fav');
      expect(body.css).toBe('td{padding:0}\n.a{b:c}');
    });

    it('the same structure twice asks: replace (new one first, then the old is removed) or keep both', async () => {
      const user = userEvent.setup();
      blocks = [favorite()];
      let mount: EditorMount | undefined;
      vi.mocked(loadEditorAdapter).mockResolvedValue((m) => {
        mount = m;
        return engine.adapter;
      });
      await loaded();
      const same = {
        label: 'Lookup (Reduzido)',
        html: LOOKUP.replace('Empenho:', 'Reduzido:'),
        css: '',
      };

      act(() => mount!.onFavorite!(same));
      const dialog = await screen.findByRole('dialog', { name: 'Já existe um favorito igual' });
      expect(dialog.textContent).toContain('Lookup de empenho');
      expect(posts()).toHaveLength(0);
      await user.click(within(dialog).getByRole('button', { name: 'Manter os dois' }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

      act(() => mount!.onFavorite!(same));
      const again = await screen.findByRole('dialog', { name: 'Já existe um favorito igual' });
      await user.click(within(again).getByRole('button', { name: 'Substituir' }));
      await waitFor(() =>
        expect(
          calls.some((c) => c.method === 'DELETE' && c.url === '/api/prototypes/blocks/f1'),
        ).toBe(true),
      );
      expect(posts()).toHaveLength(2);
      const order = calls.filter(
        (c) => c.url.startsWith('/api/prototypes/blocks') && c.method !== 'GET',
      );
      expect(order.map((c) => c.method)).toEqual(['POST', 'POST', 'DELETE']);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('a different structure is saved straight away, with no question', async () => {
      blocks = [favorite()];
      let mount: EditorMount | undefined;
      vi.mocked(loadEditorAdapter).mockResolvedValue((m) => {
        mount = m;
        return engine.adapter;
      });
      await loaded();
      act(() =>
        mount!.onFavorite!({
          label: 'Combo',
          html: '<div data-ec="select"><select data-ec-part="input"></select></div>',
          css: '',
        }),
      );
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('lists the favorites with a star, inserts them scoped, renames and removes them', async () => {
      const user = userEvent.setup();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      blocks = [favorite(), block()];
      await loaded();
      const section = await screen.findByRole('region', { name: 'Favoritos' });
      const row = within(section).getByText('Lookup de empenho');
      expect(row.textContent).toContain('⭐');
      expect(row.getAttribute('title')).toBe('Favorito de Cobrança');
      // "Meus blocos" keeps the other blocks
      const mine = screen.getByRole('region', { name: 'Meus blocos' });
      expect(within(mine).getByText('Cabeçalho padrão')).toBeTruthy();
      expect(within(mine).queryByText('Lookup de empenho')).toBeNull();

      await user.click(within(section).getByRole('button', { name: 'Inserir Lookup de empenho' }));
      expect(engine.adapter.insertBlock).toHaveBeenCalledWith({
        html: LOOKUP,
        css: 'td{padding:0}',
        scope: 'f1',
      });

      await user.click(
        within(section).getByRole('button', { name: 'Renomear favorito Lookup de empenho' }),
      );
      const dialog = await screen.findByRole('dialog', { name: 'Renomear favorito' });
      const input = within(dialog).getByLabelText('Nome');
      await user.clear(input);
      await user.type(input, 'Lookup do empenho 2');
      await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
      await waitFor(() =>
        expect(
          calls.find((c) => c.method === 'PUT' && c.url === '/api/prototypes/blocks/f1')?.body,
        ).toEqual({
          name: 'Lookup do empenho 2',
        }),
      );

      await user.click(
        within(section).getByRole('button', { name: 'Excluir favorito Lookup de empenho' }),
      );
      await waitFor(() =>
        expect(
          calls.some((c) => c.method === 'DELETE' && c.url === '/api/prototypes/blocks/f1'),
        ).toBe(true),
      );
    });
  });

  describe('templates', () => {
    it('"Salvar como modelo" copies the saved version into a template', async () => {
      const user = userEvent.setup();
      await loaded();
      await user.click(screen.getByRole('button', { name: /Salvar como modelo/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Salvar como modelo' });
      const input = within(dialog).getByLabelText('Nome do modelo') as HTMLInputElement;
      expect(input.value).toBe('Consulta Empenho');
      await user.clear(input);
      await user.type(input, 'Modelo de consulta');
      await user.click(within(dialog).getByRole('button', { name: 'Salvar modelo' }));
      await waitFor(() =>
        expect(
          calls.find((c) => c.method === 'POST' && c.url === '/api/prototypes/p1/save-as-template')
            ?.body,
        ).toEqual({ name: 'Modelo de consulta' }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      // nothing else was saved: the editor was clean
      expect(puts()).toHaveLength(0);
    });

    it('saves pending edits first, so the template has what is on the canvas', async () => {
      const user = userEvent.setup();
      await loaded();
      engine.emit({ dirty: true });
      await user.click(screen.getByRole('button', { name: /Salvar como modelo/ }));
      await screen.findByRole('dialog', { name: 'Salvar como modelo' });
      expect(puts()).toHaveLength(1);
      // the copy is only made when the name is confirmed
      expect(calls.some((c) => c.url.endsWith('/save-as-template'))).toBe(false);
    });

    it('a template is edited like a prototype and marked as such (and cannot become a template again)', async () => {
      current = detail({ kind: 'template', name: 'Meu modelo' });
      await loaded();
      expect(screen.getByText('Modelo')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Salvar como modelo/ })).toBeNull();
    });
  });
});
