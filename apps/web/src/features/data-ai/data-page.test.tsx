import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatStreamEvent, QueryResultDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { DataPage } from './data-page';

function sseBody(events: ChatStreamEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      events.forEach((e) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`)));
      controller.close();
    },
  });
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const DATABASES = [
  { id: 'db-1', name: 'Homologação', isDefault: false },
  { id: 'db-2', name: 'Produção (leitura)', isDefault: true },
];

function result(overrides: Partial<QueryResultDto> = {}): QueryResultDto {
  return {
    id: 'q1',
    sql: 'select nome, valor from lancamentos',
    columns: [
      { name: 'nome', type: 'text' },
      { name: 'valor', type: 'numeric' },
    ],
    rows: [
      ['Ana', '100.50'],
      ['Bruno', '9'],
      ['Carla, "a"', null],
    ],
    rowCount: 3,
    truncated: false,
    durationMs: 42,
    source: 'direct',
    purpose: null,
    error: null,
    ...overrides,
  };
}

function bigResult(count: number): QueryResultDto {
  return result({
    columns: [
      { name: 'id', type: 'int4' },
      { name: 'nome', type: 'text' },
    ],
    // ids arrive as strings, in an order that is not the numeric one
    rows: Array.from({ length: count }, (_, i) => [String(count - i), `Pessoa ${i + 1}`]),
    rowCount: count,
    truncated: true,
  });
}

function renderPage(entry = '/dados') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/dados', element: <DataPage /> }], {
    initialEntries: [entry],
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

describe('DataPage', () => {
  let databases: typeof DATABASES;
  let chatBodies: Record<string, unknown>[];
  let queryBodies: { url: string; body: Record<string, unknown> }[];
  let chatEvents: ChatStreamEvent[];
  let rerunAnswer: QueryResultDto;
  let conversation: unknown;

  beforeEach(() => {
    localStorage.clear();
    databases = DATABASES;
    chatBodies = [];
    queryBodies = [];
    chatEvents = [];
    rerunAnswer = result({ rows: [['Zé', '1']], rowCount: 1 });
    conversation = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/databases') return json(databases);
        if (url === '/api/models')
          return json([
            { id: 'thinkflow/default', label: 'thinkflow/default (combo)', kind: 'combo' },
          ]);
        if (url === '/api/chat') {
          chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(sseBody(chatEvents), {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        if (/^\/api\/databases\/[^/]+\/query$/.test(url)) {
          queryBodies.push({
            url,
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          });
          return json(rerunAnswer);
        }
        if (url === '/api/conversations/conv-data' && conversation) return json(conversation);
        if (url.startsWith('/api/conversations')) return json([]);
        return json({});
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const textarea = () => screen.getByLabelText('Pergunta ou SQL');

  it('shows the empty state, preselects the default connection and fills the examples', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Dados com IA' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Conexão')).toHaveValue('db-2'));
    expect(screen.getByText(/Pergunte em português ou cole uma SQL/)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Encontre contribuintes duplicados pelo CPF' }),
    );
    expect(textarea()).toHaveValue('Encontre contribuintes duplicados pelo CPF');
    expect(screen.getByRole('link', { name: /Gerenciar conexões/ })).toHaveAttribute(
      'href',
      '/databases',
    );
  });

  it('offers to register a connection when there is none', async () => {
    databases = [];
    renderPage();
    expect(await screen.findByText('Nenhuma conexão cadastrada')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Cadastrar conexão/ })).toHaveAttribute(
      'href',
      '/databases',
    );
  });

  it('runs typed SQL directly with Ctrl+Enter and renders the result card', async () => {
    chatEvents = [
      { type: 'conversation', conversationId: 'conv-1', title: 'select' },
      { type: 'query_result', result: result() },
      { type: 'done', messageId: 'm1' },
    ];
    const user = userEvent.setup();
    const router = renderPage();
    await waitFor(() => expect(screen.getByLabelText('Conexão')).toHaveValue('db-2'));

    await user.type(textarea(), 'select nome, valor from lancamentos');
    expect(screen.getByText('Ctrl+Enter executa direto')).toBeInTheDocument();
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(chatBodies).toHaveLength(1));
    expect(chatBodies[0]).toMatchObject({
      mode: 'data',
      directSql: true,
      databaseId: 'db-2',
      content: 'select nome, valor from lancamentos',
    });

    const card = await screen.findByRole('region', { name: 'Resultado da consulta' });
    expect(within(card).getByText('Direta')).toBeInTheDocument();
    expect(within(card).getByText('3 linhas · 42 ms')).toBeInTheDocument();
    expect(within(card).getByText('Ana')).toBeInTheDocument();
    // null cells are shown as NULL
    expect(within(card).getByText('NULL')).toBeInTheDocument();
    // a typed query has no thinking panel
    expect(screen.queryByText(/Raciocínio concluído/)).toBeNull();
    await waitFor(() => expect(router.state.location.search).toBe('?c=conv-1'));
  });

  it('asks the AI with Enter and shows the card, the answer and the friendly tool labels', async () => {
    chatEvents = [
      { type: 'conversation', conversationId: 'conv-2', title: 'iptu' },
      { type: 'step', step: 'analyze', status: 'done' },
      {
        type: 'tool_call',
        id: 't1',
        name: 'descrever_tabela',
        input: { tabela: 'debitos_iptu' },
      },
      {
        type: 'tool_result',
        id: 't1',
        name: 'descrever_tabela',
        output: 'colunas…',
        isError: false,
      },
      {
        type: 'tool_call',
        id: 't2',
        name: 'executar_consulta',
        input: { sql: 'select count(*) from debitos_iptu', objetivo: 'Contar débitos' },
      },
      {
        type: 'tool_result',
        id: 't2',
        name: 'executar_consulta',
        output: '1 linha',
        isError: false,
      },
      {
        type: 'query_result',
        result: result({
          source: 'ai',
          purpose: 'Contar débitos',
          sql: 'select count(*) from debitos_iptu',
        }),
      },
      { type: 'delta', text: 'Há **3** registros.' },
      { type: 'done', messageId: 'm2', providerId: 'groq', model: 'llama' },
    ];
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Conexão')).toHaveValue('db-2'));
    await user.type(textarea(), 'Quantos débitos de IPTU existem?{Enter}');

    await waitFor(() => expect(chatBodies).toHaveLength(1));
    expect(chatBodies[0]).toMatchObject({
      mode: 'data',
      databaseId: 'db-2',
      model: 'thinkflow/default',
      useMcp: true,
    });
    expect(chatBodies[0]).not.toHaveProperty('directSql');

    const card = await screen.findByRole('region', { name: 'Resultado: Contar débitos' });
    expect(within(card).getByText('IA')).toBeInTheDocument();
    expect(await screen.findByText('registros.', { exact: false })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Raciocínio concluído/ }));
    expect(screen.getByText('Descreveu tabela debitos_iptu')).toBeInTheDocument();
    expect(screen.getByText('Executou consulta')).toBeInTheDocument();
    // the purpose shows in the card header and next to the tool call
    expect(screen.getAllByText('Contar débitos').length).toBeGreaterThanOrEqual(2);
  });

  it('runs the SQL of an answer through the same direct path as "Executar SQL"', async () => {
    const sql = 'select c.z01_nome from public.cgm c limit 5';
    chatEvents = [
      { type: 'conversation', conversationId: 'conv-3', title: 'nomes' },
      { type: 'delta', text: `Use:\n\n\`\`\`sql\n${sql}\n\`\`\`` },
      { type: 'sql_validation', blocks: [{ index: 0, status: 'ok', issues: [], reason: null }] },
      { type: 'done', messageId: 'm3', providerId: 'groq', model: 'llama' },
    ];
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Conexão')).toHaveValue('db-2'));
    await user.type(textarea(), 'Como listo os nomes?{Enter}');
    await waitFor(() => expect(chatBodies).toHaveLength(1));

    expect(await screen.findByText('Tabelas e campos conferidos')).toBeInTheDocument();
    chatEvents = [
      { type: 'query_result', result: result({ sql }) },
      { type: 'done', messageId: 'm4' },
    ];
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rodar SQL' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Rodar SQL' }));

    await waitFor(() => expect(chatBodies).toHaveLength(2));
    expect(chatBodies[1]).toMatchObject({
      mode: 'data',
      directSql: true,
      databaseId: 'db-2',
      content: sql,
      conversationId: 'conv-3',
    });
    expect(
      await screen.findByRole('region', { name: 'Resultado da consulta' }),
    ).toBeInTheDocument();
  });

  it('shows a failed query with its message and SQL', async () => {
    chatEvents = [
      {
        type: 'query_result',
        result: result({
          columns: [],
          rows: [],
          rowCount: 0,
          error: 'relação "xyz" não existe',
          sql: 'select * from xyz',
        }),
      },
      { type: 'done', messageId: 'm3' },
    ];
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Conexão')).toHaveValue('db-2'));
    await user.type(textarea(), 'select * from xyz');
    await user.click(screen.getByRole('button', { name: /Executar SQL/ }));
    const card = await screen.findByRole('region', { name: 'Resultado da consulta' });
    expect(within(card).getByText('A consulta falhou')).toBeInTheDocument();
    expect(within(card).getByText('relação "xyz" não existe')).toBeInTheDocument();
    expect(within(card).getByText('select * from xyz')).toBeInTheDocument();
  });

  it('sorts numerically, paginates and exports CSV', async () => {
    chatEvents = [
      { type: 'query_result', result: bigResult(120) },
      { type: 'done', messageId: 'm4' },
    ];
    const createObjectURL = vi.fn(() => 'blob:csv');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Conexão')).toHaveValue('db-2'));
    await user.type(textarea(), 'select id, nome from pessoas');
    await user.click(screen.getByRole('button', { name: /Executar SQL/ }));

    const card = await screen.findByRole('region', { name: 'Resultado da consulta' });
    expect(within(card).getByText(/120 linhas \(truncado em 120\)/)).toBeInTheDocument();
    expect(within(card).getByText('1–50 de 120')).toBeInTheDocument();
    const firstCell = () => within(card).getAllByRole('row')[1]!.querySelector('td')!.textContent;
    expect(firstCell()).toBe('120');

    // numeric-aware: "2" < "10" < "100"
    await user.click(within(card).getByRole('button', { name: 'Ordenar por id' }));
    expect(firstCell()).toBe('1');
    await user.click(within(card).getByRole('button', { name: 'Ordenar por id' }));
    expect(firstCell()).toBe('120');

    await user.click(within(card).getByRole('button', { name: 'Próxima página' }));
    expect(within(card).getByText('51–100 de 120')).toBeInTheDocument();
    expect(firstCell()).toBe('70');
    await user.click(within(card).getByRole('button', { name: 'Próxima página' }));
    expect(within(card).getByText('101–120 de 120')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Próxima página' })).toBeDisabled();

    await user.click(within(card).getByRole('button', { name: /Exportar CSV/ }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (createObjectURL.mock.calls as unknown as [Blob][])[0]![0];
    expect(blob.type).toContain('text/csv');
    expect(clicked[0]).toMatch(/^consulta-.*\.csv$/);
  });

  it('copies the table as TSV for Excel', async () => {
    chatEvents = [
      { type: 'query_result', result: result() },
      { type: 'done', messageId: 'm5' },
    ];
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Conexão')).toHaveValue('db-2'));
    await user.type(textarea(), 'select 1');
    await user.click(screen.getByRole('button', { name: /Executar SQL/ }));
    await user.click(await screen.findByRole('button', { name: /Copiar para Excel/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect((writeText.mock.calls as unknown as [string][])[0]![0]).toBe(
      'nome\tvalor\r\nAna\t100.50\r\nBruno\t9\r\nCarla, "a"\t\r\n',
    );
  });

  describe('reloaded conversation', () => {
    beforeEach(() => {
      conversation = {
        id: 'conv-data',
        mode: 'data',
        model: 'thinkflow/default',
        databaseId: 'db-1',
        libraryId: null,
        preset: null,
        parentConversationId: null,
        parentTitle: null,
        summary: null,
        agent: { cwd: null, permissionMode: null },
        messages: [
          { id: 'u1', role: 'user', content: 'Lançamentos do exercício', createdAt: 1, meta: {} },
          {
            id: 'a1',
            role: 'assistant',
            content: 'Encontrei lançamentos.',
            createdAt: 2,
            meta: {
              queryResults: [
                {
                  id: 'q9',
                  sql: 'select nome, valor from lancamentos',
                  columns: [
                    { name: 'nome', type: 'text' },
                    { name: 'valor', type: 'numeric' },
                  ],
                  rowCount: 1,
                  truncated: false,
                  durationMs: 7,
                  source: 'ai',
                  purpose: 'Listar lançamentos',
                  error: null,
                },
              ],
            },
          },
        ],
      };
    });

    it('restores the connection and runs the stored query again', async () => {
      const user = userEvent.setup();
      renderPage('/dados?c=conv-data');
      const card = await screen.findByRole('region', { name: 'Resultado: Listar lançamentos' });
      expect(
        within(card).getByText(/Os dados não ficam guardados no Thinkflow/),
      ).toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText('Conexão')).toHaveValue('db-1'));

      await user.click(within(card).getByRole('button', { name: /Executar de novo/ }));
      await waitFor(() => expect(queryBodies).toHaveLength(1));
      expect(queryBodies[0]).toEqual({
        url: '/api/databases/db-1/query',
        body: { sql: 'select nome, valor from lancamentos' },
      });
      expect(await within(card).findByText('Zé')).toBeInTheDocument();
      expect(within(card).queryByText(/Os dados não ficam guardados/)).toBeNull();
      // the purpose and source of the stored card survive the re-run
      expect(within(card).getByText('IA')).toBeInTheDocument();
    });
  });
});
