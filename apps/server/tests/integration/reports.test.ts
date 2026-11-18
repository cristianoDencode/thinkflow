import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIAGRAM_PROMPT_RULES,
  type ReportDetailDto,
  type ReportDto,
  type ReportSettings,
  type ReportTemplateSummaryDto,
} from '@thinkflow/shared';
import { buildApp } from '../../src/app';
import type { McpGateway, McpServer } from '../../src/contexts/mcp/domain/mcp-server';
import type { FetchFn } from '../../src/contexts/connections/infrastructure/provider-http';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { openDatabase } from '../../src/shared/infrastructure/db/client';
import { UnavailableRenderer } from '../../src/contexts/reports/infrastructure/unavailable-renderer';
import { FakeClock } from '../../src/shared/kernel/clock';
import { silentOcr, createTestApp, type TestApp } from './test-app';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'groq/llama';
const FLOW = 'Segue o fluxo:\nflowchart TD\nA[Início (x)] --> B';

let t: TestApp | undefined;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  // LIFO: close what was opened last first (Windows cannot delete a dir with an open SQLite file)
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/* ------------------------------ fake provider ------------------------------ */

type Kind = 'plan' | 'step' | 'outline' | 'section' | 'other';
interface Message {
  role: string;
  content?: string | null;
}
interface Body {
  messages: Message[];
  tools?: unknown[];
}
interface Call {
  kind: Kind;
  body: Body;
  /** Section number for kind 'section'. */
  n: number;
}

const sse = (frames: object[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
const chunk = (delta: object, finish: string | null = null, extra: object = {}) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'llama',
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});
const usageChunk = {
  id: 'c',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'llama',
  choices: [],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
};
const textResponse = (text: string) =>
  sse([chunk({ role: 'assistant', content: text }), chunk({}, 'stop'), usageChunk]);
const toolCallResponse = (name: string, args: object) =>
  sse([
    chunk({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
    chunk({}, 'tool_calls'),
    usageChunk,
  ]);

function classify(body: Body): { kind: Kind; n: number } {
  const user = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  if (user.includes('Planeje a pesquisa')) return { kind: 'plan', n: 0 };
  if (user.includes('Etapa de pesquisa')) return { kind: 'step', n: 0 };
  if (user.includes('Monte o roteiro')) return { kind: 'outline', n: 0 };
  const section = user.match(/Escreva SOMENTE a seção (\d+) de/);
  if (section) return { kind: 'section', n: Number(section[1]) };
  return { kind: 'other', n: 0 };
}

interface Provider {
  fetchFn: FetchFn;
  calls: Call[];
  count(kind: Kind): number;
  /** Replaces the default answer of a kind. */
  on: Partial<Record<Kind, (call: Call, signal?: AbortSignal) => Promise<Response> | Response>>;
}

function makeProvider(): Provider {
  const calls: Call[] = [];
  const provider: Provider = {
    calls,
    on: {},
    count: (kind) => calls.filter((c) => c.kind === kind).length,
    fetchFn: async (url, init) => {
      if (url !== GROQ) throw new TypeError(`fetch failed: no handler for ${url}`);
      const body = JSON.parse(String(init?.body)) as Body;
      const { kind, n } = classify(body);
      const call: Call = { kind, body, n };
      calls.push(call);
      const override = provider.on[kind];
      if (override) return override(call, init?.signal ?? undefined);
      return defaultAnswer(call);
    },
  };
  return provider;
}

function defaultAnswer(call: Call): Response {
  switch (call.kind) {
    case 'plan':
      return textResponse(
        '```json\n{"etapas":[{"objetivo":"Ler o código de fc_calcula","secoes":[1,2,3]}]}\n```',
      );
    case 'step':
      return call.body.messages.some((m) => m.role === 'tool')
        ? textResponse('- fc_calcula calcula juros e multa (ferramenta mcp__docs__lookup).')
        : toolCallResponse('mcp__docs__lookup', { q: 'fc_calcula' });
    case 'outline':
      return textResponse(
        '{"secoes":[{"n":1,"notas":["n1","n2"],"pontos":["Visão geral da função"]}]}',
      );
    case 'section':
      return textResponse(call.n === 3 ? FLOW : `Conteúdo da seção ${call.n}.`);
    default:
      return textResponse('ok');
  }
}

/** Resolves when the signal aborts, like a provider connection that gets closed. */
const untilAborted = (signal?: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });

class FakeMcpGateway implements McpGateway {
  calls: { tool: string; args: unknown }[] = [];
  async listTools(server: McpServer) {
    return [
      {
        serverId: server.id,
        serverName: server.name,
        name: 'lookup',
        description: 'Busca',
        inputSchema: { type: 'object' },
      },
    ];
  }
  async callTool(_server: McpServer, tool: string, args: Record<string, unknown>) {
    this.calls.push({ tool, args });
    return { text: 'function fc_calcula(...) retorna 0..9', isError: false };
  }
  async invalidate() {}
  async closeAll() {}
}

async function setup(provider = makeProvider(), extra: Parameters<typeof createTestApp>[0] = {}) {
  const mcp = new FakeMcpGateway();
  const clock = new FakeClock();
  const sleeps: number[] = [];
  const app = await createTestApp({
    fetchFn: provider.fetchFn,
    mcpGateway: mcp,
    clock,
    reports: {
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.advance(ms);
      },
    },
    ...extra,
  });
  t = app;
  await app.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
  await app.api('POST', '/api/mcp', {
    transport: 'http',
    name: 'docs',
    url: 'http://localhost:9/mcp',
  });
  const templates = (await app.api<ReportTemplateSummaryDto[]>('GET', '/api/report-templates'))
    .json;
  const byName = (part: string) => templates.find((x) => x.name.includes(part))!.id;
  return { app, provider, mcp, sleeps, clock, byName };
}

const detail = (app: TestApp, id: string) =>
  app.api<ReportDetailDto>('GET', `/api/reports/${id}`).then((r) => r.json);

async function create(app: TestApp, templateId: string, body: object = {}) {
  return app.api<ReportDto>('POST', '/api/reports', { templateId, model: MODEL, ...body });
}

/* ------------------------------ tests ------------------------------ */

describe('reports: generation pipeline', () => {
  it('researches with MCP, writes 12 sections and assembles the document', async () => {
    const { app, provider, mcp, byName } = await setup();
    const created = await create(app, byName('e-Cidade'), { brief: 'Foco em juros e multa.' });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      status: 'queued',
      kind: 'report',
      variables: { funcao: 'fc_calcula' },
      useMcp: true,
    });
    expect(created.json.title).toContain('fc_calcula');

    await app.container.reports.runner.whenIdle();
    const report = await detail(app, created.json.id);

    expect(report.status).toBe('done');
    expect(report.progress.label).toBe('Concluído');
    expect(report.researchDone).toBe(1);
    expect(report.researchTotal).toBe(1);
    expect(report.sections).toHaveLength(12);
    expect(report.sections.every((s) => s.status === 'done')).toBe(true);
    expect(report.sections[2]!.markdown).toContain('```mermaid');
    expect(report.sections[2]!.markdown).toContain('A["Início (x)"]');
    expect(report.sections[0]!.noteCount).toBeGreaterThan(0);
    expect(report.plan).toEqual([{ objective: 'Ler o código de fc_calcula', sections: [1, 2, 3] }]);

    expect(report.markdown).toContain(`# ${report.title}`);
    expect(report.markdown).toContain('## 3. Fluxo');
    expect(report.markdown).toContain('## Sobre este documento');
    expect(report.meta.sources).toEqual([{ kind: 'mcp', name: 'mcp__docs__lookup', calls: 1 }]);
    expect(report.meta.models.length).toBeGreaterThan(0);
    expect(report.meta.diagrams.total).toBe(1);
    expect(report.noteCount).toBe(3); // brief + tool result + synthesis
    expect(mcp.calls).toEqual([{ tool: 'lookup', args: { q: 'fc_calcula' } }]);

    // 1 plan + 2 research calls (tool call, synthesis) + 1 outline + 12 sections
    expect(provider.count('plan')).toBe(1);
    expect(provider.count('step')).toBe(2);
    expect(provider.count('outline')).toBe(1);
    expect(provider.count('section')).toBe(12);

    // sections get the rules, the brief and the research as wrapped data
    const first = provider.calls.find((c) => c.kind === 'section')!;
    expect(first.body.messages[0]!.content).toContain(DIAGRAM_PROMPT_RULES);
    const prompt = first.body.messages[1]!.content!;
    expect(prompt).toContain('<nota id="n1" fonte="brief');
    expect(prompt).toContain('Foco em juros e multa.');
    expect(prompt).toContain('Visão geral da função');

    const usage = await app.api<{ bySource: { source: string }[] }>('GET', '/api/usage');
    const sources = usage.json.bySource.map((s) => s.source);
    expect(sources).toEqual(
      expect.arrayContaining(['report-research', 'report-outline', 'report-section']),
    );

    // list, filters and rename
    const list = await app.api<ReportDto[]>('GET', '/api/reports');
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ id: report.id, sectionCount: 12, hasMarkdown: true });
    expect((await app.api<ReportDto[]>('GET', '/api/reports?status=error')).json).toHaveLength(0);
    expect((await app.api<ReportDto[]>('GET', '/api/reports?q=fc_calcula')).json).toHaveLength(1);
    expect((await app.api<ReportDto[]>('GET', '/api/reports?q=zzz')).json).toHaveLength(0);
    const renamed = await app.api<ReportDto>('PATCH', `/api/reports/${report.id}`, {
      title: 'Novo título',
    });
    expect(renamed.json.title).toBe('Novo título');

    const md = await app.app.inject({
      method: 'GET',
      url: `/api/reports/${report.id}/markdown`,
      headers: { cookie: app.cookie },
    });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.headers['content-disposition']).toContain('attachment; filename="');
    expect(md.body).toContain('## Sobre este documento');
  });

  it('validates the input: missing variables, unknown template, bad model', async () => {
    const { app, byName } = await setup();
    const generic = byName('Análise técnica');
    const missing = await create(app, generic, { variables: {} });
    expect(missing.status).toBe(422);
    expect(missing.json).toMatchObject({ error: { code: 'report_missing_variables' } });
    expect(JSON.stringify(missing.json)).toContain('Assunto');

    expect((await create(app, 'nope')).status).toBe(404);
    expect(
      (await app.api('POST', '/api/reports', { templateId: generic, variables: { assunto: 'x' } }))
        .status,
    ).toBe(400);
    expect((await app.api('GET', '/api/reports/nope')).status).toBe(404);
  });

  it('falls back deterministically when the model returns no JSON and no tool calls', async () => {
    const provider = makeProvider();
    provider.on.plan = () => textResponse('não sei planejar');
    provider.on.step = () => textResponse('- achei algo sem usar ferramentas');
    provider.on.outline = () => textResponse('talvez as notas 1 e 2');
    const { app } = await setup(provider);
    const id = (await create(app, await templateId(app, 'e-Cidade'))).json.id;
    await app.container.reports.runner.whenIdle();
    const report = await detail(app, id);

    expect(report.status).toBe('done');
    // plan: 2 attempts (second with the parse error), then one step per directive (5)
    expect(provider.count('plan')).toBe(2);
    expect(provider.calls.filter((c) => c.kind === 'plan')[1]!.body.messages[1]!.content).toContain(
      'não pôde ser lida',
    );
    expect(report.plan).toHaveLength(5);
    expect(report.plan![0]!.sections).toHaveLength(12);
    expect(provider.count('step')).toBe(5);
    expect(provider.count('outline')).toBe(2);
    expect(report.sections).toHaveLength(12);
    const warnings = report.meta.warnings.join('\n');
    expect(warnings).toContain('plano de pesquisa');
    expect(warnings).toContain('roteiro');
    expect(warnings).toContain('não chamou ferramentas');
    expect(report.markdown).toContain('não chamou ferramentas');
  });

  it('skips the research when MCP is off and no library is connected, writing from the brief', async () => {
    const provider = makeProvider();
    const { app, byName } = await setup(provider);
    const created = await create(app, byName('Análise técnica'), {
      variables: { assunto: 'Cobrança de IPTU' },
      brief: 'Explique a cobrança.',
      useMcp: false,
    });
    expect(created.json.title).toBeTruthy();
    await app.container.reports.runner.whenIdle();
    const report = await detail(app, created.json.id);
    expect(report.status).toBe('done');
    expect(report.plan).toEqual([]);
    expect(provider.count('plan')).toBe(0);
    expect(provider.count('step')).toBe(0);
    expect(provider.count('outline')).toBe(1);
    expect(provider.count('section')).toBe(8);
    expect(report.sections.every((s) => s.status === 'done')).toBe(true);
  });

  it('waits and retries when the provider is rate limited, showing it in the progress', async () => {
    const provider = makeProvider();
    let limited = 0;
    const labels: string[] = [];
    const holder: { app?: TestApp } = {};
    provider.on.section = async (call) => {
      if (call.n === 2) {
        if (limited++ === 0)
          return new Response('{"error":{"message":"rate limit"}}', {
            status: 429,
            headers: { 'content-type': 'application/json' },
          });
        labels.push((await holder.app!.container.reports.service.list({}))[0]!.progress.label);
      }
      return defaultAnswer(call);
    };
    const ctx = await setup(provider);
    const { app } = ctx;
    holder.app = app;
    const created = await create(app, ctx.byName('Análise técnica'), {
      variables: { assunto: 'IPTU' },
    });
    await app.container.reports.runner.whenIdle();
    const report = await detail(app, created.json.id);
    expect(report.status).toBe('done');
    expect(ctx.sleeps).toEqual([10_000]);
    expect(labels).toEqual(['Aguardando o limite do provedor (tentativa 2 de 4)…']);
    expect(report.progress.label).toBe('Concluído');
    expect(report.sections.every((s) => s.status === 'done')).toBe(true);
  });

  it('fails with a clear message when the quota is exhausted, and resumes with Retomar', async () => {
    const provider = makeProvider();
    let exhausted = true;
    provider.on.section = (call) =>
      exhausted && call.n === 3
        ? new Response('{"error":{"message":"You exceeded your current quota"}}', {
            status: 429,
            headers: { 'content-type': 'application/json' },
          })
        : defaultAnswer(call);
    const { app, byName, clock } = await setup(provider);
    const created = await create(app, byName('Análise técnica'), {
      variables: { assunto: 'IPTU' },
    });
    await app.container.reports.runner.whenIdle();
    const failed = await detail(app, created.json.id);
    expect(failed.status).toBe('error');
    expect(failed.failedPhase).toBe('writing');
    expect(failed.error).toContain('Cota do provedor esgotada');
    expect(failed.sections.filter((s) => s.status === 'done')).toHaveLength(2);
    expect(failed.sections[2]!.status).toBe('pending');

    exhausted = false;
    clock.advance(24 * 3_600_000); // the connection leaves its quota cooldown
    const before = provider.count('section');
    const retry = await app.api<ReportDto>('POST', `/api/reports/${created.json.id}/retry`);
    expect(retry.status).toBe(202);
    await app.container.reports.runner.whenIdle();
    const done = await detail(app, created.json.id);
    expect(done.status).toBe('done');
    expect(done.error).toBeNull();
    // only the missing sections were written again
    expect(provider.count('section') - before).toBe(6);
  });

  it('marks failing sections, finishes with a warning and writes the rest', async () => {
    const provider = makeProvider();
    provider.on.section = (call) => (call.n === 2 ? textResponse('   ') : defaultAnswer(call));
    const { app, byName } = await setup(provider);
    const created = await create(app, byName('Análise técnica'), {
      variables: { assunto: 'IPTU' },
    });
    await app.container.reports.runner.whenIdle();
    const report = await detail(app, created.json.id);
    expect(report.status).toBe('done');
    expect(report.sections[1]).toMatchObject({ status: 'error' });
    expect(report.sections.filter((s) => s.status === 'done')).toHaveLength(7);
    expect(report.markdown).toContain('não pôde ser gerada');
  });

  it('cancels a running report keeping its work, and Retomar finishes only what is missing', async () => {
    const provider = makeProvider();
    let blocked = true;
    provider.on.section = (call, signal) =>
      blocked && call.n === 2 ? untilAborted(signal) : defaultAnswer(call);
    const { app, byName } = await setup(provider);
    const created = await create(app, byName('Análise técnica'), {
      variables: { assunto: 'IPTU' },
    });
    await vi.waitFor(async () => {
      const r = await detail(app, created.json.id);
      expect(r.progress.label).toContain('Tópico 2 de 8');
    });
    const canceled = await app.api<ReportDto>('POST', `/api/reports/${created.json.id}/cancel`);
    expect(canceled.status).toBe(202);
    await app.container.reports.runner.whenIdle();
    const stopped = await detail(app, created.json.id);
    expect(stopped.status).toBe('canceled');
    expect(stopped.cancelRequested).toBe(false);
    expect(stopped.sections[0]!.status).toBe('done');
    expect(stopped.sections[1]!.status).toBe('pending');
    expect((await app.api('POST', `/api/reports/${created.json.id}/cancel`)).status).toBe(409);

    blocked = false;
    const before = provider.count('section');
    expect((await app.api('POST', `/api/reports/${created.json.id}/retry`)).status).toBe(202);
    await app.container.reports.runner.whenIdle();
    expect((await detail(app, created.json.id)).status).toBe('done');
    expect(provider.count('section') - before).toBe(7);
    // a finished report cannot be retried
    expect((await app.api('POST', `/api/reports/${created.json.id}/retry`)).status).toBe(409);
  });

  it('cancels a queued report right away', async () => {
    const provider = makeProvider();
    provider.on.section = (call, signal) =>
      call.n === 1 ? untilAborted(signal) : defaultAnswer(call);
    const { app, byName } = await setup(provider);
    const generic = byName('Análise técnica');
    const first = await create(app, generic, { variables: { assunto: 'A' } });
    const second = await create(app, generic, { variables: { assunto: 'B' } });
    await vi.waitFor(async () => {
      expect((await detail(app, first.json.id)).progress.label).toContain('Tópico 1');
    });
    expect((await detail(app, second.json.id)).status).toBe('queued');
    await app.api('POST', `/api/reports/${second.json.id}/cancel`);
    expect((await detail(app, second.json.id)).status).toBe('canceled');
    await app.api('POST', `/api/reports/${first.json.id}/cancel`);
    await app.container.reports.runner.whenIdle();
    expect((await detail(app, first.json.id)).status).toBe('canceled');
    expect(provider.calls.filter((c) => c.kind === 'section')).toHaveLength(1);
  });

  it('rewrites one section with instructions and re-assembles the document', async () => {
    const provider = makeProvider();
    const { app, byName } = await setup(provider);
    const created = await create(app, byName('Análise técnica'), {
      variables: { assunto: 'IPTU' },
    });
    await app.container.reports.runner.whenIdle();
    expect((await detail(app, created.json.id)).status).toBe('done');

    provider.on.section = (call) =>
      call.n === 4 ? textResponse('Texto reescrito da seção 4.') : defaultAnswer(call);
    const before = provider.calls.length;
    const res = await app.api<ReportDto>(
      'POST',
      `/api/reports/${created.json.id}/sections/4/regenerate`,
      { instructions: 'Seja mais breve.' },
    );
    expect(res.status).toBe(202);
    expect(['writing', 'assembling', 'done']).toContain(res.json.status);
    await app.container.reports.runner.whenIdle();

    const report = await detail(app, created.json.id);
    expect(report.status).toBe('done');
    expect(report.sections[3]!.markdown).toBe('Texto reescrito da seção 4.');
    expect(report.markdown).toContain('Texto reescrito da seção 4.');
    const calls = provider.calls.slice(before);
    expect(calls.map((c) => c.kind)).toEqual(['section']);
    const user = calls[0]!.body.messages[1]!.content!;
    expect(user).toContain('Instruções adicionais do usuário: Seja mais breve.');
    expect(user).toContain('Versão atual da seção');

    expect(
      (await app.api('POST', `/api/reports/${created.json.id}/sections/99/regenerate`, {})).status,
    ).toBe(404);
  });

  it('keeps the previous text when a rewrite fails, and refuses rewrites of unfinished reports', async () => {
    const provider = makeProvider();
    const { app, byName } = await setup(provider);
    const created = await create(app, byName('Análise técnica'), {
      variables: { assunto: 'IPTU' },
    });
    await app.container.reports.runner.whenIdle();
    const original = (await detail(app, created.json.id)).sections[1]!.markdown;

    provider.on.section = () => textResponse('');
    await app.api('POST', `/api/reports/${created.json.id}/sections/2/regenerate`, {});
    await app.container.reports.runner.whenIdle();
    const report = await detail(app, created.json.id);
    expect(report.status).toBe('done');
    expect(report.sections[1]!.markdown).toBe(original);
    expect(report.sections[1]!.status).toBe('done');
    expect(report.sections[1]!.warnings.join()).toContain('Não foi possível reescrever');

    // not finished -> 409
    provider.on.section = (call, signal) =>
      call.n === 1 ? untilAborted(signal) : defaultAnswer(call);
    const other = await create(app, byName('Análise técnica'), { variables: { assunto: 'B' } });
    expect(
      (await app.api('POST', `/api/reports/${other.json.id}/sections/1/regenerate`, {})).status,
    ).toBe(409);
    await app.api('POST', `/api/reports/${other.json.id}/cancel`);
    await app.container.reports.runner.whenIdle();
  });

  it('deletes a report, canceling it first when it is running', async () => {
    const provider = makeProvider();
    provider.on.section = (call, signal) =>
      call.n === 1 ? untilAborted(signal) : defaultAnswer(call);
    const { app, byName } = await setup(provider);
    const created = await create(app, byName('Análise técnica'), {
      variables: { assunto: 'IPTU' },
    });
    await vi.waitFor(async () => {
      expect((await detail(app, created.json.id)).progress.label).toContain('Tópico 1');
    });
    expect((await app.api('DELETE', `/api/reports/${created.json.id}`)).status).toBe(200);
    expect((await app.api('GET', `/api/reports/${created.json.id}`)).status).toBe(404);
    await app.container.reports.runner.whenIdle();
    expect((await app.api<ReportDto[]>('GET', '/api/reports')).json).toHaveLength(0);
    expect((await app.api('DELETE', `/api/reports/${created.json.id}`)).status).toBe(404);
  });

  it('keeps the report after its template is deleted (snapshot)', async () => {
    const { app } = await setup();
    const custom = await app.api<{ id: string }>('POST', '/api/report-templates', {
      name: 'Meu modelo',
      kind: 'report',
      spec: {
        persona: 'Analista',
        sections: [{ id: 'a', title: 'Resumo de {{tema}}', requirements: '' }],
        variables: [{ name: 'tema', label: 'Tema', required: true }],
        research: { useMcp: false, useLibrary: false },
        titlePattern: 'Relatório sobre {{tema}}',
      },
    });
    expect(custom.status).toBe(201);
    const created = await create(app, custom.json.id, { variables: { tema: 'IPTU' } });
    expect(created.json.title).toBe('Relatório sobre IPTU');
    await app.container.reports.runner.whenIdle();
    await app.api('DELETE', `/api/report-templates/${custom.json.id}`);
    const report = await detail(app, created.json.id);
    expect(report.status).toBe('done');
    expect(report.sections[0]!.title).toBe('Resumo de IPTU');
    expect(report.templateName).toBe('Meu modelo');
  });

  it('feeds the report with the transcript and the attachments of the chat it came from', async () => {
    const { app, provider, byName } = await setup();
    const chat = await app.app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: app.cookie },
      payload: {
        model: MODEL,
        content: 'Quero um guia sobre o cálculo de juros de mora.',
        useMcp: false,
        attachments: [
          {
            name: 'regras.txt',
            mimeType: 'text/plain',
            data: 'Juros de mora: 1% ao mês, pro rata die.',
          },
        ],
      },
    });
    const conversationId = (
      JSON.parse(chat.body.split('\n\n')[0]!.slice(6)) as { conversationId: string }
    ).conversationId;
    const created = await create(app, byName('Análise técnica'), {
      variables: { assunto: 'Juros de mora' },
      conversationId,
      useMcp: false,
      brief: 'Foque no pro rata die.',
    });
    expect(created.status).toBe(201);
    expect(created.json.conversationId).toBe(conversationId);
    await app.container.reports.runner.whenIdle();
    const report = await detail(app, created.json.id);
    expect(report.status).toBe('done');
    expect(report.noteCount).toBe(2); // attachment + brief (with the condensed transcript)
    expect(report.meta.sources).toEqual([{ kind: 'attachment', name: 'regras.txt', calls: 1 }]);
    const section = provider.calls.find((c) => c.kind === 'section')!;
    const prompt = section.body.messages[1]!.content!;
    expect(prompt).toContain('Juros de mora: 1% ao mês, pro rata die.');
    expect(prompt).toContain('Foque no pro rata die.');
    expect(prompt).toContain('contexto_anterior');
    expect(prompt).toContain('Quero um guia sobre o cálculo de juros de mora.');
    expect(report.markdown).toContain('anexo `regras.txt`');
  });

  it('reads and updates the report settings', async () => {
    const { app } = await setup();
    const initial = await app.api<ReportSettings>('GET', '/api/reports/settings');
    expect(initial.json).toMatchObject({
      maxResearchSteps: 6,
      maxToolCallsPerStep: 3,
      sectionMaxTokens: 1800,
      keepReports: 200,
    });
    const updated = await app.api<ReportSettings>('PUT', '/api/reports/settings', {
      sectionMaxTokens: 900,
      repairModel: 'groq/small',
    });
    expect(updated.json).toMatchObject({
      sectionMaxTokens: 900,
      repairModel: 'groq/small',
      keepReports: 200,
    });
    expect((await app.api('PUT', '/api/reports/settings', { sectionMaxTokens: 5 })).status).toBe(
      400,
    );
  });

  it('prunes the oldest finished reports beyond keepReports', async () => {
    const { app, byName, clock } = await setup();
    await app.api('PUT', '/api/reports/settings', { keepReports: 10 });
    const generic = byName('Análise técnica');
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await create(app, generic, { variables: { assunto: `A${i}` }, title: `R${i}` });
      ids.push(r.json.id);
      await app.container.reports.runner.whenIdle();
      clock.advance(1_000);
    }
    const list = (await app.api<ReportDto[]>('GET', '/api/reports?limit=100')).json;
    expect(list).toHaveLength(11); // 10 kept + the one just created (pruned on the next create)
    expect(list.map((r) => r.title)).not.toContain('R0');
  }, 60_000);
});

async function templateId(app: TestApp, part: string): Promise<string> {
  const list = (await app.api<ReportTemplateSummaryDto[]>('GET', '/api/report-templates')).json;
  return list.find((x) => x.name.includes(part))!.id;
}

describe('reports: resume after a restart', () => {
  it('requeues an interrupted report at boot and continues from the saved state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-reports-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'db.sqlite');
    const provider = makeProvider();
    let blocked = true;
    provider.on.section = (call, signal) =>
      blocked && call.n === 3 ? untilAborted(signal) : defaultAnswer(call);

    const boot = async () => {
      const handle = openDatabase(file);
      const { app, container } = await buildApp({
        config: { ...loadConfig({}), webDir: '/nonexistent' },
        db: handle.db,
        secret: 'test-secret',
        libraryDir: path.join(dir, 'lib'),
        ocrEngine: silentOcr,
        fetchFn: provider.fetchFn,
        // no real Chromium in the suite
        reports: {
          diagramRenderer: new UnavailableRenderer(),
          pdfRenderer: new UnavailableRenderer(),
          dataDir: path.join(dir, 'reports'),
        },
        notebookLm: {
          workDir: path.join(dir, 'nlm'),
          homeDir: path.join(dir, 'home'),
          env: { PATH: process.env.PATH ?? '', DISPLAY: ':99' },
          platform: 'linux',
          isContainer: () => false,
          minGapMs: 0,
        },
      });
      return {
        app,
        container,
        close: async () => {
          await app.close();
          handle.close();
        },
      };
    };

    const first = await boot();
    await first.container.connections.create({ providerId: 'groq', name: 'g', apiKey: 'k' });
    const templates = await first.container.reports.templates.list();
    const generic = templates.find((x) => x.name.includes('Análise técnica'))!;
    const created = await first.container.reports.service.create({
      templateId: generic.id,
      model: MODEL,
      variables: { assunto: 'IPTU' },
    });
    await vi.waitFor(() => expect(provider.count('section')).toBe(3));
    const sectionCallsBefore = provider.count('section');
    // the server goes down while writing section 3
    await first.close();
    await new Promise((r) => setTimeout(r, 20));

    blocked = false;
    const second = await boot();
    cleanups.push(() => second.close());
    await vi.waitFor(
      async () => {
        expect((await second.container.reports.service.get(created.id)).status).toBe('done');
      },
      { timeout: 15_000 },
    );
    const report = await second.container.reports.service.get(created.id);
    expect(report.sections.every((s) => s.status === 'done')).toBe(true);
    // sections 1 and 2 were kept: only 3..8 ran again (the cut one included)
    expect(provider.count('section') - sectionCallsBefore).toBe(6);
  }, 60_000);
});

describe('McpService.enabledToolset filter', () => {
  it('treats a missing or empty server list as every enabled server', async () => {
    const { app } = await setup();
    await app.api('POST', '/api/mcp', {
      transport: 'http',
      name: 'Outro',
      url: 'http://localhost:9/x',
    });
    const aliases = async (servers?: string[]) =>
      (await app.container.mcp.enabledToolset(servers ? { servers } : {})).tools
        .map((tool) => tool.alias)
        .sort();
    expect(await aliases()).toHaveLength(2);
    expect(await aliases([])).toHaveLength(2);
    expect(await aliases(['DOCS'])).toEqual(['mcp__docs__lookup']);
    expect(await aliases(['nao-existe'])).toEqual([]);
  });
});
