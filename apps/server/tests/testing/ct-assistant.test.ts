import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { CtAssistantResultDto } from '@thinkflow/shared';
import { NotFoundError } from '../../src/shared/kernel/errors';
import { registerErrorHandler } from '../../src/shared/interface/http/error-handler';
import { combineToolsets } from '../../src/contexts/chat/application/toolbox';
import { PrivacyFirewall } from '../../src/contexts/privacy/application/privacy-firewall';
import { restore } from '../../src/contexts/privacy/domain/tokenizer';
import { InMemoryVault, type Vault } from '../../src/contexts/privacy/domain/vault';
import type { VaultStore } from '../../src/contexts/privacy/domain/ports';
import type { RouteChatRequest } from '../../src/contexts/routing/application/route-chat-request';
import {
  CtAssistant,
  CT_ASSISTANT_MAX_TOOL_CALLS,
  type CtAssistantToolsPort,
} from '../../src/contexts/testing/application/ct-assistant';
import { CtAssistantToolsAdapter } from '../../src/contexts/testing/infrastructure/ct-assistant-tools';
import { registerCtAssistantRoutes } from '../../src/contexts/testing/interface/http/ct-assistant-routes';

/* ---------------------------------------------------------------- fake router ---- */

interface Reply {
  text?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  fail?: { reason: string; message: string };
}

interface Seen {
  body: Record<string, unknown>;
  options: { source: string; privacy?: { scope?: string } };
}

/** Plays `replies` in order; `seen` keeps every request exactly as the router would get it. */
function fakeRouter(replies: Reply[], transform?: (seen: Seen) => Promise<Seen> | Seen) {
  const seen: Seen[] = [];
  const router = {
    execute: async (request: { body: Record<string, unknown> }, options: Seen['options']) => {
      const entry = await (transform ?? ((s: Seen) => s))({ body: request.body, options });
      seen.push(entry);
      const reply = replies.shift() ?? { text: '{}' };
      if (reply.fail) return { ok: false, status: 502, attempts: [], ...reply.fail };
      const delta: Record<string, unknown> = {};
      if (reply.text !== undefined) delta.content = reply.text;
      if (reply.toolCalls)
        delta.tool_calls = reply.toolCalls.map((c, index) => ({
          index,
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.args },
        }));
      async function* events() {
        yield { choices: [{ index: 0, delta }] };
        yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } };
      }
      return {
        ok: true,
        stream: { format: 'openai', events: events() },
        providerId: 'fake',
        model: 'fake/model',
        finish: () => undefined,
      };
    },
  } as unknown as RouteChatRequest;
  return { router, seen };
}

const answer = (value: unknown): Reply => ({ text: JSON.stringify(value) });
const promptOf = (seen: Seen) => JSON.stringify(seen.body.messages);

/* ---------------------------------------------------------------- fixtures ---- */

const IMAGE_KEY = 'tests/s1/secret-key-123.png';
const CAPTION = 'Legenda-da-imagem-confidencial';

function documentInput() {
  return {
    title: 'Correcao do empenho',
    ticketId: 'CHAM-1',
    analysisTitle: 'Analise',
    context: 'O usuario nao consegue emitir o empenho.',
    useCases: [
      {
        title: 'Emissao',
        status: 'Finalizado',
        items: [
          { kind: 'text', text: 'acessa menu financeiro empenho' },
          { kind: 'image', key: IMAGE_KEY, width: 800, height: 600, caption: CAPTION },
          { kind: 'code', text: 'select * from empempenho' },
          { kind: 'text', text: 'verifica valor' },
        ],
      },
      {
        status: 'Finalizado',
        items: [{ kind: 'text', text: 'SEGUNDO-CASO-TEXTO' }],
      },
    ],
    versions: [{ version: '1.0', date: '', description: '', author: '' }],
  };
}

function makeAssistant(
  replies: Reply[],
  extra: Partial<ConstructorParameters<typeof CtAssistant>[0]> = {},
) {
  const { router, seen } = fakeRouter(replies);
  let n = 0;
  const forgotten: string[] = [];
  const assistant = new CtAssistant({
    router,
    ids: { next: () => `id${++n}` },
    assertSession: async (id) => {
      if (id !== 's1') throw new NotFoundError('Sessão');
    },
    forgetPrivacyScope: (scope) => void forgotten.push(scope),
    ...extra,
  });
  return { assistant, seen, forgotten };
}

const base = { action: 'review', scope: { kind: 'document' }, document: documentInput() };

/* ---------------------------------------------------------------- tests ---- */

describe('CtAssistant: patch', () => {
  it('returns a validated text patch (1-based answer -> 0-based patch) with usage and model', async () => {
    const { assistant } = makeAssistant([
      answer({
        explicacao: 'Corrigi a escrita.',
        titulo: 'Correção do empenho',
        contexto: 'O usuário não consegue emitir o empenho.',
        casos_de_uso: [
          { caso: 1, itens: [{ item: 1, texto: 'Acessa o menu: Financeiro > Empenho' }] },
        ],
      }),
    ]);
    const result = await assistant.assist('s1', base);
    expect(result.explanation).toBe('Corrigi a escrita.');
    expect(result.model).toBe('fake/model');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(result.patch).toEqual({
      title: 'Correção do empenho',
      context: 'O usuário não consegue emitir o empenho.',
      useCases: [{ index: 0, items: [{ index: 0, text: 'Acessa o menu: Financeiro > Empenho' }] }],
    });
  });

  it('drops no-op changes, empty texts and unknown items (with warnings)', async () => {
    const { assistant } = makeAssistant([
      answer({
        titulo: 'Correcao do empenho', // same as the current one
        casos_de_uso: [
          {
            caso: 1,
            itens: [
              { item: 1, texto: 'acessa menu financeiro empenho' }, // same
              { item: 4, texto: '   ' }, // empty
              { item: 9, texto: 'não existe' },
            ],
          },
        ],
      }),
    ]);
    const result = await assistant.assist('s1', base);
    expect(result.patch).toEqual({});
    expect(result.explanation).toMatch(/não sugeriu/i);
    expect(result.warnings.some((w) => /vazio/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /inexistente/.test(w))).toBe(true);
  });

  it('never lets the model touch an image, and only touches SQL on a free request', async () => {
    const changes = answer({
      casos_de_uso: [
        {
          caso: 1,
          itens: [
            { item: 2, texto: 'legenda inventada' }, // image
            { item: 3, texto: 'select 1' }, // code
          ],
        },
      ],
    });
    const review = await makeAssistant([changes]).assistant.assist('s1', base);
    expect(review.patch).toEqual({});
    expect(review.warnings.some((w) => /imagem/.test(w))).toBe(true);
    expect(review.warnings.some((w) => /SQL/.test(w))).toBe(true);

    const custom = await makeAssistant([changes]).assistant.assist('s1', {
      ...base,
      action: 'custom',
      prompt: 'Formate o SQL',
    });
    expect(custom.patch).toEqual({
      useCases: [{ index: 0, items: [{ index: 2, text: 'select 1' }] }],
    });
    expect(custom.warnings.some((w) => /imagem/.test(w))).toBe(true);
  });

  it('asks once more when the answer is not valid JSON, then gives a friendly error', async () => {
    const ok = makeAssistant([{ text: 'desculpe, aqui está' }, answer({ titulo: 'Novo título' })]);
    const result = await ok.assistant.assist('s1', { ...base, action: 'suggest_title' });
    expect(result.patch).toEqual({ title: 'Novo título' });
    expect(ok.seen).toHaveLength(2);
    expect(promptOf(ok.seen[1]!)).toContain('resposta anterior era inválida');
    // usage is the sum of both calls
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 });

    const bad = makeAssistant([{ text: 'nada' }, { text: 'nada de novo' }]);
    await expect(bad.assistant.assist('s1', base)).rejects.toMatchObject({
      code: 'ct_assistant_invalid_answer',
      httpStatus: 502,
    });
  });

  it('retries when the patch breaks the limits (title too long)', async () => {
    const { assistant, seen } = makeAssistant([
      answer({ titulo: 'x'.repeat(400) }),
      answer({ titulo: 'Curto' }),
    ]);
    const result = await assistant.assist('s1', { ...base, action: 'suggest_title' });
    expect(result.patch).toEqual({ title: 'Curto' });
    expect(promptOf(seen[1]!)).toMatch(/title/);
  });
});

describe('CtAssistant: what goes to the model', () => {
  it('sends text only: no image key, caption or size, just an anonymous marker', async () => {
    const { assistant, seen } = makeAssistant([answer({})]);
    await assistant.assist('s1', base);
    const prompt = promptOf(seen[0]!);
    expect(prompt).not.toContain(IMAGE_KEY);
    expect(prompt).not.toContain(CAPTION);
    expect(prompt).not.toContain('800');
    expect(prompt).toContain('captura de tela, não enviada');
    expect(prompt).toContain('acessa menu financeiro empenho');
    expect(JSON.stringify(seen[0]!.body)).not.toContain('image_url');
  });

  it('scope "Contexto": only the context is sent and only the context may change', async () => {
    const { assistant, seen } = makeAssistant([
      answer({
        contexto: 'Contexto novo.',
        titulo: 'Outro título',
        casos_de_uso: [{ caso: 2, itens: [{ item: 1, texto: 'alterado' }] }],
      }),
    ]);
    const result = await assistant.assist('s1', { ...base, scope: { kind: 'context' } });
    const prompt = promptOf(seen[0]!);
    expect(prompt).toContain('O usuario nao consegue emitir o empenho.');
    expect(prompt).not.toContain('SEGUNDO-CASO-TEXTO');
    expect(prompt).not.toContain('acessa menu financeiro empenho');
    expect(result.patch).toEqual({ context: 'Contexto novo.' });
    expect(result.warnings).toHaveLength(2);
  });

  it('scope "Caso de Uso 2": only that use case (plus read-only context); others are ignored', async () => {
    const { assistant, seen } = makeAssistant([
      answer({
        casos_de_uso: [
          { caso: 1, itens: [{ item: 1, texto: 'não pode' }] },
          { caso: 2, itens: [{ item: 1, texto: 'Ao consultar, podemos verificar que ok.' }] },
        ],
      }),
    ]);
    const result = await assistant.assist('s1', {
      ...base,
      action: 'describe_use_cases',
      scope: { kind: 'useCase', index: 1 },
    });
    const prompt = promptOf(seen[0]!);
    expect(prompt).toContain('SEGUNDO-CASO-TEXTO');
    expect(prompt).not.toContain('acessa menu financeiro empenho');
    expect(prompt).not.toContain('select * from empempenho');
    expect(prompt).toContain('somente leitura');
    expect(result.patch).toEqual({
      useCases: [
        { index: 1, items: [{ index: 0, text: 'Ao consultar, podemos verificar que ok.' }] },
      ],
    });
    expect(result.warnings).toHaveLength(1);
  });

  it('the action limits the fields: "Sugerir título" cannot rewrite the context', async () => {
    const { assistant } = makeAssistant([answer({ titulo: 'Título novo', contexto: 'xx' })]);
    const result = await assistant.assist('s1', { ...base, action: 'suggest_title' });
    expect(result.patch).toEqual({ title: 'Título novo' });
  });

  it('uses the team style in "Descrever os casos de uso" and passes the free prompt', async () => {
    const { assistant, seen } = makeAssistant([answer({}), answer({})]);
    await assistant.assist('s1', { ...base, action: 'describe_use_cases' });
    expect(promptOf(seen[0]!)).toContain('Após a correção, acessa o menu');
    expect(promptOf(seen[0]!)).toContain('Demanda aprovada!');
    await assistant.assist('s1', { ...base, action: 'custom', prompt: 'Traduza para inglês' });
    expect(promptOf(seen[1]!)).toContain('Traduza para inglês');
  });

  it('uses "auto" when no model is chosen, and the chosen one otherwise', async () => {
    const { assistant, seen } = makeAssistant([answer({}), answer({})]);
    await assistant.assist('s1', base);
    await assistant.assist('s1', { ...base, model: 'meu-combo' });
    expect(seen.map((s) => s.body.model)).toEqual(['auto', 'meu-combo']);
  });
});

describe('CtAssistant: validation and errors', () => {
  it('rejects bad requests with pt-BR messages', async () => {
    const { assistant, seen } = makeAssistant([]);
    await expect(assistant.assist('zzz', base)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assistant.assist('s1', { ...base, action: 'custom' })).rejects.toMatchObject({
      code: 'ct_assistant_prompt',
    });
    await expect(
      assistant.assist('s1', {
        ...base,
        action: 'improve_context',
        scope: { kind: 'useCase', index: 0 },
      }),
    ).rejects.toMatchObject({ code: 'ct_assistant_scope' });
    await expect(
      assistant.assist('s1', { ...base, scope: { kind: 'useCase', index: 7 } }),
    ).rejects.toMatchObject({ code: 'ct_assistant_scope' });
    await expect(assistant.assist('s1', { ...base, action: 'nope' })).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it('refuses a slice too large for the model instead of cutting it', async () => {
    const doc = documentInput();
    doc.useCases = Array.from({ length: 5 }, () => ({
      status: 'x',
      items: [{ kind: 'text', text: 'a'.repeat(19_000) }],
    }));
    const { assistant, seen } = makeAssistant([]);
    await expect(assistant.assist('s1', { ...base, document: doc })).rejects.toMatchObject({
      code: 'ct_assistant_too_large',
      httpStatus: 413,
    });
    expect(seen).toHaveLength(0);
  });

  it.each([
    ['rate_limited', 429, /limitando/],
    ['no_connection', 503, /Nenhuma conexão/],
    ['quota_exhausted', 429, /cota/i],
  ])('turns a router "%s" into a friendly error', async (reason, httpStatus, message) => {
    const { assistant } = makeAssistant([{ fail: { reason, message: 'raw upstream' } }]);
    const error = await assistant.assist('s1', base).catch((e: unknown) => e);
    expect(error).toMatchObject({ httpStatus, code: `ct_assistant_${reason}` });
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain('raw upstream');
  });
});

describe('CtAssistant: privacy firewall', () => {
  it('goes through the router with a private vault scope that is dropped afterwards', async () => {
    const { assistant, seen, forgotten } = makeAssistant([answer({})]);
    await assistant.assist('s1', base);
    const scope = seen[0]!.options.privacy?.scope;
    expect(scope).toMatch(/^ct-assistant:s1:/);
    expect(seen[0]!.options.source).toBe('ct-assistant');
    expect(forgotten).toEqual([scope]);
  });

  it('forgets the scope also when the call fails', async () => {
    const { assistant, forgotten } = makeAssistant([{ fail: { reason: 'auth', message: 'x' } }]);
    await expect(assistant.assist('s1', base)).rejects.toThrow();
    expect(forgotten).toHaveLength(1);
  });

  it('tokenizes the CPF before the provider and restores it in the patch', async () => {
    const CPF = '529.982.247-25';
    const stores = new Map<string, InMemoryVault>();
    const vaults: VaultStore = {
      forScope: (id): Vault => {
        const v = stores.get(id) ?? new InMemoryVault();
        stores.set(id, v);
        return v;
      },
      deleteScope: (id) => void stores.delete(id),
      copyScope: () => undefined,
    };
    const firewall = new PrivacyFirewall({
      vaults,
      settings: () => ({ enabled: true, presidioUrl: '', minScore: 0.5 }),
    });
    const sentToProvider: string[] = [];
    // mimics RouteChatRequest: protect -> provider -> restore what comes back
    const replies: Reply[] = [];
    const inner = fakeRouter(replies, async (entry) => entry);
    const router = {
      execute: async (
        request: { format: 'openai'; body: Record<string, unknown> },
        options: Seen['options'],
      ) => {
        const vault = firewall.vaultFor(options.privacy?.scope);
        const protectedRequest = await firewall.protect(request, vault);
        const text = JSON.stringify(protectedRequest.request.body);
        sentToProvider.push(text);
        const token = /\[CPF_\d+\]/.exec(text)?.[0] ?? 'SEM-TOKEN';
        replies.push(
          answer({ contexto: `O servidor com CPF ${token} não consegue emitir o empenho.` }),
        );
        const routed = (await inner.router.execute(request as never, options)) as {
          stream: { events: AsyncIterable<{ choices?: { delta?: { content?: string } }[] }> };
        };
        async function* restored() {
          for await (const ev of routed.stream.events) {
            const delta = ev.choices?.[0]?.delta;
            if (delta?.content) delta.content = restore(delta.content, vault);
            yield ev;
          }
        }
        return { ...routed, stream: { format: 'openai', events: restored() } };
      },
    } as unknown as RouteChatRequest;

    const assistant = new CtAssistant({
      router,
      ids: { next: () => 'r1' },
      assertSession: async () => undefined,
    });
    const doc = { ...documentInput(), context: `O servidor com CPF ${CPF} não consegue emitir.` };
    const result = await assistant.assist('s1', {
      ...base,
      scope: { kind: 'context' },
      document: doc,
    });
    expect(sentToProvider[0]).not.toContain(CPF);
    expect(sentToProvider[0]).toMatch(/\[CPF_\d+\]/);
    expect(result.patch.context).toBe(`O servidor com CPF ${CPF} não consegue emitir o empenho.`);
  });
});

describe('CtAssistant: sources (library / MCP tools)', () => {
  const lookupTool = (calls: unknown[]): CtAssistantToolsPort => ({
    open: async () => ({
      toolbox: combineToolsets({
        tools: [
          {
            alias: 'mcp__ecidade__tabela',
            description: 'Dicionário de dados',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        call: async (alias, args) => {
          calls.push([alias, args]);
          return { text: 'Tabela empempenho: empenhos', isError: false };
        },
      }),
      systemNote: '',
      warnings: ['Aviso de fonte'],
    }),
  });

  it('runs the tool loop: the model calls a tool, gets the result, then answers', async () => {
    const calls: unknown[] = [];
    const { assistant, seen } = makeAssistant(
      [
        { toolCalls: [{ id: 'c1', name: 'mcp__ecidade__tabela', args: '{"nome":"empenho"}' }] },
        answer({ contexto: 'Contexto usando a tabela empempenho.' }),
      ],
      { tools: lookupTool(calls) },
    );
    const result = await assistant.assist('s1', {
      ...base,
      scope: { kind: 'context' },
      mcpServerIds: ['m1'],
    });
    expect(calls).toEqual([['mcp__ecidade__tabela', { nome: 'empenho' }]]);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.body.tools).toHaveLength(1);
    expect(promptOf(seen[1]!)).toContain('Tabela empempenho: empenhos');
    expect(result.patch.context).toBe('Contexto usando a tabela empempenho.');
    expect(result.warnings).toContain('Aviso de fonte');
  });

  it('stops calling tools at the limit and asks for the final answer without tools', async () => {
    const calls: unknown[] = [];
    const looping: Reply[] = Array.from({ length: CT_ASSISTANT_MAX_TOOL_CALLS + 3 }, (_, i) => ({
      toolCalls: [{ id: `c${i}`, name: 'mcp__ecidade__tabela', args: '{}' }],
    }));
    const { assistant, seen } = makeAssistant([...looping.slice(0, 3), answer({ titulo: 'Fim' })], {
      tools: lookupTool(calls),
    });
    // 3 tool rounds, then the answer
    const result = await assistant.assist('s1', {
      ...base,
      action: 'suggest_title',
      mcpServerIds: ['m1'],
    });
    expect(result.patch).toEqual({ title: 'Fim' });
    expect(calls).toHaveLength(3);
    expect(seen).toHaveLength(4);

    // a model that never stops: the last round has no tools and the call count is capped
    const endless = makeAssistant(
      [...looping, answer({}), answer({}), answer({}), answer({}), answer({})],
      { tools: lookupTool([]) },
    );
    await endless.assistant.assist('s1', { ...base, mcpServerIds: ['m1'] }).catch(() => undefined);
    const last = endless.seen.at(-1)!;
    expect(endless.seen.length).toBeLessThanOrEqual(CT_ASSISTANT_MAX_TOOL_CALLS + 4);
    expect(last.body.tools).toBeUndefined();
  });

  it('goes on without sources when the model rejects tools', async () => {
    const { assistant, seen } = makeAssistant(
      [
        { fail: { reason: 'model_unavailable', message: 'no tools' } },
        answer({ titulo: 'Sem fonte' }),
      ],
      { tools: lookupTool([]) },
    );
    const result = await assistant.assist('s1', {
      ...base,
      action: 'suggest_title',
      mcpServerIds: ['m1'],
    });
    expect(result.patch).toEqual({ title: 'Sem fonte' });
    expect(result.warnings.some((w) => /não aceitou ferramentas/.test(w))).toBe(true);
    expect(seen[1]!.body.tools).toBeUndefined();
  });

  it('warns when sources were chosen but are not available', async () => {
    const { assistant } = makeAssistant([answer({})]);
    const result = await assistant.assist('s1', { ...base, libraryIds: ['l1'] });
    expect(result.warnings.some((w) => /fontes/.test(w))).toBe(true);
  });
});

describe('CtAssistantToolsAdapter', () => {
  const libraryTools = (name: string) => ({
    libraryId: name,
    libraryName: name,
    systemNote: `Use buscar_na_biblioteca para «${name}»`,
    tools: [{ name: 'buscar_na_biblioteca', description: name, parameters: { type: 'object' } }],
    call: async () => ({ text: `achado em ${name}`, isError: false }),
  });

  it('gives each library its own tool name and routes calls to the right one', async () => {
    const adapter = new CtAssistantToolsAdapter({
      library: { chatTools: async (id: string) => (id === 'gone' ? null : libraryTools(id)) },
      mcp: {
        list: async () => [],
        enabledToolset: async () => ({
          tools: [],
          errors: [],
          call: async () => ({ text: '', isError: false }),
        }),
      } as never,
    });
    const opened = await adapter.open({
      libraryIds: ['a', 'b', 'gone'],
      mcpServerIds: [],
      maxOutputChars: 1000,
    });
    const names = opened.toolbox!.defs.map((d) => d.function.name);
    expect(names).toEqual(['buscar_na_biblioteca', 'buscar_na_biblioteca_2']);
    expect((await opened.toolbox!.call('buscar_na_biblioteca_2', {})).text).toBe('achado em b');
    expect((await opened.toolbox!.call('buscar_na_biblioteca', {})).text).toBe('achado em a');
    expect(opened.systemNote).toContain('buscar_na_biblioteca_2');
    expect(opened.warnings).toHaveLength(1);
  });

  it('maps MCP server ids to enabled servers only and reports the others', async () => {
    const asked: unknown[] = [];
    const adapter = new CtAssistantToolsAdapter({
      library: { chatTools: async () => null },
      mcp: {
        list: async () => [
          { id: 'm1', name: 'e-Cidade', enabled: true },
          { id: 'm2', name: 'Off', enabled: false },
        ],
        enabledToolset: async (filter: unknown) => {
          asked.push(filter);
          return {
            tools: [
              { alias: 'mcp__e_cidade__x', description: 'x', inputSchema: { type: 'object' } },
            ],
            errors: [{ server: 'e-Cidade', message: 'fora do ar' }],
            call: async () => ({ text: 'ok', isError: false }),
          };
        },
      } as never,
    });
    const opened = await adapter.open({
      libraryIds: [],
      mcpServerIds: ['m1', 'm2', 'm3'],
      maxOutputChars: 1000,
    });
    expect(asked).toEqual([{ servers: ['e-Cidade'] }]);
    expect(opened.toolbox!.defs).toHaveLength(1);
    expect(opened.warnings.join(' ')).toMatch(/não existe mais.*desativado.*fora do ar/);
  });

  it('yields no toolbox when nothing usable is left', async () => {
    const adapter = new CtAssistantToolsAdapter({
      library: { chatTools: async () => null },
      mcp: { list: async () => [] } as never,
    });
    const opened = await adapter.open({
      libraryIds: ['x'],
      mcpServerIds: ['y'],
      maxOutputChars: 10,
    });
    expect(opened.toolbox).toBeNull();
  });
});

describe('POST /api/tests/sessions/:id/ct-assistant', () => {
  async function server(replies: Reply[]) {
    const app = Fastify();
    registerErrorHandler(app);
    const { assistant } = makeAssistant(replies);
    registerCtAssistantRoutes(app, { assistant, guard: async () => undefined });
    return app;
  }

  it('returns { patch, explanation, model, usage, warnings }', async () => {
    const app = await server([answer({ explicacao: 'ok', titulo: 'Novo título' })]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/tests/sessions/s1/ct-assistant',
      payload: { ...base, action: 'suggest_title' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CtAssistantResultDto>();
    expect(body).toEqual({
      patch: { title: 'Novo título' },
      explanation: 'ok',
      model: 'fake/model',
      usage: { inputTokens: 100, outputTokens: 20 },
      warnings: [],
    });
    await app.close();
  });

  it('answers 404 for an unknown session and 400 for a bad body', async () => {
    const app = await server([]);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/tests/sessions/nope/ct-assistant',
      payload: base,
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/tests/sessions/s1/ct-assistant',
      payload: { action: 'review' },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
