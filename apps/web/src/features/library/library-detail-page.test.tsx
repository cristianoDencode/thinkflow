import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LibraryDetailDto, LibraryDocumentDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { LibraryDetailPage } from './library-detail-page';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const doc = (over: Partial<LibraryDocumentDto>): LibraryDocumentDto => ({
  id: 'd1',
  libraryId: 'l1',
  name: 'a.pdf',
  mimeType: 'application/pdf',
  kind: 'pdf',
  sizeBytes: 2048,
  status: 'ready',
  error: null,
  extraction: 'text',
  pageCount: 3,
  charCount: 100,
  chunkCount: 4,
  createdAt: 1,
  updatedAt: 1,
  remote: null,
  ...over,
});

function makeLibrary(documents: LibraryDocumentDto[]): LibraryDetailDto {
  return {
    id: 'l1',
    name: 'Contratos',
    description: '',
    engine: 'local',
    documentCount: documents.length,
    maxDocuments: 1000,
    readyCount: 1,
    processingCount: 0,
    errorCount: 0,
    totalChars: 100,
    createdAt: 1,
    updatedAt: 1,
    remoteNotebookId: null,
    documents,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/library', element: <p>lista</p> },
      { path: '/library/:id', element: <LibraryDetailPage /> },
    ],
    { initialEntries: ['/library/l1'] },
  );
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('LibraryDetailPage', () => {
  let detail: LibraryDetailDto;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    detail = makeLibrary([
      doc({}),
      doc({ id: 'd2', name: 'scan.png', kind: 'image', status: 'processing', extraction: null }),
      doc({
        id: 'd3',
        name: 'foto.jpg',
        kind: 'image',
        status: 'error',
        error: 'OCR desativado em Biblioteca → Configurações',
        extraction: null,
      }),
      doc({
        id: 'd4',
        name: 'quebrado.docx',
        kind: 'docx',
        status: 'error',
        error: 'Arquivo corrompido',
      }),
    ]);
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === '/api/libraries/l1' && method === 'GET') return json(detail);
      if (url === '/api/library/notebooklm')
        return json({ enabled: true, hasCredentials: true, queriesToday: 7, dailyQueryLimit: 50 });
      if (url === '/api/libraries/l1/documents/d1/sync' && method === 'POST')
        return json(doc({ remote: { status: 'pending', error: null } }), 202);
      if (url === '/api/libraries/l1' && method === 'DELETE') return json({ ok: true });
      if (url === '/api/libraries/l1/documents' && method === 'POST')
        return json({ accepted: [doc({ id: 'n1', name: 'novo.txt' })], rejected: [] }, 201);
      if (url.startsWith('/api/libraries/l1/search'))
        return json({
          engine: 'local',
          hits: [
            {
              documentId: 'd1',
              documentName: 'a.pdf',
              heading: null,
              pageFrom: 2,
              pageTo: 2,
              excerpt: 'prazo de 30 dias',
              score: 1,
            },
          ],
          toolOutput: 'TRECHOS PARA A IA',
          isError: false,
        });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the document counter against the library limit, not a fixed 50', async () => {
    renderPage();
    expect(await screen.findByText('4/1000 documentos')).toBeTruthy();
    expect(screen.getByText(/996 vagas restantes/)).toBeTruthy();
  });

  it('uses the account source limit of a NotebookLM library for the counter and free slots', async () => {
    detail = { ...makeLibrary([doc({}), doc({ id: 'd2', name: 'b.pdf' })]), engine: 'notebooklm' };
    detail.maxDocuments = 300;
    renderPage();
    expect(await screen.findByText('2/300 documentos')).toBeTruthy();
    expect(screen.getByText(/298 vagas restantes/)).toBeTruthy();
  });

  it('rejects files above the limit client-side with the library limit in the message', async () => {
    detail = makeLibrary([doc({}), doc({ id: 'd2', name: 'b.pdf' })]);
    detail.maxDocuments = 3;
    renderPage();
    expect(await screen.findByText(/1 vaga restante/)).toBeTruthy();
    fireEvent.drop(screen.getByTestId('dropzone'), {
      dataTransfer: {
        files: [
          new File(['a'], 'um.txt'),
          new File(['b'], 'dois.txt'),
          new File(['c'], 'tres.txt'),
        ],
      },
    });
    expect(await screen.findAllByText(/Limite de 3 documentos por biblioteca/)).toHaveLength(2);
  });

  it('renders status badges, special-casing the disabled-OCR state', async () => {
    renderPage();
    expect(await screen.findByText('a.pdf')).toBeTruthy();
    expect(screen.getByText('Pronto')).toBeTruthy();
    expect(screen.getByText('Processando')).toBeTruthy();
    expect(screen.getByText('OCR desativado')).toBeTruthy();
    expect(screen.getByText('Erro')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reprocessar foto.jpg' })).toBeTruthy();
  });

  it('uploads dropped files as FormData and rejects invalid ones client-side', async () => {
    renderPage();
    await screen.findByText('a.pdf');
    const good = new File(['hello'], 'novo.txt', { type: 'text/plain' });
    const exe = new File(['x'], 'virus.exe');
    const big = new File(['x'], 'grande.pdf');
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    fireEvent.drop(screen.getByTestId('dropzone'), {
      dataTransfer: { files: [good, exe, big] },
    });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) =>
          u === '/api/libraries/l1/documents' && (i as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = (call![1] as RequestInit).body;
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).getAll('files')).toHaveLength(1);
      expect((call![1] as RequestInit).headers).toEqual({});
    });
    expect(await screen.findByText(/Tipo de arquivo não suportado/)).toBeTruthy();
    expect(screen.getByText(/Arquivo maior que 20 MB/)).toBeTruthy();
  });

  it('exposes a keyboard-accessible file input', async () => {
    renderPage();
    await screen.findByText('a.pdf');
    const input = screen.getByTestId('file-input') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(screen.getByTestId('dropzone').getAttribute('tabindex')).toBe('0');
  });

  it('deletes the library after confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByText('a.pdf');
    await user.click(screen.getByRole('button', { name: 'Excluir biblioteca' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) =>
            u === '/api/libraries/l1' && (i as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    expect(await screen.findByText('lista')).toBeTruthy();
  });

  it('renders search hits and the tool output', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('a.pdf');
    await user.type(screen.getByLabelText('Pergunta de teste'), 'prazo');
    await user.click(screen.getByRole('button', { name: /Buscar/ }));
    expect(await screen.findByText('prazo de 30 dias')).toBeTruthy();
    expect(screen.getByText('TRECHOS PARA A IA')).toBeTruthy();
  });

  it('shows the NotebookLM banner, per-document sync state and retries a failed sync', async () => {
    const user = userEvent.setup();
    detail = {
      ...makeLibrary([
        doc({ remote: { status: 'error', error: 'Limite de uso do NotebookLM atingido.' } }),
        doc({ id: 'd2', name: 'b.pdf', remote: { status: 'synced', error: null } }),
        doc({ id: 'd3', name: 'c.pdf', remote: { status: 'syncing', error: null } }),
      ]),
      engine: 'notebooklm',
      remoteNotebookId: 'nb_1',
    };
    renderPage();
    expect(
      await screen.findByText(/Experimental: os documentos e perguntas são enviados/),
    ).toBeTruthy();
    expect(await screen.findByText('Consultas hoje: 7/50')).toBeTruthy();
    expect(screen.getByText('Sincronizado')).toBeTruthy();
    expect(screen.getByText('Sincronizando')).toBeTruthy();
    expect(screen.getByTitle('Limite de uso do NotebookLM atingido.').textContent).toBe('Erro');

    await user.click(screen.getByRole('button', { name: 'Sincronizar a.pdf' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) =>
            u === '/api/libraries/l1/documents/d1/sync' &&
            (i as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    );
  });
});
