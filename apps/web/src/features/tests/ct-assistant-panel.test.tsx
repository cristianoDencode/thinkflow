import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CtAssistantPatch, CtAssistantResultDto } from '@thinkflow/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { CtAssistantPanel, mergePatches } from './ct-assistant-panel';
import { wordDiff } from './ct-assistant-diff';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const doc = {
  title: 'Correcao do empenho',
  ticketId: 'CHAM-1',
  analysisTitle: 'Analise',
  context: 'O usuario nao consegue emitir.',
  useCases: [
    {
      title: 'Emissão',
      status: 'Finalizado',
      items: [
        { kind: 'text' as const, text: 'acessa menu financeiro' },
        {
          kind: 'image' as const,
          key: 'tests/s1/segredo.png',
          width: 10,
          height: 10,
          caption: 'CAPTION',
        },
        { kind: 'text' as const, text: 'verifica valor' },
      ],
    },
    { status: 'Finalizado', items: [{ kind: 'text' as const, text: 'outro' }] },
  ],
};

const result = (
  patch: CtAssistantPatch,
  over: Partial<CtAssistantResultDto> = {},
): CtAssistantResultDto => ({
  patch,
  explanation: 'Corrigi a escrita.',
  model: 'groq/llama',
  usage: { inputTokens: 120, outputTokens: 30 },
  warnings: [],
  ...over,
});

const FULL_PATCH: CtAssistantPatch = {
  title: 'Correção do empenho',
  context: 'O usuário não consegue emitir.',
  useCases: [{ index: 0, items: [{ index: 0, text: 'Acessa o menu: Financeiro > Empenho' }] }],
};

describe('CtAssistantPanel', () => {
  let requests: { url: string; body: Record<string, unknown> }[];
  let answers: (CtAssistantResultDto | Response)[];

  beforeEach(() => {
    requests = [];
    answers = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/models')
          return json([
            { id: 'auto', label: 'Auto', kind: 'combo' },
            { id: 'groq/llama', label: 'groq/llama', kind: 'model' },
          ]);
        if (url === '/api/libraries')
          return json([{ id: 'l1', name: 'Manual e-Cidade', documentCount: 3 }]);
        if (url === '/api/mcp')
          return json([
            { id: 'm1', name: 'Mapeamento', enabled: true },
            { id: 'm2', name: 'Desligado', enabled: false },
          ]);
        if (url.endsWith('/ct-assistant') && init?.method === 'POST') {
          requests.push({ url, body: JSON.parse(String(init.body)) });
          const next = answers.shift();
          return next instanceof Response ? next : json(next);
        }
        return json({}, 404);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderPanel(onApply = vi.fn()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <CtAssistantPanel sessionId="s1" document={doc} onApply={onApply} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    return onApply;
  }

  it('sends the action, scope and only the text of the document (images become a marker)', async () => {
    answers.push(result({}));
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Revisar escrita' }));
    await screen.findByText('A IA não sugeriu alterações.');
    expect(requests[0]!.url).toBe('/api/tests/sessions/s1/ct-assistant');
    const body = requests[0]!.body as { document: typeof doc } & Record<string, unknown>;
    expect(body).toMatchObject({
      action: 'review',
      scope: { kind: 'document' },
      libraryIds: [],
      mcpServerIds: [],
    });
    expect(body).not.toHaveProperty('model');
    expect(JSON.stringify(body)).not.toContain('segredo.png');
    expect(JSON.stringify(body)).not.toContain('CAPTION');
    expect(body.document.useCases[0]!.items[1]).toEqual({ kind: 'image' });
    expect(body.document).not.toHaveProperty('ticketId');
  });

  it('offers the four quick actions and maps them to the API actions', async () => {
    answers.push(result({}), result({}), result({}));
    renderPanel();
    for (const [label, action] of [
      ['Melhorar contexto', 'improve_context'],
      ['Descrever os casos de uso', 'describe_use_cases'],
      ['Sugerir título', 'suggest_title'],
    ] as const) {
      await userEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(requests.at(-1)?.body.action).toBe(action));
      await screen.findByText('A IA não sugeriu alterações.');
    }
  });

  it('sends the free prompt, the chosen scope, model and sources', async () => {
    answers.push(result({}));
    renderPanel();
    await screen.findByRole('option', { name: 'groq/llama' });
    await userEvent.selectOptions(screen.getByLabelText('Escopo'), 'Emissão');
    await userEvent.selectOptions(screen.getByLabelText('Modelo de IA'), 'groq/llama');
    await userEvent.click(screen.getByText(/Fontes \(opcional\)/));
    await userEvent.click(await screen.findByLabelText('Manual e-Cidade'));
    await userEvent.click(await screen.findByLabelText('Mapeamento'));
    expect(screen.queryByLabelText('Desligado')).toBeNull(); // disabled servers are not offered
    await userEvent.type(screen.getByLabelText('Pedido livre'), 'Deixe mais formal');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
    await screen.findByText('A IA não sugeriu alterações.');
    expect(requests[0]!.body).toMatchObject({
      action: 'custom',
      prompt: 'Deixe mais formal',
      scope: { kind: 'useCase', index: 0 },
      model: 'groq/llama',
      libraryIds: ['l1'],
      mcpServerIds: ['m1'],
    });
  });

  it('keeps the free request button disabled until there is a prompt', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Enviar pedido' })).toBeDisabled();
  });

  it('shows before/after per field with the changed words highlighted', async () => {
    answers.push(result(FULL_PATCH, { warnings: ['A IA tentou alterar o título'] }));
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Revisar escrita' }));
    const title = await screen.findByTestId('ct-change-title');
    expect(within(title).getByText('Título do documento')).toBeInTheDocument();
    expect(screen.getByTestId('ct-before-title')).toHaveTextContent('Correcao do empenho');
    expect(screen.getByTestId('ct-after-title')).toHaveTextContent('Correção do empenho');
    const removed = within(screen.getByTestId('ct-before-title')).getByText('Correcao');
    const added = within(screen.getByTestId('ct-after-title')).getByText('Correção');
    expect(removed).toHaveAttribute('data-diff', 'removed');
    expect(added).toHaveAttribute('data-diff', 'added');
    expect(screen.getByTestId('ct-before-uc:0:0')).toHaveTextContent('acessa menu financeiro');
    expect(screen.getByTestId('ct-after-uc:0:0')).toHaveTextContent(
      'Acessa o menu: Financeiro > Empenho',
    );
    expect(screen.getByText('Emissão — item 1')).toBeInTheDocument();
    expect(screen.getByText('Corrigi a escrita.')).toBeInTheDocument();
    expect(screen.getByText(/Modelo: groq/)).toBeInTheDocument();
    expect(screen.getByText('A IA tentou alterar o título')).toBeInTheDocument();
  });

  it('"Aplicar" applies only that field and marks it as applied', async () => {
    answers.push(result(FULL_PATCH));
    const onApply = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Revisar escrita' }));
    await screen.findByTestId('ct-change-context');
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar: 2.1 Contexto' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ context: 'O usuário não consegue emitir.' });
    const card = screen.getByTestId('ct-change-context');
    expect(within(card).getByText('Aplicado')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Aplicar/ })).toBeNull();
    expect(onApply).not.toHaveBeenCalledWith(expect.objectContaining({ title: expect.anything() }));
  });

  it('"Aplicar tudo" applies what is still pending in one patch', async () => {
    answers.push(result(FULL_PATCH));
    const onApply = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Revisar escrita' }));
    await screen.findByTestId('ct-change-title');
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar: Título do documento' }));
    onApply.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar tudo' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      context: 'O usuário não consegue emitir.',
      useCases: [{ index: 0, items: [{ index: 0, text: 'Acessa o menu: Financeiro > Empenho' }] }],
    });
    expect(screen.getByRole('button', { name: 'Aplicar tudo' })).toBeDisabled();
    expect(screen.getAllByText('Aplicado')).toHaveLength(3);
  });

  it('"Descartar" clears the suggestion without applying anything', async () => {
    answers.push(result(FULL_PATCH));
    const onApply = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Revisar escrita' }));
    await screen.findByTestId('ct-change-title');
    await userEvent.click(screen.getByRole('button', { name: /Descartar/ }));
    expect(screen.queryByTestId('ct-change-title')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('shows the server error message and keeps working', async () => {
    answers.push(
      json(
        {
          error: {
            code: 'ct_assistant_rate_limited',
            message: 'O provedor de IA está limitando as chamadas agora.',
          },
        },
        429,
      ),
    );
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Sugerir título' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('limitando as chamadas');
    expect(screen.getByRole('button', { name: 'Sugerir título' })).toBeEnabled();
  });
});

describe('helpers', () => {
  it('mergePatches groups items by use case', () => {
    expect(
      mergePatches([
        { useCases: [{ index: 0, items: [{ index: 0, text: 'a' }] }] },
        { title: 'T' },
        { useCases: [{ index: 0, items: [{ index: 2, text: 'b' }] }] },
      ]),
    ).toEqual({
      title: 'T',
      useCases: [
        {
          index: 0,
          items: [
            { index: 0, text: 'a' },
            { index: 2, text: 'b' },
          ],
        },
      ],
    });
  });

  it('wordDiff flags only the changed words and round-trips both texts', () => {
    const d = wordDiff('o usuario nao consegue', 'o usuário não consegue');
    expect(d.before.map((p) => p.text).join('')).toBe('o usuario nao consegue');
    expect(d.after.map((p) => p.text).join('')).toBe('o usuário não consegue');
    expect(d.after.filter((p) => p.kind === 'added').map((p) => p.text)).toEqual([
      'usuário',
      'não',
    ]);
    expect(wordDiff('igual', 'igual').after.every((p) => p.kind === 'same')).toBe(true);
    expect(wordDiff('', 'novo').after).toEqual([{ text: 'novo', kind: 'added' }]);
  });
});
