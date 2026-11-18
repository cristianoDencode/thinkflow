import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CtStateDto, OneDriveStatusDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notify } from '../../lib/notify';
import { ThemeProvider } from '../../lib/theme';
import { json, sessionDetail } from './fixtures';
import { TestSessionPage } from './session-page';

const PLANO_HTML = '<table><tr><td>Caso de Uso 1</td></tr></table>';
const PLANO_TEXT = 'Caso de Uso 1 — Finalizado\nAbre a tela\n';
const EVIDENCE_HTML = '<!doctype html><html><body><h1>Evidência de teste</h1></body></html>';
const EVIDENCE_MD = '# Evidência de teste\n';

function ctState(over: Partial<CtStateDto> = {}): CtStateDto {
  return {
    fields: {
      title: 'Cadastro de contribuinte',
      ticketId: '900.001',
      priority: 'Normal',
      systemModule: 'Financeiro / Empenho',
      author: 'Alex',
      analysisTitle: 'Análise',
      context: 'Contexto inicial',
      versions: [
        {
          version: '1.0',
          date: '12/11/2026',
          description: 'Criação do documento',
          author: 'Alex',
        },
      ],
    },
    modelId: 'default',
    useCases: [{ stepId: null, title: '', defaultTitle: 'Caso de Uso 1', status: 'Finalizado' }],
    imageCount: 2,
    document: {
      title: 'Cadastro de contribuinte',
      analysisTitle: 'Análise',
      context: 'Contexto inicial',
      useCases: [
        { status: 'Finalizado', items: [{ kind: 'text', text: 'Abre a tela' }, { kind: 'image' }] },
      ],
    },
    itemStepIds: [['st1', 'st1']],
    warnings: [],
    ...over,
  };
}

const onedriveStatus = (state: OneDriveStatusDto['state']): OneDriveStatusDto => ({
  clientId: '',
  hasClientSecret: false,
  redirectUri: 'http://localhost/cb',
  redirectUriOverride: '',
  redirectUriWarning: null,
  state,
  account: state === 'connected' ? { name: 'Ana', email: 'ana@x.com' } : null,
  connectedAt: null,
  defaultFolder: null,
  namingPattern: 'CT {ticketId} - {title}.docx',
  defaultNamingPattern: 'CT {ticketId} - {title}.docx',
  scopes: [],
});

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/tests/:id', element: <TestSessionPage /> }], {
    initialEntries: ['/tests/s1?tab=document'],
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

class FakeClipboardItem {
  constructor(public readonly items: Record<string, Blob>) {}
}

describe('document tab (Caso de Teste CT)', () => {
  let written: unknown[];
  let calls: { method: string; url: string; body?: unknown }[];
  let drive: OneDriveStatusDto['state'];
  let ct: CtStateDto;
  let downloads: string[];

  beforeEach(() => {
    written = [];
    calls = [];
    downloads = [];
    drive = 'connected';
    ct = ctState();
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items: unknown[]) => void written.push(...items),
        writeText: async () => undefined,
      },
    });
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
    vi.stubGlobal('open', vi.fn());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({
          method,
          url,
          ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
        });
        if (url === '/api/tests/support')
          return json({ recording: { supported: true, message: '' } });
        if (url === '/api/tests/sessions/s1') return json(sessionDetail({ mode: 'record' }));
        if (url === '/api/integrations/onedrive') return json(onedriveStatus(drive));
        if (url === '/api/tests/sessions/s1/ct' && method === 'GET') return json(ct);
        if (url === '/api/tests/sessions/s1/ct' && method === 'PUT') {
          const body = JSON.parse(init!.body as string) as CtStateDto['fields'];
          ct = ctState({ fields: { ...ct.fields, ...body } });
          return json(ct);
        }
        if (url === '/api/tests/sessions/s1/ct/clipboard')
          return new Response(PLANO_HTML, { headers: { 'content-type': 'text/html' } });
        if (url === '/api/tests/sessions/s1/ct/clipboard?format=text')
          return new Response(PLANO_TEXT);
        if (url === '/api/tests/sessions/s1/ct/docx')
          return new Response('docx-bytes', {
            headers: {
              'content-disposition':
                'attachment; filename="CT 900.001 - Cadastro.docx"; filename*=UTF-8\'\'CT%20900.001%20-%20Cadastro.docx',
            },
          });
        if (url === '/api/tests/sessions/s1/ct/pdf')
          return json({ error: { message: 'Não foi possível gerar o PDF (sem Chromium).' } }, 503);
        if (url === '/api/tests/sessions/s1/ct/onedrive')
          return json({
            id: 'N1',
            name: 'CT 900.001 - Cadastro.docx',
            webUrl: 'https://1drv.ms/w/x',
          });
        if (url.endsWith('/document?format=html'))
          return new Response(EVIDENCE_HTML, { headers: { 'content-type': 'text/html' } });
        if (url.endsWith('/document?format=md&inline=1')) return new Response(EVIDENCE_MD);
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the form with the saved values and the preview from the server', async () => {
    renderTab();
    expect(await screen.findByLabelText('Título')).toHaveProperty(
      'value',
      'Cadastro de contribuinte',
    );
    expect(screen.getByLabelText('ID/Código do Chamado')).toHaveProperty('value', '900.001');
    expect(screen.getByLabelText('Contexto'.replace('Contexto', '2.1. Contexto'))).toHaveProperty(
      'value',
      'Contexto inicial',
    );
    expect(screen.getByLabelText('Título do caso de uso 1')).toHaveProperty('value', '');
    expect(screen.getByLabelText('Status do caso de uso 1')).toHaveProperty('value', 'Finalizado');
    const frame = screen.getByTitle('Pré-visualização do documento CT');
    expect(frame.getAttribute('src')).toMatch(/^\/api\/tests\/sessions\/s1\/ct\/preview\?v=/);
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    // the model selector starts on the built-in "Padrão"
    expect(screen.getByLabelText('Modelo')).toHaveProperty('value', 'default');
  });

  it('saves edits (fields, use case, versions) and refreshes the preview', async () => {
    renderTab();
    const title = await screen.findByLabelText('Título');
    const frame = screen.getByTitle('Pré-visualização do documento CT');
    const before = frame.getAttribute('src');
    const save = screen.getByRole('button', { name: /Salvar/ });
    expect(save).toHaveProperty('disabled', true);

    await userEvent.clear(title);
    await userEvent.type(title, 'Novo título');
    await userEvent.type(screen.getByLabelText('Título do caso de uso 1'), 'Cálculo');
    await userEvent.clear(screen.getByLabelText('Status do caso de uso 1'));
    await userEvent.type(screen.getByLabelText('Status do caso de uso 1'), 'Reprovado');
    await userEvent.click(screen.getByRole('button', { name: /Adicionar versão/ }));
    expect(screen.getByLabelText('Versão da linha 2')).toHaveProperty('value', '1.1');
    await userEvent.type(screen.getByLabelText('Descrição da linha 2'), 'Ajuste');
    expect(screen.getByText(/Alterações não salvas/)).toBeTruthy();

    await userEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!.body as Record<string, unknown>;
    expect(put).toMatchObject({
      title: 'Novo título',
      ticketId: '900.001',
      useCases: [{ stepId: null, title: 'Cálculo', status: 'Reprovado' }],
    });
    expect((put.versions as unknown[]).length).toBe(2);
    await waitFor(() => expect(screen.queryByText(/Alterações não salvas/)).toBeNull());
    expect(screen.getByTitle('Pré-visualização do documento CT').getAttribute('src')).not.toBe(
      before,
    );
  });

  it('removes a version row but never the last one', async () => {
    renderTab();
    await screen.findByLabelText('Título');
    expect(screen.getByRole('button', { name: 'Remover versão da linha 1' })).toHaveProperty(
      'disabled',
      true,
    );
    await userEvent.click(screen.getByRole('button', { name: /Adicionar versão/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Remover versão da linha 2' }));
    expect(screen.queryByLabelText('Versão da linha 2')).toBeNull();
  });

  it('downloads the .docx with the server file name and explains a failing PDF', async () => {
    renderTab();
    await screen.findByLabelText('Título');
    await userEvent.click(screen.getByRole('button', { name: /Baixar .docx/ }));
    await waitFor(() => expect(downloads).toEqual(['CT 900.001 - Cadastro.docx']));
    expect(calls.some((c) => c.url === '/api/tests/sessions/s1/ct/docx')).toBe(true);

    const error = vi.spyOn(notify, 'error');
    await userEvent.click(screen.getByRole('button', { name: /Baixar PDF/ }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('Não foi possível gerar o PDF (sem Chromium).'),
    );
    expect(downloads).toHaveLength(1);
  });

  it('saves pending edits before exporting', async () => {
    renderTab();
    await userEvent.type(await screen.findByLabelText('ID/Código do Chamado'), '1');
    await userEvent.click(screen.getByRole('button', { name: /Baixar .docx/ }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    const order = calls.filter((c) => c.method === 'PUT' || c.url.endsWith('/ct/docx'));
    expect(order.map((c) => c.method)).toEqual(['PUT', 'GET']);
  });

  it('copies the Plano de Teste as HTML with a plain-text flavor', async () => {
    renderTab();
    await screen.findByLabelText('Título');
    await userEvent.click(screen.getByRole('button', { name: /Copiar Plano de Teste/ }));
    await waitFor(() => expect(written).toHaveLength(1));
    const item = written[0] as FakeClipboardItem;
    expect(await item.items['text/html']!.text()).toBe(PLANO_HTML);
    expect(await item.items['text/plain']!.text()).toBe(PLANO_TEXT);
  });

  it('sends to OneDrive when connected: opens the file and shows the link', async () => {
    renderTab();
    await screen.findByLabelText('Título');
    const button = await screen.findByRole('button', { name: /Enviar ao OneDrive/ });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    await userEvent.click(button);
    const link = await screen.findByRole('link', { name: /CT 900.001 - Cadastro.docx/ });
    expect(link.getAttribute('href')).toBe('https://1drv.ms/w/x');
    expect(window.open).toHaveBeenCalledWith(
      'https://1drv.ms/w/x',
      '_blank',
      'noopener,noreferrer',
    );
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/ct/onedrive'))).toBe(true);
  });

  it('disables the OneDrive button and points to the settings when not connected', async () => {
    drive = 'disconnected';
    renderTab();
    await screen.findByLabelText('Título');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Enviar ao OneDrive/ })).toHaveProperty(
        'disabled',
        true,
      ),
    );
    const link = await screen.findByRole('link', { name: /Configurações › OneDrive/ });
    expect(link.getAttribute('href')).toBe('/settings');
    expect(calls.some((c) => c.url.endsWith('/ct/onedrive'))).toBe(false);
  });

  it('keeps the old formats under "Outros formatos"', async () => {
    renderTab();
    await screen.findByLabelText('Título');
    const menu = screen.getByText('Outros formatos').closest('details')!;
    await userEvent.click(within(menu).getByText('Outros formatos'));
    expect(
      within(menu)
        .getByRole('link', { name: /Baixar .zip/ })
        .getAttribute('href'),
    ).toBe('/api/tests/sessions/s1/document?format=zip');
    expect(
      within(menu)
        .getByRole('link', { name: /Baixar script Playwright/ })
        .getAttribute('href'),
    ).toBe('/api/tests/sessions/s1/document?format=spec');
    await userEvent.click(within(menu).getByRole('button', { name: /Copiar para Word\/Docs/ }));
    await waitFor(() => expect(written).toHaveLength(1));
    const item = written[0] as FakeClipboardItem;
    expect(await item.items['text/html']!.text()).toBe(EVIDENCE_HTML);
    expect(await item.items['text/plain']!.text()).toBe(EVIDENCE_MD);
  });

  it('mounts the AI assistant panel', async () => {
    renderTab();
    await screen.findByLabelText('Título');
    expect(screen.getAllByText(/Revisar escrita/).length).toBeGreaterThan(0);
  });
});
