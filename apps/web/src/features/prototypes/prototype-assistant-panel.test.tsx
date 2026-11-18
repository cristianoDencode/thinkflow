import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PrototypeAssistantResultDto } from '@thinkflow/shared';
import type { PrototypeAssistantChange } from './prototype-assistant-panel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { PrototypeAssistantPanel } from './prototype-assistant-panel';
import {
  buildPreviewDoc,
  collapseSame,
  cssLines,
  htmlLines,
  isBlankHtml,
  lineDiff,
} from './prototype-assistant-helpers';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const BEFORE = {
  html: '<body><form><fieldset><legend>Dados</legend><input name="nome"></fieldset></form></body>',
  css: '.a{color:red}',
  width: 800,
  height: 600,
};

const result = (over: Partial<PrototypeAssistantResultDto> = {}): PrototypeAssistantResultDto => ({
  html: '<body><form><fieldset><legend>Dados</legend><input name="nome"><input name="cpf"></fieldset></form></body>',
  css: '.a{color:red}\n.b{color:blue}',
  explanation: 'Adicionei o campo CPF.',
  model: 'groq/llama',
  usage: { inputTokens: 120, outputTokens: 30 },
  warnings: [],
  ...over,
});

describe('PrototypeAssistantPanel', () => {
  let requests: { url: string; body: Record<string, unknown> }[];
  let answers: (PrototypeAssistantResultDto | Response)[];

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
        if (url === '/api/libraries') return json([{ id: 'l1', name: 'Manual', documentCount: 3 }]);
        if (url === '/api/mcp')
          return json([
            { id: 'm1', name: 'Mapeamento', enabled: true },
            { id: 'm2', name: 'Desligado', enabled: false },
          ]);
        if (url.endsWith('/assistant') && init?.method === 'POST') {
          requests.push({ url, body: JSON.parse(String(init.body)) });
          const next = answers.shift();
          return next instanceof Response ? next : json(next);
        }
        return json({}, 404);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderPanel(
    over: {
      snapshot?: typeof BEFORE;
      selection?: { html: string; path: number[] | string } | null;
      onApply?: (change: PrototypeAssistantChange) => void;
    } = {},
  ) {
    const onApply = over.onApply ?? vi.fn<(change: PrototypeAssistantChange) => void>();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <PrototypeAssistantPanel
            prototypeId="p1"
            getSnapshot={() => over.snapshot ?? BEFORE}
            getSelection={() => (over.selection === undefined ? null : over.selection)}
            onApply={onApply}
          />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    return onApply;
  }

  it('sends the free prompt with the snapshot, model and sources, and shows the preview', async () => {
    answers.push(result());
    renderPanel();
    await screen.findByRole('option', { name: 'groq/llama' });
    await userEvent.selectOptions(screen.getByLabelText('Modelo de IA'), 'groq/llama');
    await userEvent.click(screen.getByText('Fontes (opcional)'));
    await userEvent.click(await screen.findByLabelText('Mapeamento'));
    expect(screen.queryByLabelText('Desligado')).toBeNull();
    await userEvent.type(screen.getByLabelText('Pedido livre'), 'Adicione o CPF');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));

    await screen.findByText('Adicionei o campo CPF.');
    expect(requests[0]!.url).toBe('/api/prototypes/p1/assistant');
    expect(requests[0]!.body).toMatchObject({
      prompt: 'Adicione o CPF',
      action: 'custom',
      html: BEFORE.html,
      css: BEFORE.css,
      width: 800,
      height: 600,
      model: 'groq/llama',
      mcpServerIds: ['m1'],
      libraryIds: [],
    });
    expect(requests[0]!.body).not.toHaveProperty('selection');
    expect(screen.getByText(/groq\/llama · 120 tokens de entrada/)).toBeInTheDocument();

    // before/after previews are inert iframes
    for (const title of ['Antes', 'Depois']) {
      const frame = screen.getByTitle(title) as HTMLIFrameElement;
      expect(frame.getAttribute('sandbox')).toBe('');
      expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    }
    expect(screen.getByTitle('Depois').getAttribute('srcdoc')).toContain('name="cpf"');
    expect(screen.getByTitle('Antes').getAttribute('srcdoc')).not.toContain('name="cpf"');
  });

  it('shows the text diff on demand', async () => {
    answers.push(result());
    renderPanel();
    await userEvent.type(screen.getByLabelText('Pedido livre'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
    await screen.findByText('Adicionei o campo CPF.');
    await userEvent.click(screen.getByRole('tab', { name: 'Texto (diff)' }));
    const html = screen.getByTestId('diff-html');
    expect(html.querySelector('[data-diff="added"]')?.textContent).toContain('name="cpf"');
    expect(
      screen.getByTestId('diff-css').querySelector('[data-diff="added"]')?.textContent,
    ).toContain('.b{color:blue}');
  });

  it('applies only on click, passing html, css, prompt and explanation', async () => {
    answers.push(result());
    const onApply = renderPanel();
    await userEvent.type(screen.getByLabelText('Pedido livre'), 'Adicione o CPF');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
    await screen.findByText('Adicionei o campo CPF.');
    expect(onApply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(onApply).toHaveBeenCalledWith({
      html: result().html,
      css: result().css,
      prompt: 'Adicione o CPF',
      explanation: 'Adicionei o campo CPF.',
    });
    expect(screen.queryByTestId('assistant-result')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('aplicada');
  });

  it('discards without applying', async () => {
    answers.push(result());
    const onApply = renderPanel();
    await userEvent.type(screen.getByLabelText('Pedido livre'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
    await screen.findByText('Adicionei o campo CPF.');
    await userEvent.click(screen.getByRole('button', { name: /Descartar/ }));
    expect(screen.queryByTestId('assistant-result')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('scope "Componente selecionado" sends the selection; without one it explains instead of sending', async () => {
    answers.push(result());
    renderPanel({ selection: { html: '<fieldset></fieldset>', path: [0, 1] } });
    await userEvent.selectOptions(screen.getByLabelText('Escopo'), 'Componente selecionado');
    await userEvent.type(screen.getByLabelText('Pedido livre'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
    await screen.findByText('Adicionei o campo CPF.');
    expect(requests[0]!.body.selection).toEqual({ path: [0, 1], html: '<fieldset></fieldset>' });
    expect(screen.getByText(/Componente selecionado · Modelo/)).toBeInTheDocument();
  });

  it('does not send a component request when nothing is selected', async () => {
    renderPanel({ selection: null });
    await userEvent.selectOptions(screen.getByLabelText('Escopo'), 'Componente selecionado');
    expect(screen.getByText('Nenhum componente selecionado no editor.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Pedido livre'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Selecione um componente');
    expect(requests).toHaveLength(0);
  });

  it('quick actions: with input they ask for it first; without they send right away', async () => {
    answers.push(result(), result());
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Adicionar campo…' }));
    expect(requests).toHaveLength(0);
    const form = screen.getByRole('form', { name: 'Adicionar campo…' });
    await userEvent.type(within(form).getByLabelText('Nome do campo'), 'Data de vencimento');
    await userEvent.click(within(form).getByRole('button', { name: 'Enviar' }));
    await screen.findByText('Adicionei o campo CPF.');
    expect(requests[0]!.body.action).toBe('add_field');
    expect(String(requests[0]!.body.prompt)).toContain('"Data de vencimento"');

    await userEvent.click(screen.getByRole('button', { name: 'Reorganizar em duas colunas' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.body.action).toBe('two_columns');
    expect(String(requests[1]!.body.prompt)).toMatch(/duas colunas/);
  });

  it('hints "Gerar a partir da descrição" when the prototype is blank', async () => {
    renderPanel({ snapshot: { ...BEFORE, html: '<body></body>' } });
    expect(screen.getByTestId('blank-hint')).toBeInTheDocument();
  });

  it('shows warnings and the server error (e.g. 413)', async () => {
    answers.push(
      result({ warnings: ['A IA mudou cerca de 70% da tela.'] }),
      json(
        { error: { code: 'prototype_assistant_too_large', message: 'A tela é grande demais.' } },
        413,
      ),
    );
    renderPanel();
    await userEvent.type(screen.getByLabelText('Pedido livre'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
    await screen.findByText('A IA mudou cerca de 70% da tela.');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar pedido' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A tela é grande demais.');
  });
});

describe('prototype assistant helpers', () => {
  it('detects a blank body', () => {
    expect(isBlankHtml('<body></body>')).toBe(true);
    expect(isBlankHtml('<body style="x"> <style>a{}</style> </body>')).toBe(true);
    expect(isBlankHtml('<body><p>oi</p></body>')).toBe(false);
  });

  it('builds a scriptless preview document and neutralizes "<" in the CSS', () => {
    const doc = buildPreviewDoc(
      '<body><p>oi</p></body>',
      'a::after{content:"</style><script>x()</script>"}',
    );
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toContain('</style><script>');
  });

  it('diffs lines and collapses unchanged stretches', () => {
    const before = htmlLines('<div><p>a</p><p>b</p><p>c</p><p>d</p><p>e</p><p>f</p></div>');
    const after = htmlLines('<div><p>a</p><p>b</p><p>c</p><p>d</p><p>e</p><p>f</p><p>g</p></div>');
    const parts = lineDiff(before, after);
    const added = parts.filter((p) => p.kind === 'added').map((p) => p.text.trim());
    expect(added).toHaveLength(3);
    expect(added).toContain('g');
    expect(parts.some((p) => p.kind === 'removed')).toBe(false);
    expect(collapseSame(parts, 1).some((p) => p.text === '…')).toBe(true);
    expect(cssLines('.a{x:1} .b{y:2}')).toEqual(['.a{x:1}', '.b{y:2}']);
  });
});
