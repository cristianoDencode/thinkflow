import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatStreamEvent } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notify } from '../../lib/notify';
import { ThemeProvider } from '../../lib/theme';
import { ChatPage } from './chat-page';

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

function renderPage(entry = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/', element: <ChatPage /> }], {
    initialEntries: [entry],
  });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('ChatPage', () => {
  let chatBodies: unknown[];
  let forkBodies: unknown[];
  let reportBodies: unknown[];
  /** Replaces the default streamed answer. */
  let chatEvents: ChatStreamEvent[] | null;
  /** Answer of POST /api/reports. */
  let reportAnswer: { status: number; body: unknown };

  const TEMPLATES = [
    { id: 'tpl-rel-1', name: 'Análise técnica', kind: 'report', description: 'Texto longo' },
    { id: 'tpl-rel-2', name: 'Relatório executivo', kind: 'report', description: 'Outro' },
    { id: 'tpl-prd-1', name: 'PRD completo', kind: 'prd', description: 'PRD' },
    { id: 'tpl-sum-1', name: 'Resumo executivo', kind: 'summary', description: 'Resumo' },
  ];

  beforeEach(() => {
    localStorage.clear();
    chatBodies = [];
    forkBodies = [];
    reportBodies = [];
    chatEvents = null;
    reportAnswer = {
      status: 201,
      body: { id: 'rep-9', title: 'Guia de juros', kind: 'report', status: 'queued' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/auth/status')
          return json({
            setupRequired: false,
            authenticated: true,
            user: { name: 'Cristiano Souza', title: 'Analista' },
          });
        if (url === '/api/models')
          return json([
            { id: 'thinkflow/default', label: 'thinkflow/default (combo)', kind: 'combo' },
            { id: 'groq/tiny', label: 'groq/tiny', kind: 'model', toolCalling: false },
          ]);
        if (url === '/api/libraries')
          return json([
            { id: 'lib-1', name: 'Regras do sistema', documentCount: 2, readyCount: 2 },
            { id: 'lib-2', name: 'Em fila', documentCount: 1, readyCount: 0 },
          ]);
        if (url === '/api/conversations/conv-lib')
          return json({
            id: 'conv-lib',
            mode: 'chat',
            model: 'thinkflow/default',
            libraryId: 'lib-1',
            parentConversationId: null,
            parentTitle: null,
            summary: null,
            agent: { cwd: null, permissionMode: null },
            messages: [
              { id: 'u1', role: 'user', content: 'qual o prazo?', createdAt: 1, meta: {} },
              {
                id: 'a1',
                role: 'assistant',
                content: 'Cinco dias úteis.',
                createdAt: 2,
                meta: { library: { id: 'lib-1', name: 'Regras do sistema' } },
              },
            ],
          });
        if (url.startsWith('/api/report-templates')) {
          const kind = new URL(url, 'http://x').searchParams.get('kind');
          return json(TEMPLATES.filter((t) => !kind || t.kind === kind));
        }
        if (url === '/api/reports' && init?.method === 'POST') {
          reportBodies.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify(reportAnswer.body), {
            status: reportAnswer.status,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.startsWith('/api/reports/rep-'))
          return json({
            id: url.split('/').at(-1),
            title: 'Guia de juros',
            kind: 'report',
            status: 'writing',
            progress: {
              phase: 'writing',
              current: 2,
              total: 4,
              label: 'Escrevendo… Tópico 2 de 4',
            },
            cancelRequested: false,
          });
        if (url === '/api/conversations/conv-preset')
          return json({
            id: 'conv-preset',
            mode: 'chat',
            model: 'thinkflow/default',
            libraryId: null,
            preset: { kind: 'report', templateId: 'tpl-rel-2' },
            parentConversationId: null,
            parentTitle: null,
            summary: null,
            agent: { cwd: null, permissionMode: null },
            messages: [
              { id: 'u1', role: 'user', content: 'quero um relatório', createdAt: 1, meta: {} },
              {
                id: 'a1',
                role: 'assistant',
                content: 'Qual o assunto?',
                createdAt: 2,
                meta: {},
              },
              {
                id: 'a2',
                role: 'assistant',
                content: 'Iniciei.',
                createdAt: 3,
                meta: { report: { id: 'rep-7', title: 'Guia de juros', kind: 'report' } },
              },
            ],
          });
        if (url === '/api/settings')
          return json({ aliases: {}, agentDefaultCwd: '/home', baseUrl: 'http://localhost:3737' });
        if (url === '/api/conversations') return json([]);
        if (url === '/api/conversations/conv-1')
          return json({
            id: 'conv-1',
            messages: [],
            summary: {
              text: 'Falamos sobre o PRD de login social.',
              kind: 'llm',
              throughMessageId: 'm0',
              updatedAt: Date.now(),
            },
          });
        if (url === '/api/conversations/conv-2')
          return json({
            id: 'conv-2',
            mode: 'chat',
            model: 'thinkflow/default',
            parentConversationId: 'conv-0',
            parentTitle: null,
            summary: {
              text: 'Resumo herdado da original.',
              kind: 'llm',
              throughMessageId: null,
              updatedAt: Date.now(),
            },
            agent: { cwd: null, permissionMode: null },
            messages: [
              {
                id: 'u1',
                role: 'user',
                content: 'pergunta antiga',
                createdAt: 1,
                meta: { carried: true },
              },
              {
                id: 'a1',
                role: 'assistant',
                content: 'resposta antiga',
                createdAt: 2,
                meta: { carried: true },
              },
            ],
          });
        if (url === '/api/conversations/conv-2/fork') {
          forkBodies.push(JSON.parse(String(init?.body)));
          return json({ id: 'conv-3' });
        }
        if (url === '/api/conversations/conv-3')
          return json({
            id: 'conv-3',
            mode: 'chat',
            model: 'thinkflow/default',
            parentConversationId: 'conv-2',
            parentTitle: 'Original',
            summary: null,
            agent: { cwd: null, permissionMode: null },
            messages: [],
          });
        if (url === '/api/chat') {
          chatBodies.push(JSON.parse(String(init?.body)));
          if (chatEvents)
            return new Response(sseBody(chatEvents), {
              headers: { 'content-type': 'text/event-stream' },
            });
          return new Response(
            sseBody([
              { type: 'conversation', conversationId: 'conv-1', title: 'Teste' },
              {
                type: 'context',
                keptMessages: 2,
                omittedMessages: 4,
                summarized: true,
                estimatedTokens: 1200,
                budgetTokens: 16000,
              },
              { type: 'step', step: 'analyze', status: 'active' },
              { type: 'step', step: 'analyze', status: 'done' },
              { type: 'step', step: 'compose', status: 'active' },
              { type: 'delta', text: 'Resposta **gerada**' },
              { type: 'step', step: 'search', status: 'skipped' },
              { type: 'step', step: 'compose', status: 'done' },
              { type: 'done', messageId: 'm1', providerId: 'groq', model: 'llama' },
            ]),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return json({});
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('greets the user and shows the four suggestion cards', async () => {
    renderPage();
    expect(await screen.findByText('Cristiano')).toBeInTheDocument();
    expect(screen.getByText('Como posso te ajudar hoje?')).toBeInTheDocument();
    for (const title of [
      'Resumir um',
      'Criar um PRD',
      'Gerar um relatório',
      'Criar um protótipo',
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  it('fills the prompt from a suggestion and streams an answer', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Cristiano');
    await waitFor(() => expect(screen.getByLabelText('Modelo')).toHaveValue('thinkflow/default'));

    await user.click(screen.getByText('Criar um PRD'));
    const textarea = screen.getByLabelText('Pergunta');
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('Quero um PRD para '));
    await user.type(textarea, 'login social');
    await user.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByText('gerada')).toBeInTheDocument();
    expect(screen.getByText('Raciocínio concluído')).toBeInTheDocument();
    expect(chatBodies[0]).toMatchObject({ model: 'thinkflow/default', mode: 'chat', useMcp: true });
    expect((chatBodies[0] as { content: string }).content).toContain('login social');
    expect(chatBodies[0]).toMatchObject({ preset: { kind: 'prd', templateId: 'tpl-prd-1' } });
  });

  it('tells when old messages were summarized and shows the rolling summary', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Cristiano');
    await waitFor(() => expect(screen.getByLabelText('Modelo')).toHaveValue('thinkflow/default'));
    await user.type(screen.getByLabelText('Pergunta'), 'continue');
    await user.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(
      await screen.findByText('Mensagens antigas resumidas para caber no contexto'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Resumo das mensagens anteriores')).toBeInTheDocument();
    expect(screen.getByText('Falamos sobre o PRD de login social.')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Detalhes da resposta'));
    expect(
      screen.getByText(/Contexto: 2 msgs \+ resumo de 4 · ~1[.,]200\/16[.,]000 tokens/),
    ).toBeInTheDocument();
  });

  it('shows where a derived conversation came from and derives again from an answer', async () => {
    const user = userEvent.setup();
    renderPage('/?c=conv-2');
    expect(await screen.findByText(/Derivada de/)).toBeInTheDocument();
    expect(screen.getByText('«conversa excluída»')).toBeInTheDocument();
    expect(screen.queryByText('Abrir original')).not.toBeInTheDocument();
    expect(screen.getByText('Resumo herdado da original.')).toBeInTheDocument();
    expect(screen.getAllByText('trazida da conversa original')).toHaveLength(2);

    await user.click(screen.getByLabelText('Derivar conversa a partir desta resposta'));
    await waitFor(() => expect(forkBodies).toEqual([{ messageId: 'a1' }]));
    expect(await screen.findByText('«Original»')).toBeInTheDocument();
    expect(screen.getByText('Abrir original')).toBeInTheDocument();
  });

  describe('document modes', () => {
    const openReportMode = async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Cristiano');
      await waitFor(() => expect(screen.getByLabelText('Modelo')).toHaveValue('thinkflow/default'));
      await user.click(screen.getByText('Gerar um relatório'));
      return user;
    };

    it('turns a card into a mode: chip, template select by name next to Biblioteca, starter text', async () => {
      await openReportMode();
      const chip = await screen.findByRole('button', { name: 'Sair do modo Relatório' });
      expect(chip).toHaveTextContent('Modo: Relatório');
      const select = await screen.findByLabelText('Modelo de documento');
      await waitFor(() => expect(select).toHaveValue('tpl-rel-1'));
      expect(
        within(select)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Análise técnica', 'Relatório executivo']);
      expect(screen.queryByText('Texto longo')).not.toBeInTheDocument();
      // same toolbar row as the Biblioteca select
      expect(select.parentElement).toBe(
        screen.getByLabelText('Biblioteca').parentElement!.parentElement,
      );
      expect((screen.getByLabelText('Pergunta') as HTMLTextAreaElement).value).toBe(
        'Quero gerar um relatório sobre ',
      );
    });

    it('sends only {kind, templateId}, remembers the chosen template and clears the mode', async () => {
      const user = await openReportMode();
      const select = await screen.findByLabelText('Modelo de documento');
      await waitFor(() => expect(select).toHaveValue('tpl-rel-1'));
      await user.selectOptions(select, 'tpl-rel-2');
      expect(JSON.parse(localStorage.getItem('thinkflow-preset-last')!)).toEqual({
        report: 'tpl-rel-2',
      });
      await user.type(screen.getByLabelText('Pergunta'), 'juros');
      await user.click(screen.getByRole('button', { name: 'Enviar' }));
      await screen.findByText('gerada');
      expect(chatBodies[0]).toMatchObject({
        preset: { kind: 'report', templateId: 'tpl-rel-2' },
      });
      expect(JSON.stringify(chatBodies[0])).not.toContain('Texto longo');
      // the mode belongs to the conversation, not to the browser
      expect(localStorage.getItem('thinkflow-composer')).not.toContain('preset');

      await user.click(screen.getByRole('button', { name: 'Sair do modo Relatório' }));
      expect(screen.queryByLabelText('Modelo de documento')).not.toBeInTheDocument();
      await user.type(screen.getByLabelText('Pergunta'), 'outra');
      await user.click(screen.getByRole('button', { name: 'Enviar' }));
      await waitFor(() => expect(chatBodies).toHaveLength(2));
      expect(chatBodies[1]).toMatchObject({ preset: null });
    });

    it('uses the template remembered for that kind', async () => {
      localStorage.setItem('thinkflow-preset-last', JSON.stringify({ report: 'tpl-rel-2' }));
      await openReportMode();
      await waitFor(() =>
        expect(screen.getByLabelText('Modelo de documento')).toHaveValue('tpl-rel-2'),
      );
    });

    it('shows the progress card of a report event, with a link to the document', async () => {
      chatEvents = [
        { type: 'conversation', conversationId: 'conv-1', title: 'Teste' },
        {
          type: 'delta',
          text: 'Confirmado.<gerar_documento>{"variaveis":{"assunto":"x"}}</gerar_documento>',
        },
        { type: 'report', reportId: 'rep-1', title: 'Guia de juros', kind: 'report' },
        { type: 'done', messageId: 'm1', providerId: 'groq', model: 'llama' },
      ];
      const user = await openReportMode();
      await user.type(screen.getByLabelText('Pergunta'), 'juros');
      await user.click(screen.getByRole('button', { name: 'Enviar' }));

      const card = await screen.findByRole('region', { name: 'Relatório em geração' });
      expect(within(card).getByText('Guia de juros')).toBeInTheDocument();
      expect(await within(card).findByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
      expect(within(card).getByText('Escrevendo… Tópico 2 de 4')).toBeInTheDocument();
      expect(within(card).getByRole('link', { name: /Abrir/ })).toHaveAttribute(
        'href',
        '/reports/rep-1',
      );
      expect(within(card).getByRole('button', { name: /Cancelar/ })).toBeInTheDocument();
      // the directive is for the server only
      expect(screen.getByText('Confirmado.')).toBeInTheDocument();
      expect(screen.queryByText(/gerar_documento/)).not.toBeInTheDocument();
    });

    it('restores the mode and the card of a stored conversation', async () => {
      renderPage('/?c=conv-preset');
      await waitFor(() =>
        expect(screen.getByLabelText('Modelo de documento')).toHaveValue('tpl-rel-2'),
      );
      expect(screen.getByRole('button', { name: 'Sair do modo Relatório' })).toBeInTheDocument();
      expect(
        await screen.findByRole('region', { name: 'Relatório em geração' }),
      ).toBeInTheDocument();
    });

    it('"Gerar agora" needs a conversation, posts the ids and shows the card', async () => {
      const user = userEvent.setup();
      const success = vi.spyOn(notify, 'success');
      renderPage('/?c=conv-preset');
      const button = await screen.findByRole('button', { name: /Gerar agora/ });
      await waitFor(() => expect(button).toBeEnabled());
      await user.click(button);
      await waitFor(() => expect(reportBodies).toHaveLength(1));
      expect(reportBodies[0]).toEqual({
        templateId: 'tpl-rel-2',
        model: 'thinkflow/default',
        conversationId: 'conv-preset',
        libraryId: null,
      });
      expect(success).toHaveBeenCalledWith('Geração iniciada: Guia de juros');
      expect(await screen.findAllByRole('region', { name: 'Relatório em geração' })).toHaveLength(
        2,
      );
    });

    it('"Gerar agora" is disabled before the first message', async () => {
      await openReportMode();
      expect(await screen.findByRole('button', { name: /Gerar agora/ })).toBeDisabled();
    });

    it('"Gerar agora" warns what is still missing on a 422', async () => {
      const user = userEvent.setup();
      const warning = vi.spyOn(notify, 'warning');
      reportAnswer = {
        status: 422,
        body: {
          error: { code: 'report_missing_variables', message: 'Responda na conversa: Assunto.' },
        },
      };
      renderPage('/?c=conv-preset');
      const button = await screen.findByRole('button', { name: /Gerar agora/ });
      await waitFor(() => expect(button).toBeEnabled());
      await user.click(button);
      await waitFor(() => expect(warning).toHaveBeenCalledWith('Responda primeiro: Assunto'));
      expect(screen.getAllByRole('region', { name: 'Relatório em geração' })).toHaveLength(1);
    });

    it('hides the controls in agent mode with a hint and does not send the preset', async () => {
      const user = userEvent.setup();
      renderPage('/?c=conv-preset');
      await screen.findByLabelText('Modelo de documento');
      await user.click(screen.getByRole('radio', { name: /Agente/ }));
      expect(screen.queryByLabelText('Modelo de documento')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Gerar agora/ })).not.toBeInTheDocument();
      expect(screen.getByText('Modos de documento funcionam no modo Chat.')).toBeInTheDocument();
      await user.type(screen.getByLabelText('Pergunta'), 'oi');
      await user.click(screen.getByRole('button', { name: 'Enviar' }));
      await waitFor(() => expect(chatBodies).toHaveLength(1));
      expect(chatBodies[0]).not.toHaveProperty('preset');
    });

    it('warns when there are no templates of the kind and keeps a plain chat', async () => {
      const warning = vi.spyOn(notify, 'warning');
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Cristiano');
      await user.click(screen.getByText('Criar um protótipo'));
      await waitFor(() =>
        expect(warning).toHaveBeenCalledWith(
          'Não há modelos desse tipo. Crie um em Relatórios > Modelos.',
        ),
      );
      expect(screen.queryByLabelText('Modelo de documento')).not.toBeInTheDocument();
      expect((screen.getByLabelText('Pergunta') as HTMLTextAreaElement).value).toBe(
        'Quero um protótipo de ',
      );
    });
  });

  describe('library selector', () => {
    it('starts without a library and sends the chosen one', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Cristiano');
      const select = await screen.findByLabelText('Biblioteca');
      expect(select).toHaveValue('');
      expect(screen.getByRole('option', { name: 'Biblioteca: nenhuma' })).toBeInTheDocument();
      expect(
        await screen.findByRole('option', { name: 'Biblioteca: Em fila (processando…)' }),
      ).toBeInTheDocument();

      await user.selectOptions(select, 'lib-1');
      await user.type(screen.getByLabelText('Pergunta'), 'qual o prazo?');
      await user.click(screen.getByRole('button', { name: 'Enviar' }));
      await screen.findByText('gerada');
      expect(chatBodies[0]).toMatchObject({ mode: 'chat', libraryId: 'lib-1' });
    });

    it('sends libraryId null when none is chosen and does not remember it between visits', async () => {
      const user = userEvent.setup();
      localStorage.setItem('thinkflow-composer', JSON.stringify({ libraryId: 'lib-1' }));
      renderPage();
      await screen.findByText('Cristiano');
      expect(await screen.findByLabelText('Biblioteca')).toHaveValue('');
      await user.type(screen.getByLabelText('Pergunta'), 'oi');
      await user.click(screen.getByRole('button', { name: 'Enviar' }));
      await screen.findByText('gerada');
      expect(chatBodies[0]).toMatchObject({ libraryId: null });
    });

    it('restores the library of a stored conversation and shows it on the answer', async () => {
      renderPage('/?c=conv-lib');
      await waitFor(() => expect(screen.getByLabelText('Biblioteca')).toHaveValue('lib-1'));
      const answer = (await screen.findAllByRole('article')).at(-1)!;
      expect(within(answer).getByText('Biblioteca: Regras do sistema')).toBeInTheDocument();
    });

    it('is disabled in agent mode with a hint', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Cristiano');
      const select = await screen.findByLabelText('Biblioteca');
      expect(select).toBeEnabled();
      await user.click(screen.getByRole('radio', { name: /Agente/ }));
      expect(select).toBeDisabled();
      expect(select).toHaveAttribute('title', 'Disponível no modo Chat');
      expect(
        screen.getByText('A biblioteca está disponível apenas no modo Chat.'),
      ).toBeInTheDocument();

      await user.type(screen.getByLabelText('Pergunta'), 'oi');
      await user.click(screen.getByRole('button', { name: 'Enviar' }));
      await screen.findByText('gerada');
      expect(chatBodies[0]).toMatchObject({ mode: 'agent' });
      expect(chatBodies[0]).not.toHaveProperty('libraryId');
    });

    it('warns when the model may not support tools', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Cristiano');
      await waitFor(() => expect(screen.getByLabelText('Modelo')).toHaveValue('thinkflow/default'));
      await user.selectOptions(await screen.findByLabelText('Biblioteca'), 'lib-1');
      const hint =
        'Este modelo pode não suportar ferramentas; a biblioteca pode não ser consultada.';
      expect(screen.queryByText(hint)).not.toBeInTheDocument();
      await user.selectOptions(screen.getByLabelText('Modelo'), 'groq/tiny');
      expect(screen.getByText(hint)).toBeInTheDocument();
    });
  });
});
