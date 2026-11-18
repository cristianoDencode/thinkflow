import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ECIDADE_WINDOW_TEMPLATE_ID,
  type PrototypeDto,
  type PrototypeTemplateDto,
} from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { sessionSummary } from '../tests/fixtures';
import { detail, json, proto } from './fixtures';
import { PrototypesPage } from './prototypes-page';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/prototypes', element: <PrototypesPage /> },
      { path: '/prototypes/:id', element: <Where /> },
    ],
    { initialEntries: ['/prototypes'] },
  );
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { router };
}

describe('PrototypesPage', () => {
  let list: PrototypeDto[];
  let templateList: PrototypeDto[];
  let templates: PrototypeTemplateDto[];
  let calls: { method: string; url: string; body: unknown }[];

  beforeEach(() => {
    list = [
      proto({
        id: 'p1',
        name: 'Consulta Empenho',
        sessionId: 's1',
        sessionName: 'Fluxo de empenho',
        versionCount: 3,
      }),
      proto({
        id: 'p2',
        name: 'Cadastro de Fornecedor',
        source: {
          url: null,
          file: 'cad_fornecedor.php',
          menuPath: 'DB:COMPRAS > Cadastros',
          title: null,
        },
        width: 1366,
        height: 768,
        versionCount: 1,
      }),
    ];
    templateList = [
      proto({
        id: 't1',
        name: 'Modelo de consulta',
        kind: 'template',
        width: 1600,
        height: 900,
        thumbnailUrl: '/api/prototypes/t1/thumbnail?v=1',
      }),
    ];
    templates = [
      {
        id: ECIDADE_WINDOW_TEMPLATE_ID,
        name: 'Tela de sistema — perfil e-Cidade',
        description: 'Janela do e-Cidade com a barra azul.',
        builtin: true,
        width: 1366,
        height: 768,
        sizes: [
          { width: 1366, height: 768 },
          { width: 1920, height: 1080 },
        ],
        thumbnailUrl: '/api/prototypes/templates/builtin%3Aecidade-window/thumbnail',
        updatedAt: 0,
      },
      {
        id: 't1',
        name: 'Modelo de consulta',
        description: '',
        builtin: false,
        width: 1600,
        height: 900,
        sizes: [],
        thumbnailUrl: '/api/prototypes/t1/thumbnail?v=1',
        updatedAt: 1,
      },
    ];
    calls = [];
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
        if (url === '/api/prototypes' && method === 'POST')
          return json(detail({ id: 'new1', name: body.name }), 201);
        if (url === '/api/prototypes') return json(list);
        if (url === '/api/prototypes?kind=template') return json(templateList);
        if (url === '/api/prototypes/templates') return json(templates);
        if (url === '/api/prototypes/t1' && method === 'DELETE') {
          templateList = [];
          templates = templates.filter((t) => t.id !== 't1');
          return json(null, 204);
        }
        if (url === '/api/prototypes/p1' && method === 'DELETE') {
          list = list.filter((p) => p.id !== 'p1');
          return json(null, 204);
        }
        if (url === '/api/prototypes/p1' && method === 'PUT')
          return json(detail({ name: body.name }));
        if (url === '/api/prototypes/p1')
          return json(detail({ html: '<body><p>tela</p></body>', css: 'p{color:red}' }));
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists prototypes with source file, menu path, session link, size and versions', async () => {
    renderPage();
    expect(await screen.findByText('Consulta Empenho')).toBeTruthy();
    expect(screen.getByText('emp1_empconsulta001.php')).toBeTruthy();
    expect(screen.getByText(/DB:FINANCEIRO > Empenho/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Fluxo de empenho/ }).getAttribute('href')).toBe(
      '/tests/s1',
    );
    expect(screen.getByText('1366 × 768')).toBeTruthy();
    expect(screen.getByText('3 versões')).toBeTruthy();
    expect(screen.getByText('1 versão')).toBeTruthy();
    // no render yet: placeholder instead of an image
    expect(screen.getAllByText('Sem imagem')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Editar Consulta Empenho' }).getAttribute('href')).toBe(
      '/prototypes/p1',
    );
  });

  it('shows a thumbnail when there is one', async () => {
    list = [proto({ thumbnailUrl: '/api/prototypes/p1/thumbnail' })];
    renderPage();
    const img = await screen.findByAltText('Miniatura de Consulta Empenho');
    expect(img.getAttribute('src')).toMatch(/^\/api\/prototypes\/p1\/thumbnail\?v=\d+/);
  });

  it('explains how prototypes are captured when empty', async () => {
    list = [];
    renderPage();
    expect(await screen.findByText('Nenhum protótipo ainda')).toBeTruthy();
    expect(screen.getByText(/botão “Protótipo”/)).toBeTruthy();
  });

  it('filters by text and by session', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Consulta Empenho');
    await user.type(screen.getByLabelText('Buscar protótipos'), 'fornecedor');
    expect(screen.queryByText('Consulta Empenho')).toBeNull();
    expect(screen.getByText('Cadastro de Fornecedor')).toBeTruthy();
    await user.clear(screen.getByLabelText('Buscar protótipos'));
    await user.type(screen.getByLabelText('Buscar protótipos'), 'cad_fornecedor.php');
    expect(screen.getByText('Cadastro de Fornecedor')).toBeTruthy();
    await user.clear(screen.getByLabelText('Buscar protótipos'));

    await user.selectOptions(screen.getByLabelText('Filtrar por sessão de teste'), 's1');
    expect(screen.getByText('Consulta Empenho')).toBeTruthy();
    expect(screen.queryByText('Cadastro de Fornecedor')).toBeNull();

    await user.selectOptions(screen.getByLabelText('Filtrar por sessão de teste'), '__none__');
    expect(screen.queryByText('Consulta Empenho')).toBeNull();
    expect(screen.getByText('Cadastro de Fornecedor')).toBeTruthy();

    await user.type(screen.getByLabelText('Buscar protótipos'), 'zzz');
    expect(screen.getByText('Nenhum protótipo corresponde ao filtro.')).toBeTruthy();
  });

  it('deletes only after confirmation', async () => {
    const user = userEvent.setup();
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderPage();
    await screen.findByText('Consulta Empenho');
    await user.click(screen.getByRole('button', { name: 'Excluir Consulta Empenho' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Excluir Consulta Empenho' }));
    expect(confirm).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/prototypes/p1')).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('Consulta Empenho')).toBeNull());
  });

  it('renames through a dialog', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Consulta Empenho');
    await user.click(screen.getByRole('button', { name: 'Renomear Consulta Empenho' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Nome');
    await user.clear(input);
    await user.type(input, 'Empenho v2');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ name: 'Empenho v2' }),
    );
  });

  it('duplicates from the current snapshot', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Consulta Empenho');
    await user.click(screen.getByRole('button', { name: 'Duplicar Consulta Empenho' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      name: 'Consulta Empenho (cópia)',
      snapshot: { html: '<body><p>tela</p></body>', css: 'p{color:red}', width: 1280, height: 720 },
      sessionId: null,
    });
  });

  it('creates a blank prototype (1280×720) and opens it', async () => {
    const user = userEvent.setup();
    const { router } = renderPage();
    await screen.findByText('Consulta Empenho');
    await user.click(screen.getByRole('button', { name: /Novo protótipo/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Criar e abrir' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/nome/);
    await user.type(within(dialog).getByLabelText('Nome'), 'Minha tela');
    await user.click(within(dialog).getByRole('button', { name: 'Criar e abrir' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/prototypes/new1'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Minha tela',
      snapshot: { html: '<body></body>', css: '', width: 1280, height: 720 },
      sessionId: null,
    });
  });

  it('creates from pasted html, sanitized, with the chosen size and session', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Consulta Empenho');
    await user.click(screen.getByRole('button', { name: /Novo protótipo/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Nome'), 'Colada');
    await user.click(within(dialog).getByLabelText('Colar HTML'));
    await user.click(within(dialog).getByLabelText('HTML'));
    await user.paste('<div onclick="x()">oi</div><script>alert(1)</script>');
    await user.click(within(dialog).getByLabelText('CSS (opcional)'));
    await user.paste('div{color:red}');
    await user.clear(within(dialog).getByLabelText('Largura (px)'));
    await user.type(within(dialog).getByLabelText('Largura (px)'), '1024');
    await user.selectOptions(within(dialog).getByLabelText(/Teste vinculado/), 's2');
    await user.click(within(dialog).getByRole('button', { name: 'Criar e abrir' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Colada',
      snapshot: {
        html: '<body><div>oi</div></body>',
        css: 'div{color:red}',
        width: 1024,
        height: 720,
      },
      sessionId: 's2',
    });
  });

  describe('novo protótipo: pontos de partida', () => {
    const open = async () => {
      const user = userEvent.setup();
      const view = renderPage();
      await screen.findByText('Consulta Empenho');
      await user.click(screen.getByRole('button', { name: /Novo protótipo/ }));
      const dialog = await screen.findByRole('dialog');
      return { user, dialog, ...view };
    };
    const posts = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/prototypes');

    it('offers blank, the e-Cidade window, my templates and pasted HTML', async () => {
      const { dialog } = await open();
      const options = within(dialog)
        .getAllByRole('radio')
        .map((r) => r.parentElement!.textContent);
      expect(options).toEqual([
        'Em branco',
        'Tela de sistema — perfil e-Cidade',
        'Meus modelos',
        'Colar HTML',
      ]);
      expect((within(dialog).getByLabelText('Em branco') as HTMLInputElement).checked).toBe(true);
    });

    it('the e-Cidade window shows its preview and starts at 1366×768 (1920×1080 is offered)', async () => {
      const { user, dialog, router } = await open();
      await user.click(within(dialog).getByLabelText('Tela de sistema — perfil e-Cidade'));
      const preview = await within(dialog).findByAltText(
        'Prévia de Tela de sistema — perfil e-Cidade',
      );
      expect(preview.getAttribute('src')).toBe(
        '/api/prototypes/templates/builtin%3Aecidade-window/thumbnail',
      );
      expect((within(dialog).getByLabelText('Largura (px)') as HTMLInputElement).value).toBe(
        '1366',
      );
      expect((within(dialog).getByLabelText('Altura (px)') as HTMLInputElement).value).toBe('768');
      expect(
        within(dialog).getByRole('button', { name: '1366 × 768' }).getAttribute('aria-pressed'),
      ).toBe('true');
      await user.type(within(dialog).getByLabelText('Nome'), 'Nova rotina');
      await user.click(within(dialog).getByRole('button', { name: 'Criar e abrir' }));
      await waitFor(() => expect(router.state.location.pathname).toBe('/prototypes/new1'));
      expect(posts()[0]!.body).toEqual({
        name: 'Nova rotina',
        fromTemplateId: ECIDADE_WINDOW_TEMPLATE_ID,
        width: 1366,
        height: 768,
        sessionId: null,
      });
    });

    it('the e-Cidade window can be created at 1920×1080', async () => {
      const { user, dialog } = await open();
      await user.click(within(dialog).getByLabelText('Tela de sistema — perfil e-Cidade'));
      await user.click(within(dialog).getByRole('button', { name: '1920 × 1080' }));
      expect((within(dialog).getByLabelText('Largura (px)') as HTMLInputElement).value).toBe(
        '1920',
      );
      await user.type(within(dialog).getByLabelText('Nome'), 'Full HD');
      await user.click(within(dialog).getByRole('button', { name: 'Criar e abrir' }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]!.body).toMatchObject({
        fromTemplateId: ECIDADE_WINDOW_TEMPLATE_ID,
        width: 1920,
        height: 1080,
      });
    });

    it('my templates: a grid with thumbnails; the chosen one is copied at its own size', async () => {
      const { user, dialog } = await open();
      await user.click(within(dialog).getByLabelText('Meus modelos'));
      const group = await within(dialog).findByRole('radiogroup', { name: 'Meus modelos' });
      expect(within(group).getByAltText('Prévia de Modelo de consulta').getAttribute('src')).toBe(
        '/api/prototypes/t1/thumbnail?v=1',
      );
      expect((within(dialog).getByLabelText('Largura (px)') as HTMLInputElement).value).toBe(
        '1600',
      );
      await user.type(within(dialog).getByLabelText('Nome'), 'Da minha base');
      await user.click(within(dialog).getByRole('button', { name: 'Criar e abrir' }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]!.body).toEqual({
        name: 'Da minha base',
        fromTemplateId: 't1',
        width: 1600,
        height: 900,
        sessionId: null,
      });
    });

    it('without templates of my own, it says how to make one', async () => {
      templates = templates.filter((t) => t.builtin);
      const { user, dialog } = await open();
      await user.click(within(dialog).getByLabelText('Meus modelos'));
      expect(await within(dialog).findByText(/ainda não tem modelos/)).toBeTruthy();
      await user.type(within(dialog).getByLabelText('Nome'), 'X');
      await user.click(within(dialog).getByRole('button', { name: 'Criar e abrir' }));
      expect(within(dialog).getByRole('alert').textContent).toMatch(/Escolha um dos seus modelos/);
      expect(posts()).toHaveLength(0);
    });

    it('blank and pasted HTML still send a snapshot (no template)', async () => {
      const { user, dialog } = await open();
      await user.click(within(dialog).getByLabelText('Tela de sistema — perfil e-Cidade'));
      await user.click(within(dialog).getByLabelText('Em branco'));
      expect((within(dialog).getByLabelText('Largura (px)') as HTMLInputElement).value).toBe(
        '1280',
      );
      await user.type(within(dialog).getByLabelText('Nome'), 'Vazia');
      await user.click(within(dialog).getByRole('button', { name: 'Criar e abrir' }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]!.body).toHaveProperty('snapshot');
      expect(posts()[0]!.body).not.toHaveProperty('fromTemplateId');
    });
  });

  describe('aba Modelos', () => {
    const openTab = async () => {
      const user = userEvent.setup();
      const view = renderPage();
      await screen.findByText('Consulta Empenho');
      await user.click(screen.getByRole('tab', { name: 'Modelos' }));
      return { user, ...view };
    };

    it('shows the read-only built-in and my templates; the prototypes tab does not list templates', async () => {
      expect(screen.queryByText('Modelo de consulta')).toBeNull();
      const { user } = await openTab();
      expect(await screen.findByText('Tela de sistema — perfil e-Cidade')).toBeTruthy();
      expect(screen.getByText('Modelo de consulta')).toBeTruthy();
      expect(calls.some((c) => c.url === '/api/prototypes?kind=template')).toBe(true);
      // the built-in cannot be renamed or deleted; mine can
      expect(screen.queryByRole('button', { name: /Renomear Tela padrão/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Excluir Tela padrão/ })).toBeNull();
      expect(screen.getByRole('button', { name: 'Renomear Modelo de consulta' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Excluir Modelo de consulta' })).toBeTruthy();
      expect(screen.getByText('Padrão')).toBeTruthy();
      await user.click(screen.getByRole('tab', { name: 'Protótipos' }));
      expect(screen.queryByText('Modelo de consulta')).toBeNull();
    });

    it('"Usar este modelo" opens the new-prototype dialog with it chosen', async () => {
      const { user } = await openTab();
      await user.click(
        await screen.findByRole('button', {
          name: 'Usar modelo Tela de sistema — perfil e-Cidade',
        }),
      );
      const dialog = await screen.findByRole('dialog');
      expect(
        (within(dialog).getByLabelText('Tela de sistema — perfil e-Cidade') as HTMLInputElement)
          .checked,
      ).toBe(true);
      expect((within(dialog).getByLabelText('Largura (px)') as HTMLInputElement).value).toBe(
        '1366',
      );
      await user.click(screen.getByRole('button', { name: 'Cancelar' }));

      await user.click(screen.getByRole('button', { name: 'Usar modelo Modelo de consulta' }));
      const mine = await screen.findByRole('dialog');
      await waitFor(() =>
        expect(
          (within(mine).getByRole('radio', { name: 'Meus modelos' }) as HTMLInputElement).checked,
        ).toBe(true),
      );
      await waitFor(() =>
        expect(
          (within(mine).getByRole('radio', { name: /Modelo de consulta/ }) as HTMLInputElement)
            .checked,
        ).toBe(true),
      );
    });

    it('deletes one of my templates', async () => {
      const user = userEvent.setup();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderPage();
      await screen.findByText('Consulta Empenho');
      await user.click(screen.getByRole('tab', { name: 'Modelos' }));
      await user.click(await screen.findByRole('button', { name: 'Excluir Modelo de consulta' }));
      await waitFor(() =>
        expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/prototypes/t1')).toBe(
          true,
        ),
      );
      await waitFor(() => expect(screen.queryByText('Modelo de consulta')).toBeNull());
      expect(screen.getByText(/ainda não tem modelos próprios/)).toBeTruthy();
    });
  });
});
