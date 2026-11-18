import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  buildQuickActionPrompt,
  PROTOTYPE_ASSISTANT_QUICK_ACTIONS,
  type PrototypeAssistantResultDto,
} from '@thinkflow/shared';
import { NotFoundError } from '../../src/shared/kernel/errors';
import { registerErrorHandler } from '../../src/shared/interface/http/error-handler';
import { combineToolsets } from '../../src/contexts/chat/application/toolbox';
import { PrivacyFirewall } from '../../src/contexts/privacy/application/privacy-firewall';
import { restore } from '../../src/contexts/privacy/domain/tokenizer';
import { InMemoryVault, type Vault } from '../../src/contexts/privacy/domain/vault';
import type { VaultStore } from '../../src/contexts/privacy/domain/ports';
import type { RouteChatRequest } from '../../src/contexts/routing/application/route-chat-request';
import {
  PrototypeAssistant,
  type PrototypeAssistantToolsPort,
} from '../../src/contexts/prototypes/application/prototype-assistant';
import { registerPrototypeAssistantRoutes } from '../../src/contexts/prototypes/interface/http/prototype-assistant-routes';
import {
  ImageVault,
  restoreImagesInCss,
  stripImagesFromCss,
  stripImagesFromTree,
  restoreImagesInTree,
  trimCss,
  vocabularyOf,
} from '../../src/contexts/prototypes/domain/prototype-assistant-compact';
import { parseHtml, serializeNodes } from '../../src/contexts/prototypes/domain/html-tree';
import {
  buildSystemPrompt,
  parseAnswer,
} from '../../src/contexts/prototypes/domain/prototype-assistant-prompt';
import { getSystemProfile } from '../../src/contexts/prototypes/domain/system-profiles';
import {
  locateSelection,
  parseScreen,
} from '../../src/contexts/prototypes/domain/prototype-assistant-selection';
import { changeRatio } from '../../src/contexts/prototypes/domain/prototype-assistant-validate';

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

function fakeRouter(replies: Reply[]) {
  const seen: Seen[] = [];
  const router = {
    execute: async (request: { body: Record<string, unknown> }, options: Seen['options']) => {
      seen.push({ body: request.body, options });
      const reply = replies.shift() ?? { text: '' };
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

const tagged = (html: string, css = '', explanation = 'Ajustei.'): Reply => ({
  text: `<ia-explicacao>${explanation}</ia-explicacao>\n<ia-html>${html}</ia-html>\n<ia-css>${css}</ia-css>`,
});
const promptOf = (seen: Seen) => JSON.stringify(seen.body.messages);

/* ---------------------------------------------------------------- fixtures ---- */

const IMG = `data:image/png;base64,${'iVBORw0KGgo'.repeat(40)}`;
const EXTERNAL = 'https://cdn.exemplo.com/logo.png';

const HTML =
  '<body style="margin:0"><div class="ec-window" id="w"><div class="ec-titlebar">Consulta</div>' +
  '<form class="ec-form"><fieldset id="fs1"><legend>Dados</legend><div class="ec-row">' +
  '<span class="ec-label">Nome:</span><input class="ec-input" name="nome"></div></fieldset>' +
  `<fieldset id="fs2"><legend>Outro</legend><img src="${IMG}"><p>texto B</p></fieldset></form></div></body>`;
const CSS =
  '.ec-window{border:1px solid #666}.ec-titlebar{background:#2c5d9d}.unused-rule{color:red}' +
  `@media print{.so-impressao{display:none}}.ec-input{background:url(${IMG})}`;

const base = { prompt: 'Adicione o campo CPF', html: HTML, css: CSS, width: 800, height: 600 };

function makeAssistant(
  replies: Reply[],
  extra: Partial<ConstructorParameters<typeof PrototypeAssistant>[0]> = {},
) {
  const { router, seen } = fakeRouter(replies);
  let n = 0;
  const forgotten: string[] = [];
  const assistant = new PrototypeAssistant({
    router,
    ids: { next: () => `id${++n}` },
    assertPrototype: async (id) => {
      if (id !== 'p1') throw new NotFoundError('Protótipo');
    },
    forgetPrivacyScope: (scope) => void forgotten.push(scope),
    ...extra,
  });
  return { assistant, seen, forgotten };
}

/* ---------------------------------------------------------------- domain ---- */

describe('compaction', () => {
  it('round-trips pictures of markup, inline styles and CSS through placeholders', () => {
    const vault = new ImageVault();
    const nodes = parseHtml(
      `<div style="background:url('${IMG}')"><img src="${IMG}"><td background="${IMG}"></td></div>`,
    );
    stripImagesFromTree(nodes, vault);
    const stripped = serializeNodes(nodes);
    expect(stripped).not.toContain('base64');
    expect(stripped).toContain('data-img="1"');
    expect(stripped).toContain('data-img-background="1"');
    expect(stripped).toContain('#img-1');
    expect(vault.size).toBe(1); // same picture, same number

    const { restored, unknown } = restoreImagesInTree(nodes, vault);
    expect(unknown).toBe(0);
    expect([...restored]).toEqual([1]);
    const back = serializeNodes(nodes);
    expect(back).toContain(`src="${IMG}"`);
    expect(back).toContain(`background="${IMG}"`);
    expect(back).toContain(IMG);

    const css = stripImagesFromCss(`a{background:url(${IMG})}`, vault);
    expect(css).toBe('a{background:url("#img-1")}');
    expect(restoreImagesInCss(css, vault)).toBe(`a{background:url("${IMG}")}`);
  });

  it('ignores placeholders the model invents', () => {
    const nodes = parseHtml('<img data-img="9">');
    const { unknown } = restoreImagesInTree(nodes, new ImageVault());
    expect(unknown).toBe(1);
    expect(serializeNodes(nodes)).toBe('<img>');
  });

  it('trims the CSS to the rules the markup can match', () => {
    const vocab = vocabularyOf(parseHtml('<div class="a b"><span id="x"></span></div>'));
    const css =
      '.a{x:1}.c{x:2}.a.c{x:3}div .b,.zzz{x:4}#x{x:5}#y{x:6}span:hover{x:7}table td{x:8}' +
      '@media print{.a{x:9}.c{x:10}}@media screen{.c{x:11}}@keyframes spin{from{x:0}}@font-face{font-family:F}';
    const out = trimCss(css, vocab);
    expect(out).toContain('.a{x:1}');
    expect(out).toContain('div .b{x:4}');
    expect(out).not.toContain('.zzz');
    expect(out).toContain('#x{x:5}');
    expect(out).toContain('span:hover{x:7}');
    expect(out).toContain('@media print{.a{x:9}}');
    expect(out).toContain('@font-face');
    for (const gone of ['.c{', '#y', 'table td', 'screen', 'keyframes'])
      expect(out).not.toContain(gone);
  });
});

describe('selection', () => {
  const body = parseScreen(HTML);

  it('finds by path, falling back to the markup when the path does not fit', () => {
    const byPath = locateSelection(body, { path: [0, 1, 1] });
    expect(byPath).not.toBe('body');
    expect(
      (byPath as { element: { attrs: { value: string | null }[] } }).element.attrs[0]!.value,
    ).toBe('fs2');
    expect(locateSelection(body, { path: '0/1/1' })).toMatchObject({
      breadcrumb: expect.stringContaining('form.ec-form'),
    });

    // wrong path, right markup
    const byHtml = locateSelection(body, {
      path: [5],
      html: '<fieldset id="fs1"><legend>Dados</legend></fieldset>',
    });
    expect(byHtml).toMatchObject({ element: { tag: 'fieldset' } });
    expect(locateSelection(body, { path: [] })).toBe('body');
    expect(locateSelection(body, { path: [7, 7] })).toBeNull();
  });
});

describe('answer parsing and change ratio', () => {
  it('reads the tagged sections and reports what is missing', () => {
    const ok = parseAnswer(
      '<ia-explicacao>x</ia-explicacao><ia-html>```html\n<p>a</p>\n```</ia-html><ia-css>p{x:1}</ia-css>',
    );
    expect(ok).toEqual({ ok: true, answer: { explanation: 'x', html: '<p>a</p>', css: 'p{x:1}' } });
    expect(parseAnswer('só texto')).toMatchObject({ ok: false });
    expect(parseAnswer('<ia-html><p>cortado')).toMatchObject({ ok: false });
  });

  it('measures how much changed', () => {
    const a = parseHtml('<div class="a"><p>um dois três</p></div>');
    expect(changeRatio(a, a)).toBe(0);
    expect(changeRatio(a, parseHtml('<table><tr><td>outro</td></tr></table>'))).toBe(1);
  });
});

describe('quick actions', () => {
  it('fill the template with the input and have a neutral text without it', () => {
    expect(buildQuickActionPrompt('add_field', 'Data de vencimento')).toContain(
      '"Data de vencimento"',
    );
    expect(buildQuickActionPrompt('grid_columns', 'Código, Nome')).toContain('Código, Nome');
    expect(buildQuickActionPrompt('add_field')).not.toContain('{valor}');
    expect(buildQuickActionPrompt('two_columns')).toMatch(/duas colunas/);
    expect(PROTOTYPE_ASSISTANT_QUICK_ACTIONS.map((q) => q.action)).toEqual([
      'add_field',
      'grid_columns',
      'two_columns',
      'labels',
      'generate',
    ]);
  });
});

/* ---------------------------------------------------------------- assistant ---- */

describe('PrototypeAssistant: whole screen', () => {
  it('sends a compacted screen (no base64, trimmed CSS) and restores the pictures', async () => {
    const { assistant, seen } = makeAssistant([
      tagged(
        '<body style="margin:0"><div class="ec-window"><form class="ec-form"><fieldset id="fs2"><legend>Outro</legend><img data-img="1"><p>texto B</p></fieldset><fieldset><div class="ec-row"><span class="ec-label">CPF:</span><input class="ec-input" name="cpf"></div></fieldset></form></div></body>',
        '.ec-cpf{width:90px}',
        'Adicionei o campo CPF.',
      ),
    ]);
    const result = await assistant.assist('p1', base);
    const sent = promptOf(seen[0]!);
    expect(sent).not.toContain('base64');
    expect(sent).toContain('data-img=');
    expect(sent).toContain('.ec-window{border:1px solid #666}');
    expect(sent).not.toContain('unused-rule');
    expect(sent).not.toContain('so-impressao');
    expect(sent).toContain('800x600');

    expect(result.explanation).toBe('Adicionei o campo CPF.');
    expect(result.model).toBe('fake/model');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(result.html).toContain(`src="${IMG}"`);
    expect(result.html).toContain('name="cpf"');
    // the existing CSS is kept in full (even the rules that were not sent) and the new one appended
    expect(result.css).toContain('.unused-rule{color:red}');
    expect(result.css).toContain(IMG);
    expect(result.css.endsWith('.ec-cpf{width:90px}')).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('strips scripts, handlers and NEW external addresses, keeps the ones already there', async () => {
    const html = `<body><div id="a"><img src="${EXTERNAL}"></div></body>`;
    const css = `.x{background:url(${EXTERNAL})}`;
    const { assistant } = makeAssistant([
      tagged(
        `<body><div id="a"><img src="${EXTERNAL}"><img src="https://evil.example/x.png" alt="e"><script>alert(1)</script><button onclick="x()">Ok</button><a href="javascript:alert(1)">l</a><iframe src="https://e.x"></iframe></div></body>`,
        '@import url(https://evil.example/a.css);.y{background:url(https://evil.example/b.png)}.z{color:red}',
      ),
    ]);
    const result = await assistant.assist('p1', { ...base, html, css, action: 'custom' });
    expect(result.html).toContain(EXTERNAL);
    expect(result.html).not.toMatch(/evil|script|onclick|javascript|iframe/i);
    expect(result.html).toContain('<button>Ok</button>');
    expect(result.css).not.toContain('evil');
    expect(result.css).toContain(`url(${EXTERNAL})`);
    expect(result.css).toContain('.z{color:red}');
    expect(result.warnings.join(' ')).toMatch(/scripts/);
    expect(result.warnings.join(' ')).toMatch(/manipuladores/);
    expect(result.warnings.join(' ')).toMatch(/endereços externos/);
  });

  it('warns when a local request rewrites most of the screen', async () => {
    const { assistant } = makeAssistant([
      tagged(
        '<body><table><tr><td>Totalmente outra tela com outras palavras</td></tr></table></body>',
      ),
    ]);
    const result = await assistant.assist('p1', { ...base, action: 'add_field' });
    expect(result.warnings.some((w) => /mudou cerca de \d+%/.test(w))).toBe(true);

    const layout = makeAssistant([
      tagged(
        '<body><table><tr><td>Totalmente outra tela com outras palavras</td></tr></table></body>',
      ),
    ]);
    const quiet = await layout.assistant.assist('p1', { ...base, action: 'two_columns' });
    expect(quiet.warnings.some((w) => /mudou cerca/.test(w))).toBe(false);
  });

  it('retries once on an invalid or empty answer, summing the usage', async () => {
    const ok = makeAssistant([{ text: 'desculpe' }, tagged('<body><p>Pronto</p></body>')]);
    const result = await ok.assistant.assist('p1', { ...base, action: 'generate' });
    expect(result.html).toBe('<body><p>Pronto</p></body>');
    expect(ok.seen).toHaveLength(2);
    expect(promptOf(ok.seen[1]!)).toContain('resposta anterior era inválida');
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 });

    const empty = makeAssistant([tagged('<body></body>'), tagged('<body><p>Agora sim</p></body>')]);
    const second = await empty.assistant.assist('p1', base);
    expect(second.html).toContain('Agora sim');
    expect(promptOf(empty.seen[1]!)).toMatch(/vazia/);

    const bad = makeAssistant([{ text: 'nada' }, { text: 'nada' }]);
    await expect(bad.assistant.assist('p1', base)).rejects.toMatchObject({
      code: 'prototype_assistant_invalid_answer',
      httpStatus: 502,
    });
  });

  it('generates a screen on a blank prototype and adds the e-Cidade base CSS once', async () => {
    const { assistant, seen } = makeAssistant([
      tagged(
        '<body><div class="ec-window"><div class="ec-titlebar">Fornecedor</div><div class="ec-content"><form class="ec-form"><fieldset><legend>Dados</legend><div class="ec-row"><span class="ec-label">CNPJ:</span><input class="ec-input" name="cnpj"></div></fieldset></form></div></div></body>',
      ),
    ]);
    const result = await assistant.assist('p1', {
      ...base,
      action: 'generate',
      prompt: buildQuickActionPrompt('generate', 'cadastro de fornecedor'),
      html: '<body></body>',
      css: '',
    });
    expect(promptOf(seen[0]!)).toContain('em branco');
    expect(promptOf(seen[0]!)).toContain('11 a 12px');
    expect(result.css).toContain('/* ec-base */');
    expect(result.css).toContain('.ec-titlebar');
    expect(result.css.match(/ec-base/g)).toHaveLength(1);
  });

  it('refuses a screen that is too large with a 413 that suggests selecting a component', async () => {
    const big = `<body>${'<p class="ec-row">linha de texto repetida para encher</p>'.repeat(1500)}</body>`;
    const { assistant, seen } = makeAssistant([]);
    const error = await assistant.assist('p1', { ...base, html: big }).catch((e: unknown) => e);
    expect(error).toMatchObject({ httpStatus: 413, code: 'prototype_assistant_too_large' });
    expect((error as Error).message).toMatch(/Selecione um componente/);
    expect(seen).toHaveLength(0);

    // the same screen is fine when only a small component is selected
    const withSmall = big.replace(
      '</body>',
      '<fieldset id="peq"><legend>Pequeno</legend></fieldset></body>',
    );
    const ok = makeAssistant([tagged('<fieldset id="peq"><legend>Novo</legend></fieldset>')]);
    const result = await ok.assistant.assist('p1', {
      ...base,
      html: withSmall,
      selection: { html: '<fieldset id="peq"><legend>Pequeno</legend></fieldset>' },
    });
    expect(result.html).toContain('<legend>Novo</legend>');
  });
});

describe('PrototypeAssistant: selected component', () => {
  it('sends only the component and splices the answer back, leaving the rest untouched', async () => {
    const { assistant, seen } = makeAssistant([
      tagged(
        '<fieldset id="fs2"><legend>Outro</legend><img data-img="1"><p>texto B</p><div class="ec-row"><span class="ec-label">Novo:</span><input class="ec-input" name="novo"></div></fieldset>',
        '.ec-novo{color:red}',
      ),
    ]);
    const result = await assistant.assist('p1', {
      ...base,
      selection: { path: [0, 1, 1], html: '<fieldset id="fs2"></fieldset>' },
    });
    const sent = promptOf(seen[0]!);
    expect(sent).toContain('<componente>');
    expect(sent).toContain('texto B');
    expect(sent).not.toContain('name="nome"');
    expect(sent).not.toContain('base64');
    expect(sent).toContain('form.ec-form');

    expect(result.html.startsWith('<body style="margin:0">')).toBe(true);
    expect(result.html).toContain('<span class="ec-label">Nome:</span>'); // untouched sibling
    expect(result.html).toContain('name="novo"');
    expect(result.html).toContain(`src="${IMG}"`);
    expect(result.html.indexOf('Nome:')).toBeLessThan(result.html.indexOf('Novo:'));
    expect(result.css).toContain('.unused-rule');
    expect(result.css).toContain('.ec-novo{color:red}');
  });

  it('accepts a model answer wrapped in <body> and answers 400 for an unknown component', async () => {
    const { assistant } = makeAssistant([
      tagged('<body><fieldset id="fs1"><legend>X</legend></fieldset></body>'),
    ]);
    const result = await assistant.assist('p1', {
      ...base,
      selection: { html: '<fieldset id="fs1"></fieldset>' },
    });
    expect(result.html).toContain('<legend>X</legend>');
    expect(result.html).toContain('id="fs2"');

    const missing = makeAssistant([]);
    await expect(
      missing.assistant.assist('p1', { ...base, selection: { path: [9, 9] } }),
    ).rejects.toMatchObject({ code: 'prototype_assistant_selection', httpStatus: 400 });
    expect(missing.seen).toHaveLength(0);
  });
});

describe('PrototypeAssistant: validation and errors', () => {
  it('rejects bad requests before calling the model', async () => {
    const { assistant, seen } = makeAssistant([]);
    await expect(assistant.assist('zzz', base)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assistant.assist('p1', { ...base, prompt: '  ' })).rejects.toThrow();
    await expect(assistant.assist('p1', { ...base, action: 'nope' })).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it('uses "auto" by default and the chosen model otherwise', async () => {
    const { assistant, seen } = makeAssistant([
      tagged('<body><p>a</p></body>'),
      tagged('<body><p>b</p></body>'),
    ]);
    await assistant.assist('p1', base);
    await assistant.assist('p1', { ...base, model: 'meu-combo' });
    expect(seen.map((s) => s.body.model)).toEqual(['auto', 'meu-combo']);
  });

  it.each([
    ['rate_limited', 429, /limitando/],
    ['no_connection', 503, /Nenhuma conexão/],
  ])('turns a router "%s" into a friendly error', async (reason, httpStatus, message) => {
    const { assistant } = makeAssistant([{ fail: { reason, message: 'raw upstream' } }]);
    const error = await assistant.assist('p1', base).catch((e: unknown) => e);
    expect(error).toMatchObject({ httpStatus, code: `prototype_assistant_${reason}` });
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain('raw upstream');
  });
});

describe('PrototypeAssistant: privacy firewall', () => {
  it('goes through the router with a private vault scope that is dropped afterwards', async () => {
    const { assistant, seen, forgotten } = makeAssistant([tagged('<body><p>a</p></body>')]);
    await assistant.assist('p1', base);
    const scope = seen[0]!.options.privacy?.scope;
    expect(scope).toMatch(/^prototype-assistant:p1:/);
    expect(seen[0]!.options.source).toBe('prototype-assistant');
    expect(forgotten).toEqual([scope]);
  });

  it('forgets the scope also when the call fails', async () => {
    const { assistant, forgotten } = makeAssistant([{ fail: { reason: 'auth', message: 'x' } }]);
    await expect(assistant.assist('p1', base)).rejects.toThrow();
    expect(forgotten).toHaveLength(1);
  });

  it('tokenizes a CPF in a field value before the provider and restores it in the result', async () => {
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
    const replies: Reply[] = [];
    const inner = fakeRouter(replies);
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
        replies.push(tagged(`<body><input name="cpf" value="${token}"><p>Servidor</p></body>`));
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
    const assistant = new PrototypeAssistant({
      router,
      ids: { next: () => 'r1' },
      assertPrototype: async () => undefined,
    });
    const result = await assistant.assist('p1', {
      ...base,
      html: `<body><input name="cpf" value="${CPF}"><p>Servidor</p></body>`,
      css: '',
    });
    expect(sentToProvider[0]).not.toContain(CPF);
    expect(sentToProvider[0]).toMatch(/\[CPF_\d+\]/);
    expect(result.html).toContain(`value="${CPF}"`);
  });
});

describe('PrototypeAssistant: sources', () => {
  const lookupTool = (calls: unknown[]): PrototypeAssistantToolsPort => ({
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
          return { text: 'Campo z01_cgccpf: CPF/CNPJ', isError: false };
        },
      }),
      systemNote: '',
      warnings: ['Aviso de fonte'],
    }),
  });

  it('runs the tool loop and reports source warnings', async () => {
    const calls: unknown[] = [];
    const { assistant, seen } = makeAssistant(
      [
        { toolCalls: [{ id: 'c1', name: 'mcp__ecidade__tabela', args: '{"nome":"cgm"}' }] },
        tagged('<body><p>z01_cgccpf</p></body>'),
      ],
      { tools: lookupTool(calls) },
    );
    const result = await assistant.assist('p1', { ...base, mcpServerIds: ['m1'] });
    expect(calls).toEqual([['mcp__ecidade__tabela', { nome: 'cgm' }]]);
    expect(seen[0]!.body.tools).toHaveLength(1);
    expect(promptOf(seen[1]!)).toContain('z01_cgccpf: CPF/CNPJ');
    expect(result.html).toContain('z01_cgccpf');
    expect(result.warnings).toContain('Aviso de fonte');
  });

  it('warns when sources were chosen but are not available', async () => {
    const { assistant } = makeAssistant([tagged('<body><p>a</p></body>')]);
    const result = await assistant.assist('p1', { ...base, libraryIds: ['l1'] });
    expect(result.warnings.some((w) => /fontes/.test(w))).toBe(true);
  });
});

describe('POST /api/prototypes/:id/assistant', () => {
  async function server(replies: Reply[]) {
    const app = Fastify();
    registerErrorHandler(app);
    registerPrototypeAssistantRoutes(app, {
      assistant: makeAssistant(replies).assistant,
      guard: async () => undefined,
    });
    return app;
  }

  it('returns { html, css, explanation, model, usage, warnings }', async () => {
    const app = await server([tagged('<body><p>Oi</p></body>', '', 'Feito.')]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/prototypes/p1/assistant',
      payload: base,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<PrototypeAssistantResultDto>()).toMatchObject({
      html: '<body><p>Oi</p></body>',
      explanation: 'Feito.',
      model: 'fake/model',
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect(res.json<PrototypeAssistantResultDto>().warnings).toBeInstanceOf(Array);
    await app.close();
  });

  it('answers 404, 400 and 413', async () => {
    const app = await server([]);
    const url = (id: string) => `/api/prototypes/${id}/assistant`;
    expect((await app.inject({ method: 'POST', url: url('zzz'), payload: base })).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject({ method: 'POST', url: url('p1'), payload: { prompt: '' } })).statusCode,
    ).toBe(400);
    const big = `<body>${'<p>texto repetido para encher a tela</p>'.repeat(2000)}</body>`;
    const res = await app.inject({
      method: 'POST',
      url: url('p1'),
      payload: { ...base, html: big },
    });
    expect(res.statusCode).toBe(413);
    await app.close();
  });
});

describe('system profile in the prompts', () => {
  const base = {
    action: 'generate',
    mode: 'screen',
    width: 1280,
    height: 720,
    hasTools: true,
    blank: false,
  } as const;

  it('composes the generic assistant with the e-Cidade profile material', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('sistemas web legados');
    expect(prompt).toContain('O sistema é o e-Cidade');
    expect(prompt).toContain('perfil e-Cidade');
    expect(prompt).toContain('Estilo e-Cidade clássico');
    expect(prompt).toContain('dicionário de dados/mapeamento do e-Cidade');
  });

  it('unknown profile ids fall back to the default one', () => {
    expect(getSystemProfile('nope').id).toBe('ecidade');
    expect(getSystemProfile().baseMarker).toBe('/* ec-base */');
  });
});
