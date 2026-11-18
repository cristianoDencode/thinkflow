import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  ColumnRuleDto,
  DatabaseConnectionDto,
  DatabaseTestResultDto,
} from '@thinkflow/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabasesPage } from './databases-page';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function connection(overrides: Partial<DatabaseConnectionDto> = {}): DatabaseConnectionDto {
  return {
    id: 'db-1',
    name: 'Tributos',
    host: 'pg.local',
    port: 5432,
    database: 'tributos',
    user: 'leitor',
    passwordSet: true,
    sslMode: 'require',
    schemas: ['public'],
    aiAccess: 'masked',
    sampleRows: 20,
    sensitiveColumns: [],
    revealColumns: [],
    statementTimeoutSec: 30,
    maxRows: 1000,
    isDefault: true,
    metadataMcpServerId: null,
    metadataMcpProject: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DatabasesPage />
    </QueryClientProvider>,
  );
}

describe('DatabasesPage', () => {
  let list: DatabaseConnectionDto[];
  let calls: { method: string; url: string; body: Record<string, unknown> | null }[];
  let testResult: DatabaseTestResultDto;
  let rules: ColumnRuleDto[];
  let newRules: number;
  let dictionaryServers: { id: string; name: string }[];

  beforeEach(() => {
    dictionaryServers = [{ id: 'mcp-1', name: 'Mapeamento' }];
    list = [connection()];
    rules = [];
    newRules = 0;
    calls = [];
    testResult = {
      ok: true,
      message: 'ok',
      latencyMs: 12,
      serverVersion: 'PostgreSQL 17',
      currentUser: 'leitor',
      canWrite: false,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        calls.push({ method, url, body });
        if (url === '/api/databases' && method === 'GET') return json(list);
        if (url === '/api/databases' && method === 'POST') return json(connection(), 201);
        if (url === '/api/databases/metadata-mcp/servers') return json(dictionaryServers);
        if (url === '/api/databases/metadata-mcp/servers/mcp-1/projects')
          return json(['e-cidade', 'outro']);
        if (url.startsWith('/api/databases/metadata-mcp/')) return json([]);
        if (url === '/api/databases/db-1/test') return json(testResult);
        if (url === '/api/databases/db-1/ai-rules' && method === 'GET') return json(rules);
        if (url === '/api/databases/db-1/ai-rules' && method === 'PUT') {
          const saved: ColumnRuleDto = {
            id: `new-${++newRules}`,
            connectionId: 'db-1',
            schema: String(body?.schema),
            table: String(body?.table),
            column: String(body?.column),
            action: body?.action as ColumnRuleDto['action'],
            kind: null,
            origin: 'analyst',
            updatedAt: 1_700_000_000_000,
          };
          rules = [...rules.filter((r) => r.column !== saved.column), saved];
          return json(saved);
        }
        if (url.startsWith('/api/databases/db-1/ai-rules/') && method === 'DELETE') {
          rules = rules.filter((r) => !url.endsWith(`/${r.id}`));
          return json({ ok: true });
        }
        if (url.startsWith('/api/databases/')) return json(method === 'DELETE' ? {} : connection());
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists connections with address and badges', async () => {
    renderPage();
    expect(await screen.findByText('Tributos')).toBeInTheDocument();
    expect(screen.getByText('leitor@pg.local:5432/tributos')).toBeInTheDocument();
    expect(screen.getByText('Padrão')).toBeInTheDocument();
    expect(screen.getByText('SSL')).toBeInTheDocument();
    expect(screen.getByText('IA: amostra mascarada (20 linhas)')).toBeInTheDocument();
  });

  it('explains the feature and the read-only user when there are no connections', async () => {
    list = [];
    renderPage();
    expect(await screen.findByText('Nenhuma conexão Postgres')).toBeInTheDocument();
    expect(screen.getByText('Como criar um usuário somente leitura')).toBeInTheDocument();
    expect(screen.getByText(/GRANT SELECT ON ALL TABLES/)).toBeInTheDocument();
  });

  it('creates a connection with every field in the body', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Tributos');
    await user.click(screen.getByRole('button', { name: /Nova conexão/ }));
    const dialog = screen.getByRole('dialog');
    const field = (label: string) => within(dialog).getByLabelText(label);

    await user.type(field('Nome'), 'Arrecadação');
    await user.type(field('Host'), 'db.exemplo.com');
    await user.type(field('Banco de dados'), 'arrecadacao');
    await user.type(field('Usuário'), 'thinkflow_leitura');
    await user.type(field('Senha'), 's3gr3do');
    await user.selectOptions(field('SSL'), 'verify-full');
    await user.type(field('Schemas permitidos'), 'public, tributos');
    await user.click(within(dialog).getByRole('radio', { name: /Amostra mascarada/ }));
    await user.clear(field('Linhas de amostra por tabela'));
    await user.type(field('Linhas de amostra por tabela'), '5');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/api/databases',
      body: {
        name: 'Arrecadação',
        host: 'db.exemplo.com',
        port: 5432,
        database: 'arrecadacao',
        user: 'thinkflow_leitura',
        password: 's3gr3do',
        sslMode: 'verify-full',
        schemas: ['public', 'tributos'],
        aiAccess: 'masked',
        sampleRows: 5,
        statementTimeoutSec: 30,
        maxRows: 1000,
        isDefault: false,
        // no data dictionary chosen: catalog suggestions only
        metadataMcpServerId: null,
        metadataMcpProject: null,
      },
    });
  });

  describe('data dictionary (MCP)', () => {
    it('picks an MCP server that exposes field_search and one of its projects, and saves both', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Tributos');
      await user.click(screen.getByRole('button', { name: 'Editar Tributos' }));
      const dialog = screen.getByRole('dialog');
      expect(
        within(dialog).getByRole('region', { name: 'Dicionário de dados (MCP)' }),
      ).toBeInTheDocument();
      const server = within(dialog).getByLabelText('Servidor MCP');
      const project = within(dialog).getByLabelText('Projeto');
      expect(project).toBeDisabled();
      expect(await within(dialog).findByRole('option', { name: 'Mapeamento' })).toBeInTheDocument();

      await user.selectOptions(server, 'mcp-1');
      expect(project).toBeEnabled();
      await within(dialog).findByRole('option', { name: 'e-cidade' });
      await user.selectOptions(project, 'e-cidade');
      await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
      expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
        metadataMcpServerId: 'mcp-1',
        metadataMcpProject: 'e-cidade',
      });
      expect(
        calls.some((c) => c.url === '/api/databases/metadata-mcp/servers/mcp-1/projects'),
      ).toBe(true);
    });

    it('shows the saved choice and clears both fields when "Nenhum" is selected', async () => {
      list = [connection({ metadataMcpServerId: 'mcp-1', metadataMcpProject: 'e-cidade' })];
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Tributos');
      await user.click(screen.getByRole('button', { name: 'Editar Tributos' }));
      const dialog = screen.getByRole('dialog');
      await within(dialog).findByRole('option', { name: 'Mapeamento' });
      expect(within(dialog).getByLabelText('Servidor MCP')).toHaveValue('mcp-1');
      expect(within(dialog).getByLabelText('Projeto')).toHaveValue('e-cidade');

      await user.selectOptions(within(dialog).getByLabelText('Servidor MCP'), '');
      await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
      expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
        metadataMcpServerId: null,
        metadataMcpProject: null,
      });
    });

    it('explains when no MCP server exposes a dictionary', async () => {
      dictionaryServers = [];
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Tributos');
      await user.click(screen.getByRole('button', { name: 'Editar Tributos' }));
      expect(await screen.findByText(/Nenhum servidor MCP ativo expõe/)).toBeInTheDocument();
    });
  });

  it('does not send the legacy column lists (the rules replace them)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Tributos');
    await user.click(screen.getByRole('button', { name: 'Editar Tributos' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Sempre mascarar (colunas)')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')!.body!;
    expect(body).not.toHaveProperty('sensitiveColumns');
    expect(body).not.toHaveProperty('revealColumns');
  });

  it('a new connection explains that rules need it saved first', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Tributos');
    await user.click(screen.getByRole('button', { name: /Nova conexão/ }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(/Salve a conexão para gerenciar as regras/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'Regras de privacidade da IA' })).toBeNull();
  });

  describe('AI privacy rules', () => {
    const rule = (over: Partial<ColumnRuleDto> = {}): ColumnRuleDto => ({
      id: 'rule-1',
      connectionId: 'db-1',
      schema: 'public',
      table: 'cgm',
      column: 'z01_nome',
      action: 'tokenize',
      kind: 'NOME',
      origin: 'auto',
      updatedAt: 1_700_000_000_000,
      ...over,
    });

    async function openRules() {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Tributos');
      await user.click(screen.getByRole('button', { name: 'Editar Tributos' }));
      const dialog = screen.getByRole('dialog');
      const section = await within(dialog).findByRole('group', {
        name: 'Regras de privacidade da IA',
      });
      return { user, dialog, section };
    }

    it('lists the rules with action, origin and date', async () => {
      rules = [
        rule(),
        rule({
          id: 'rule-2',
          schema: '*',
          table: '*',
          column: 'cpf',
          action: 'omit',
          origin: 'analyst',
        }),
      ];
      const { section } = await openRules();
      expect(await within(section).findByText('public.cgm.z01_nome')).toBeInTheDocument();
      expect(within(section).getByText('*.*.cpf')).toBeInTheDocument();
      expect(within(section).getByText('Automática')).toBeInTheDocument();
      expect(within(section).getByText('Analista')).toBeInTheDocument();
      expect(within(section).getByLabelText('Ação para public.cgm.z01_nome')).toHaveValue(
        'tokenize',
      );
      expect(within(section).getByLabelText('Ação para *.*.cpf')).toHaveValue('omit');
    });

    it('says so when there are no rules', async () => {
      const { section } = await openRules();
      expect(await within(section).findByText(/Nenhuma regra ainda/)).toBeInTheDocument();
    });

    it('changes the action, removes and adds a rule without saving the connection', async () => {
      rules = [rule()];
      const { user, section } = await openRules();
      await user.selectOptions(
        await within(section).findByLabelText('Ação para public.cgm.z01_nome'),
        'reveal',
      );
      await waitFor(() =>
        expect(calls.find((c) => c.method === 'PUT' && c.url.endsWith('/ai-rules'))).toMatchObject({
          body: {
            schema: 'public',
            table: 'cgm',
            column: 'z01_nome',
            action: 'reveal',
            kind: null,
          },
        }),
      );
      await waitFor(() =>
        expect(within(section).getByLabelText('Ação para public.cgm.z01_nome')).toHaveValue(
          'reveal',
        ),
      );

      await user.selectOptions(within(section).getByLabelText('Ação da nova regra'), 'omit');
      await user.type(within(section).getByLabelText('Coluna da regra'), 'inscricao{Enter}'); // adds the rule, does not submit the dialog
      expect(await within(section).findByText('*.*.inscricao')).toBeInTheDocument();
      expect(
        calls.filter((c) => c.method === 'PUT' && c.url === '/api/databases/db-1'),
      ).toHaveLength(0);

      await user.click(
        within(section).getByRole('button', { name: 'Remover regra public.cgm.z01_nome' }),
      );
      await waitFor(() => expect(within(section).queryByText('public.cgm.z01_nome')).toBeNull());
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/ai-rules/new-1'))).toBe(
        true,
      );
    });
  });

  it('omits the password when editing with the field empty, and sends it when typed', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Tributos');
    await user.click(screen.getByRole('button', { name: 'Editar Tributos' }));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Host')).toHaveValue('pg.local');
    expect(within(dialog).getByText(/Deixe em branco para manter/)).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Nome'));
    await user.type(within(dialog).getByLabelText('Nome'), 'Tributos 2');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const first = calls.find((c) => c.method === 'PUT')!;
    expect(first.url).toBe('/api/databases/db-1');
    expect(first.body).toMatchObject({ name: 'Tributos 2', host: 'pg.local' });
    expect(first.body).not.toHaveProperty('password');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Editar Tributos' }));
    dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Senha'), 'nova');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PUT')[1]!.body).toMatchObject({ password: 'nova' });
  });

  it('shows the test result', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Tributos');
    await user.click(screen.getByRole('button', { name: 'Testar Tributos' }));
    expect(
      await screen.findByText('Conectado em 12 ms · PostgreSQL 17 · usuário leitor'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/pode alterar dados/)).toBeNull();
  });

  it('warns when the user can write', async () => {
    testResult = { ...testResult, canWrite: true };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Tributos');
    await user.click(screen.getByRole('button', { name: 'Testar Tributos' }));
    expect(
      await screen.findByText(/Este usuário pode alterar dados\. O Thinkflow só executa leitura/),
    ).toBeInTheDocument();
  });

  it('shows the failure message of a bad test', async () => {
    testResult = {
      ok: false,
      message: 'Senha incorreta para o usuário leitor',
      latencyMs: null,
      serverVersion: null,
      currentUser: null,
      canWrite: null,
    };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Tributos');
    await user.click(screen.getByRole('button', { name: 'Testar Tributos' }));
    expect(await screen.findByText('Senha incorreta para o usuário leitor')).toBeInTheDocument();
  });

  it('makes another connection the default', async () => {
    list = [connection(), connection({ id: 'db-2', name: 'Outro', isDefault: false })];
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Outro');
    await user.click(screen.getByRole('button', { name: 'Tornar Outro a conexão padrão' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        url: '/api/databases/db-2',
        body: { isDefault: true },
      }),
    );
  });

  it('deletes after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Tributos');
    await user.click(screen.getByRole('button', { name: 'Excluir Tributos' }));
    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'DELETE', url: '/api/databases/db-1', body: null }),
    );
  });

  it('does not delete when the confirmation is refused', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Tributos');
    await user.click(screen.getByRole('button', { name: 'Excluir Tributos' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
