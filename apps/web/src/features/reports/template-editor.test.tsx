import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReportTemplateDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { json, template } from './fixtures';
import { TemplateEditorPage } from './template-editor-page';

function Where() {
  const loc = useLocation();
  return (
    <p data-testid="where">
      {loc.pathname}
      {loc.search}
    </p>
  );
}

function renderEditor(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/reports', element: <Where /> },
      { path: '/reports/templates/new', element: <TemplateEditorPage /> },
      { path: '/reports/templates/:id', element: <TemplateEditorPage /> },
    ],
    { initialEntries: [path] },
  );
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, method: string, url: string) {
  const call = fetchMock.mock.calls.find(
    ([u, i]) => u === url && (i as RequestInit | undefined)?.method === method,
  );
  return call
    ? (JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>)
    : null;
}

describe('TemplateEditorPage', () => {
  let stored: ReportTemplateDto;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stored = template();
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/mcp')
        return json([
          { id: 'm1', name: 'ecidade', transport: 'stdio', enabled: true, createdAt: 1 },
        ]);
      if (url === '/api/report-templates' && init?.method === 'POST')
        return json({ ...stored, id: 'new1' }, 201);
      if (url === '/api/report-templates/t1' && init?.method === 'PUT') return json(stored);
      if (url === '/api/report-templates/t1/duplicate' && init?.method === 'POST')
        return json({ ...stored, id: 'copy1', builtIn: false }, 201);
      if (url === '/api/report-templates/t1') return json(stored);
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('creates a new template: validates client-side, then POSTs the schema-shaped body', async () => {
    const user = userEvent.setup();
    renderEditor('/reports/templates/new');
    expect(screen.getByRole('heading', { name: 'Novo modelo' })).toBeTruthy();

    // empty name -> inline error and no request
    await user.click(screen.getAllByRole('button', { name: /Salvar modelo/ })[0]!);
    expect((await screen.findAllByText('Informe o nome do modelo')).length).toBe(2); // summary + field
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível salvar');
    expect(bodyOf(fetchMock, 'POST', '/api/report-templates')).toBeNull();

    await user.type(screen.getByLabelText('Nome do modelo'), 'Guia novo');
    await user.selectOptions(screen.getByLabelText('Tipo'), 'prd');
    await user.click(screen.getAllByRole('button', { name: /Salvar modelo/ })[0]!);
    await waitFor(() => expect(bodyOf(fetchMock, 'POST', '/api/report-templates')).not.toBeNull());
    expect(bodyOf(fetchMock, 'POST', '/api/report-templates')).toMatchObject({
      name: 'Guia novo',
      kind: 'prd',
      spec: { sections: [{ id: 'secao-1', title: 'Introdução' }], layout: { theme: 'thinkflow' } },
    });
    expect((await screen.findByTestId('where')).textContent).toBe('/reports?tab=modelos');
  });

  it('adds and reorders sections with the move buttons and saves them in the new order', async () => {
    const user = userEvent.setup();
    renderEditor('/reports/templates/t1');
    const first = (await screen.findByLabelText('Título da seção 1')) as HTMLInputElement;
    expect(first.value).toBe('Resumo');

    await user.click(screen.getByRole('button', { name: 'Adicionar seção' }));
    const third = screen.getByLabelText('Título da seção 3');
    await user.type(third, 'Conclusão');

    await user.click(screen.getByRole('button', { name: 'Mover seção 3 para cima' }));
    expect((screen.getByLabelText('Título da seção 2') as HTMLInputElement).value).toBe(
      'Conclusão',
    );
    expect((screen.getByLabelText('Título da seção 3') as HTMLInputElement).value).toBe('Detalhes');
    expect(
      (screen.getByRole('button', { name: 'Mover seção 1 para cima' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Mover seção 3 para baixo' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await user.click(screen.getAllByRole('button', { name: /Salvar modelo/ })[0]!);
    await waitFor(() =>
      expect(bodyOf(fetchMock, 'PUT', '/api/report-templates/t1')).not.toBeNull(),
    );
    const body = bodyOf(fetchMock, 'PUT', '/api/report-templates/t1') as {
      spec: { sections: { id: string; title: string }[] };
    };
    expect(body.spec.sections.map((s) => s.title)).toEqual(['Resumo', 'Conclusão', 'Detalhes']);
    expect(new Set(body.spec.sections.map((s) => s.id)).size).toBe(3);
  });

  it('never allows removing the last section', async () => {
    stored = template({}, { sections: [{ id: 's1', title: 'Única' }] });
    renderEditor('/reports/templates/t1');
    await screen.findByLabelText('Título da seção 1');
    expect(
      (screen.getByRole('button', { name: 'Remover seção 1' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('flags a {{variable}} used but not declared and can declare it', async () => {
    const user = userEvent.setup();
    renderEditor('/reports/templates/new');
    await user.type(screen.getByLabelText('Nome do modelo'), 'Com variável');
    await user.type(screen.getByLabelText('Papel (persona)'), 'Especialista em {{{{sistema}}');
    expect(screen.getByText(/ainda não declaradas/)).toBeTruthy();

    // saving without declaring is blocked with the schema's message
    await user.click(screen.getAllByRole('button', { name: /Salvar modelo/ })[0]!);
    expect(
      (await screen.findAllByText(/Variáveis usadas mas não declaradas/)).length,
    ).toBeGreaterThan(0);
    expect(bodyOf(fetchMock, 'POST', '/api/report-templates')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Declarar automaticamente' }));
    expect((screen.getByLabelText('Nome da variável 1') as HTMLInputElement).value).toBe('sistema');
    expect(screen.queryByText(/ainda não declaradas/)).toBeNull();

    await user.click(screen.getAllByRole('button', { name: /Salvar modelo/ })[0]!);
    await waitFor(() => expect(bodyOf(fetchMock, 'POST', '/api/report-templates')).not.toBeNull());
    expect(bodyOf(fetchMock, 'POST', '/api/report-templates')).toMatchObject({
      spec: { variables: [{ name: 'sistema', label: 'sistema' }] },
    });
  });

  it('validates variable names', async () => {
    const user = userEvent.setup();
    renderEditor('/reports/templates/t1');
    const name = await screen.findByLabelText('Nome da variável 1');
    await user.clear(name);
    await user.type(name, '1 inválido');
    await user.click(screen.getAllByRole('button', { name: /Salvar modelo/ })[0]!);
    expect((await screen.findAllByText(/Use letras, números e _/)).length).toBeGreaterThan(0);
    expect(bodyOf(fetchMock, 'PUT', '/api/report-templates/t1')).toBeNull();
  });

  it('warns that MCP research runs unattended and lists the servers', async () => {
    const user = userEvent.setup();
    renderEditor('/reports/templates/t1');
    await screen.findByLabelText('Título da seção 1');
    expect(screen.queryByRole('note')).toBeNull();

    await user.click(screen.getByRole('switch', { name: 'Pesquisar com ferramentas MCP' }));
    expect(screen.getByRole('note').textContent).toContain('sem acompanhamento');
    expect(screen.getByRole('note').textContent).toContain('sem pedir confirmação');
    const server = await screen.findByRole('checkbox', { name: 'ecidade' });
    await user.click(server);

    await user.click(screen.getAllByRole('button', { name: /Salvar modelo/ })[0]!);
    await waitFor(() =>
      expect(bodyOf(fetchMock, 'PUT', '/api/report-templates/t1')).not.toBeNull(),
    );
    expect(bodyOf(fetchMock, 'PUT', '/api/report-templates/t1')).toMatchObject({
      spec: { research: { useMcp: true, mcpServers: ['ecidade'] } },
    });
  });

  it('edits the visual identity and shows a cover preview', async () => {
    const user = userEvent.setup();
    renderEditor('/reports/templates/t1');
    await screen.findByLabelText('Título da seção 1');
    expect(screen.getByRole('img', { name: 'Pré-visualização das cores da capa' })).toBeTruthy();
    expect((screen.getByLabelText('Cor principal') as HTMLInputElement).value).toBe('#6d28d9');

    await user.selectOptions(screen.getByLabelText('Tema visual'), 'sobrio');
    const color = screen.getByLabelText('Cor principal');
    await user.clear(color);
    await user.type(color, '#112233');
    await user.click(screen.getAllByRole('button', { name: /Salvar modelo/ })[0]!);
    await waitFor(() =>
      expect(bodyOf(fetchMock, 'PUT', '/api/report-templates/t1')).not.toBeNull(),
    );
    expect(bodyOf(fetchMock, 'PUT', '/api/report-templates/t1')).toMatchObject({
      spec: { layout: { theme: 'sobrio', primaryColor: '#112233' } },
    });
  });

  it('shows built-in templates read-only with a "Duplicar para editar" action', async () => {
    const user = userEvent.setup();
    stored = template({ builtIn: true, builtInVersion: 1, name: 'PRD de funcionalidade' });
    renderEditor('/reports/templates/t1');
    expect(await screen.findByRole('heading', { name: 'PRD de funcionalidade' })).toBeTruthy();
    expect(screen.getByText(/somente leitura/)).toBeTruthy();
    expect(screen.getByLabelText('Nome do modelo').matches(':disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Adicionar seção' }).matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /Salvar modelo/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Duplicar para editar/ }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) =>
            u === '/api/report-templates/t1/duplicate' && (i as RequestInit).method === 'POST',
        ),
      ).toBe(true),
    );
  });

  it('shows a message when the template does not exist', async () => {
    renderEditor('/reports/templates/nope');
    expect(await screen.findByText('Modelo não encontrado')).toBeTruthy();
  });
});
