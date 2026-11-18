import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LibraryDto, NotebookLmSettingsDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { LibraryPage } from './library-page';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const lib = (over: Partial<LibraryDto> = {}): LibraryDto => ({
  id: 'l1',
  name: 'Contratos',
  description: 'Contratos de 2026',
  engine: 'local',
  documentCount: 3,
  maxDocuments: 1000,
  readyCount: 1,
  processingCount: 1,
  errorCount: 1,
  totalChars: 1000,
  createdAt: 1,
  updatedAt: Date.now(),
  remoteNotebookId: null,
  ...over,
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/library', element: <LibraryPage /> },
      { path: '/library/:id', element: <p>detalhe</p> },
    ],
    { initialEntries: ['/library'] },
  );
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('LibraryPage', () => {
  let libraries: LibraryDto[];
  let notebookLm: Partial<NotebookLmSettingsDto>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    notebookLm = { enabled: false, hasCredentials: false, queriesToday: 4, dailyQueryLimit: 50 };
    libraries = [
      lib(),
      lib({
        id: 'l2',
        name: 'Remota',
        engine: 'notebooklm',
        maxDocuments: 300,
        documentCount: 0,
        processingCount: 0,
        errorCount: 0,
      }),
    ];
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/libraries' && init?.method === 'POST')
        return json(lib({ id: 'new', name: 'Nova' }), 201);
      if (url === '/api/libraries') return json(libraries);
      if (url === '/api/library/notebooklm') return json(notebookLm);
      if (url === '/api/library/settings')
        return json({ ocr: 'local', ocrModel: '', ocrLanguages: 'por+eng' });
      if (url === '/api/models') return json([]);
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders cards with badges and counts', async () => {
    renderPage();
    expect(await screen.findByText('Contratos')).toBeTruthy();
    expect(screen.getByText('Local')).toBeTruthy();
    expect(screen.getByText('NotebookLM · experimental')).toBeTruthy();
    expect(screen.getByText('3/1000 documentos')).toBeTruthy();
    expect(screen.getByText('0/300 documentos')).toBeTruthy();
    expect(screen.getByText('1 processando')).toBeTruthy();
    expect(screen.getByText('1 com erro')).toBeTruthy();
  });

  it('shows the empty state', async () => {
    libraries = [];
    renderPage();
    expect(await screen.findByText('Nenhuma biblioteca ainda')).toBeTruthy();
  });

  it('shows the daily query counter on NotebookLM cards only', async () => {
    renderPage();
    await screen.findByText('Remota');
    await waitFor(() => expect(screen.getAllByText('Consultas hoje: 4/50')).toHaveLength(1));
  });

  it('creates a local library and keeps NotebookLM disabled until it is configured', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Contratos');
    await user.click(screen.getAllByRole('button', { name: /Nova biblioteca/ })[0]!);
    const notebook = screen.getByRole('radio', { name: /NotebookLM/ }) as HTMLInputElement;
    expect(notebook.disabled).toBe(true);
    expect(screen.getByText('Configure na aba NotebookLM')).toBeTruthy();
    await user.type(screen.getByLabelText('Nome'), 'Nova');
    await user.click(screen.getByRole('button', { name: 'Criar biblioteca' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => u === '/api/libraries' && (i as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({
        name: 'Nova',
        engine: 'local',
      });
    });
    expect(await screen.findByText('detalhe')).toBeTruthy();
  });

  it('creates a NotebookLM library only after the upload consent', async () => {
    notebookLm = { enabled: true, hasCredentials: true, queriesToday: 0, dailyQueryLimit: 50 };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Contratos');
    await user.click(screen.getAllByRole('button', { name: /Nova biblioteca/ })[0]!);
    const radio = (await screen.findByRole('radio', { name: /NotebookLM/ })) as HTMLInputElement;
    await waitFor(() => expect(radio.disabled).toBe(false));
    await user.type(screen.getByLabelText('Nome'), 'Remota 2');
    await user.click(radio);

    const create = screen.getByRole('button', { name: 'Criar biblioteca' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await user.click(
      screen.getByRole('checkbox', {
        name: /Entendo que os documentos serão enviados para a conta Google configurada/,
      }),
    );
    expect(create.disabled).toBe(false);
    await user.click(create);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => u === '/api/libraries' && (i as RequestInit | undefined)?.method === 'POST',
      );
      expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({
        name: 'Remota 2',
        engine: 'notebooklm',
        acceptRemoteUpload: true,
      });
    });
  });

  it('mentions the account source limit on the NotebookLM option and the local limit on Local', async () => {
    notebookLm = {
      enabled: true,
      hasCredentials: true,
      queriesToday: 0,
      dailyQueryLimit: 50,
      sourceLimit: 300,
    };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Contratos');
    await user.click(screen.getAllByRole('button', { name: /Nova biblioteca/ })[0]!);
    expect(await screen.findByText(/Limite da conta: 300 documentos por biblioteca/)).toBeTruthy();
    expect(screen.getByText(/Até\s+1000 documentos/)).toBeTruthy();
  });

  it('offers NotebookLM when connected even if the switch is off, and enables it on create', async () => {
    notebookLm = { enabled: false, hasCredentials: true, queriesToday: 0, dailyQueryLimit: 50 };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Contratos');
    await user.click(screen.getAllByRole('button', { name: /Nova biblioteca/ })[0]!);
    const radio = (await screen.findByRole('radio', { name: /NotebookLM/ })) as HTMLInputElement;
    await waitFor(() => expect(radio.disabled).toBe(false));
    await user.type(screen.getByLabelText('Nome'), 'Remota 3');
    await user.click(radio);
    await user.click(screen.getByRole('checkbox', { name: /Entendo que os documentos/ }));
    await user.click(screen.getByRole('button', { name: 'Criar biblioteca' }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([u, i]) =>
          u === '/api/library/notebooklm' && (i as RequestInit | undefined)?.method === 'PUT',
      );
      expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({ enabled: true });
    });
  });

  it('attaches files while creating and uploads them to the new library', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Contratos');
    await user.click(screen.getAllByRole('button', { name: /Nova biblioteca/ })[0]!);
    await user.type(await screen.findByLabelText('Nome'), 'Com anexos');
    const input = screen.getByTestId('create-file-input') as HTMLInputElement;
    const file = new File(['conteudo'], 'regras.md', { type: 'text/markdown' });
    await user.upload(input, file);
    expect(screen.getByText(/regras\.md/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Criar biblioteca' }));
    await waitFor(() => {
      const up = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/documents'));
      expect(up).toBeTruthy();
      expect((up![1] as RequestInit).body).toBeInstanceOf(FormData);
    });
  });

  it('saves OCR settings', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('tab', { name: /Configurações/ }));
    await user.selectOptions(await screen.findByLabelText('Modo de OCR'), 'off');
    fetchMock.mockImplementationOnce(async () =>
      json({ ocr: 'off', ocrModel: '', ocrLanguages: 'por+eng' }),
    );
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) =>
          u === '/api/library/settings' && (i as RequestInit | undefined)?.method === 'PUT',
      );
      expect(call).toBeTruthy();
    });
  });
});
