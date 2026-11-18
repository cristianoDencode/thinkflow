import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { conversations, piiVault } from '../../src/shared/infrastructure/db/schema';
import type { ConversationDetailDto, ConversationDto } from '@thinkflow/shared';
import type { AgentRunner } from '../../src/contexts/chat/domain/conversation';
import { SUMMARY_SYSTEM_PROMPT } from '../../src/contexts/chat/domain/context-window';
import { fakeFetch, jsonResponse, openAIFrames, sseResponse } from '../helpers';
import { createTestApp, sseEvents, type TestApp } from './test-app';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function setup(overrides: Parameters<typeof createTestApp>[0] = {}) {
  const fetch = fakeFetch([
    { match: (url) => url === GROQ, respond: () => sseResponse(openAIFrames('Resposta pronta')) },
  ]);
  t = await createTestApp({ fetchFn: fetch.fn, ...overrides });
  await t.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
  return t;
}

async function chat(app: TestApp, content: string, extra: Record<string, unknown> = {}) {
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { cookie: app.cookie },
    payload: { model: 'groq/llama', content, ...extra },
  });
  const events = sseEvents(res.body);
  return (events[0] as { conversationId: string }).conversationId;
}

describe('conversation history API', () => {
  it('lists with search by title and by message content, and escapes wildcards', async () => {
    const app = await setup();
    const a = await chat(app, 'Planejar migração do banco');
    const b = await chat(app, 'Receita de bolo');
    await app.api('PATCH', `/api/conversations/${b}`, { title: '100% bolo' });

    const byTitle = await app.api<ConversationDto[]>('GET', '/api/conversations?q=migra');
    expect(byTitle.json.map((c) => c.id)).toEqual([a]);

    const byContent = await app.api<ConversationDto[]>('GET', '/api/conversations?q=pronta');
    expect(byContent.json).toHaveLength(2);

    const wildcard = await app.api<ConversationDto[]>('GET', '/api/conversations?q=%25');
    expect(wildcard.json.map((c) => c.id)).toEqual([b]);
    const underscore = await app.api<ConversationDto[]>('GET', '/api/conversations?q=_');
    expect(underscore.json).toEqual([]);
  });

  it('filters by mode and exposes messageCount and preview', async () => {
    const agent: AgentRunner = {
      run: async () => ({
        sessionId: 's1',
        text: 'feito pelo agente',
        toolCalls: [],
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      }),
    };
    const app = await setup({ agentRunner: agent });
    await chat(app, 'conversa normal');
    const ag = await chat(app, 'tarefa do agente', {
      mode: 'agent',
      model: 'thinkflow/default',
      agent: { permissionMode: 'acceptEdits', cwd: '/tmp' },
    });

    const agents = await app.api<ConversationDto[]>('GET', '/api/conversations?mode=agent');
    expect(agents.json.map((c) => c.id)).toEqual([ag]);
    expect(agents.json[0]).toMatchObject({
      messageCount: 2,
      preview: 'feito pelo agente',
      pinned: false,
      hasSummary: false,
      libraryId: null,
      preset: null,
      parentConversationId: null,
    });

    const detail = await app.api<ConversationDetailDto>('GET', `/api/conversations/${ag}`);
    expect(detail.json.agent).toEqual({ cwd: '/tmp', permissionMode: 'acceptEdits' });
    expect(detail.json.summary).toBeNull();
    expect(detail.json.parentTitle).toBeNull();
  });

  it('renames and pins (pinned first, pinned filter); unknown id is 404; empty patch is 400', async () => {
    const app = await setup();
    const a = await chat(app, 'primeira');
    const b = await chat(app, 'segunda');

    const patched = await app.api<ConversationDto>('PATCH', `/api/conversations/${a}`, {
      title: '  Nome novo  ',
      pinned: true,
    });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ id: a, title: 'Nome novo', pinned: true });

    const list = await app.api<ConversationDto[]>('GET', '/api/conversations');
    expect(list.json.map((c) => c.id)).toEqual([a, b]);
    const pinned = await app.api<ConversationDto[]>('GET', '/api/conversations?pinned=true');
    expect(pinned.json.map((c) => c.id)).toEqual([a]);
    const notPinned = await app.api<ConversationDto[]>('GET', '/api/conversations?pinned=false');
    expect(notPinned.json.map((c) => c.id)).toEqual([b]);

    expect((await app.api('PATCH', '/api/conversations/nope', { pinned: true })).status).toBe(404);
    expect((await app.api('PATCH', `/api/conversations/${a}`, {})).status).toBe(400);
  });

  it('paginates with limit and offset', async () => {
    const app = await setup();
    for (const n of ['um', 'dois', 'tres']) await chat(app, n);
    const page = await app.api<ConversationDto[]>('GET', '/api/conversations?limit=2&offset=2');
    expect(page.json).toHaveLength(1);
  });

  it('keeps a renamed title and pin after a later turn', async () => {
    const app = await setup();
    const id = await chat(app, 'original');
    await app.api('PATCH', `/api/conversations/${id}`, { title: 'Renomeada', pinned: true });
    await chat(app, 'mais uma', { conversationId: id });

    const detail = await app.api<ConversationDetailDto>('GET', `/api/conversations/${id}`);
    expect(detail.json).toMatchObject({ title: 'Renomeada', pinned: true, messageCount: 4 });
  });
});

/* ---------------- bounded context + rolling summary ---------------- */

const turnText = (n: number) => `TURNO${n} ${'a'.repeat(3_000)}`;
const isSummaryCall = (body: Record<string, unknown> | null) =>
  JSON.stringify(body?.messages ?? '').includes(SUMMARY_SYSTEM_PROMPT);
const text = (body: Record<string, unknown> | null) => JSON.stringify(body?.messages ?? '');

async function chatEvents(app: TestApp, content: string, extra: Record<string, unknown> = {}) {
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { cookie: app.cookie },
    payload: { model: 'groq/llama', content, ...extra },
  });
  return sseEvents(res.body);
}

async function boundedSetup(
  summaryResponse: () => Response,
  chatResponse: (body: Record<string, unknown> | null) => Response = () =>
    sseResponse(openAIFrames('Resposta pronta')),
) {
  const fetch = fakeFetch([
    { match: (_u, b) => isSummaryCall(b), respond: summaryResponse },
    { match: (u) => u === GROQ, respond: () => chatResponse(null) },
  ]);
  const app = await createTestApp({ fetchFn: fetch.fn });
  t = app;
  await app.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
  await app.api('PUT', '/api/settings', { history: { contextBudgetTokens: 2000, recentTurns: 1 } });
  return { app, fetch };
}

describe('bounded context and rolling summary', () => {
  it('summarizes old turns with the model, sends summary + recent turns, and exposes it', async () => {
    const { app, fetch } = await boundedSetup(() =>
      sseResponse(openAIFrames('Resumo gerado pelo LLM')),
    );
    let id: string | undefined;
    let lastEvents: Record<string, unknown>[] = [];
    for (const n of [1, 2, 3, 4]) {
      lastEvents = await chatEvents(app, turnText(n), id ? { conversationId: id } : {});
      id ??= (lastEvents[0] as { conversationId: string }).conversationId;
    }

    const chatCalls = fetch.calls.filter((c) => !isSummaryCall(c.body));
    const last = text(chatCalls.at(-1)!.body);
    expect(last).toContain('Resumo da conversa até aqui');
    expect(last).toContain('Resumo gerado pelo LLM');
    expect(last).not.toContain('TURNO1');
    expect(last).toContain('TURNO4');
    expect(fetch.calls.some((c) => isSummaryCall(c.body))).toBe(true);

    const context = lastEvents.find((e) => e.type === 'context') as Record<
      string,
      number | boolean
    >;
    expect(context).toMatchObject({ summarized: true, budgetTokens: 2000 });
    expect(context.omittedMessages).toBeGreaterThan(0);
    expect(context.keptMessages).toBeGreaterThan(0);

    const detail = await app.api<ConversationDetailDto>('GET', `/api/conversations/${id}`);
    expect(detail.json.hasSummary).toBe(true);
    expect(detail.json.summary).toMatchObject({ kind: 'llm', text: 'Resumo gerado pelo LLM' });
    expect(detail.json.summary!.throughMessageId).toBeTruthy();
    expect(detail.json.messages).toHaveLength(8); // nothing is deleted
  });

  it('falls back to an extractive summary when the summary model fails, and still answers', async () => {
    const { app } = await boundedSetup(() =>
      jsonResponse({ error: { message: 'messages: field required' } }, 400),
    );
    let id: string | undefined;
    let events: Record<string, unknown>[] = [];
    for (const n of [1, 2, 3, 4]) {
      events = await chatEvents(app, turnText(n), id ? { conversationId: id } : {});
      id ??= (events[0] as { conversationId: string }).conversationId;
    }
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    const detail = await app.api<ConversationDetailDto>('GET', `/api/conversations/${id}`);
    expect(detail.json.summary?.kind).toBe('extractive');
    expect(detail.json.summary?.text).toContain('- Usuário: TURNO');
  });

  it('retries once with a smaller context when the provider rejects the size', async () => {
    const fetch = fakeFetch([
      {
        match: (_u, b) => isSummaryCall(b),
        respond: () => sseResponse(openAIFrames('Resumo curto')),
      },
      {
        match: (u) => u === GROQ,
        respond: () => sseResponse(openAIFrames('Resposta pronta')),
      },
    ]);
    // reject chat requests that are too big (chars), like a 3000-token model would
    const original = fetch.fn;
    let rejected = 0;
    const guarded: typeof original = async (url, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if (url === GROQ && !isSummaryCall(body) && text(body).length > 10_000) {
        rejected++;
        return jsonResponse(
          { error: { message: "This model's maximum context length is 3000 tokens" } },
          400,
        );
      }
      return original(url, init);
    };
    const app = await createTestApp({ fetchFn: guarded });
    t = app;
    await app.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
    await app.api('PUT', '/api/settings', {
      history: { contextBudgetTokens: 6000, recentTurns: 6 },
    });

    let id: string | undefined;
    let events: Record<string, unknown>[] = [];
    for (const n of [1, 2, 3]) {
      events = await chatEvents(app, turnText(n), id ? { conversationId: id } : {});
      id ??= (events[0] as { conversationId: string }).conversationId;
    }
    expect(events.filter((e) => e.type === 'context')).toHaveLength(1);
    const before = fetch.calls.length;
    expect(rejected).toBe(0);
    events = await chatEvents(app, turnText(4), { conversationId: id });

    const contexts = events.filter((e) => e.type === 'context') as {
      budgetTokens: number;
      estimatedTokens: number;
      omittedMessages: number;
    }[];
    expect(contexts).toHaveLength(2);
    expect(rejected).toBe(1);
    expect(contexts[1]!.budgetTokens).toBeLessThan(contexts[0]!.budgetTokens);
    expect(contexts[1]!.omittedMessages).toBeGreaterThan(contexts[0]!.omittedMessages);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    // the guarded fetch rejected the first attempt before reaching the fake, so only the summary and the retry were recorded
    const retried = fetch.calls
      .slice(before)
      .filter((c) => c.url === GROQ && !isSummaryCall(c.body));
    expect(retried).toHaveLength(1);
    expect(text(retried[0]!.body)).toContain('Resumo da conversa até aqui');
  });

  it('keeps text attachments visible to later turns without exposing them in the API', async () => {
    const { app, fetch } = await boundedSetup(() => sseResponse(openAIFrames('resumo')));
    await app.api('PUT', '/api/settings', { history: { contextBudgetTokens: 16000 } });
    const first = await chatEvents(app, 'analise o arquivo', {
      attachments: [
        { name: 'notas.txt', mimeType: 'text/plain', data: 'CONTEUDO-SECRETO-DO-ARQUIVO' },
      ],
    });
    const id = (first[0] as { conversationId: string }).conversationId;
    await chatEvents(app, 'e agora?', { conversationId: id });

    const second = text(fetch.calls.filter((c) => !isSummaryCall(c.body)).at(-1)!.body);
    expect(second).toContain('CONTEUDO-SECRETO-DO-ARQUIVO');
    expect(second).toContain('Arquivo anexado: notas.txt');

    const detail = await app.api<ConversationDetailDto>('GET', `/api/conversations/${id}`);
    expect(detail.json.messages[0]!.meta.attachments).toEqual([
      { name: 'notas.txt', mimeType: 'text/plain' },
    ]);
  });

  it('settings: history defaults, partial updates and validation', async () => {
    const app = await setup();
    const initial = await app.api<{ history: Record<string, unknown> }>('GET', '/api/settings');
    expect(initial.json.history).toEqual({
      contextBudgetTokens: 16_000,
      recentTurns: 6,
      summaryModel: '',
      maxConversations: 500,
    });
    const updated = await app.api<{ history: Record<string, unknown> }>('PUT', '/api/settings', {
      history: { recentTurns: 3 },
    });
    expect(updated.json.history).toMatchObject({ recentTurns: 3, contextBudgetTokens: 16_000 });
    await app.api('PUT', '/api/settings', { history: { summaryModel: 'groq/x' } });
    const again = await app.api<{ history: Record<string, unknown> }>('GET', '/api/settings');
    expect(again.json.history).toMatchObject({ recentTurns: 3, summaryModel: 'groq/x' });
    expect(
      (await app.api('PUT', '/api/settings', { history: { contextBudgetTokens: 10 } })).status,
    ).toBe(400);
  });
});

describe('fork (derivar)', () => {
  async function fourTurns() {
    const { app, fetch } = await boundedSetup(() =>
      sseResponse(openAIFrames('Resumo gerado pelo LLM')),
    );
    let id: string | undefined;
    for (const n of [1, 2, 3, 4]) {
      const events = await chatEvents(app, turnText(n), id ? { conversationId: id } : {});
      id ??= (events[0] as { conversationId: string }).conversationId;
    }
    const detail = await app.api<ConversationDetailDto>('GET', `/api/conversations/${id}`);
    return { app, fetch, id: id!, parent: detail.json };
  }

  it('derives from an assistant message with a summary of the older turns and carried recent ones', async () => {
    const { app, fetch, id, parent } = await fourTurns();
    const from = parent.messages.at(-1)!;
    const res = await app.api<ConversationDto>('POST', `/api/conversations/${id}/fork`, {
      messageId: from.id,
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      parentConversationId: id,
      forkedFromMessageId: from.id,
      hasSummary: true,
      title: `${parent.title.slice(0, 60)} (derivada)`,
    });

    const detail = await app.api<ConversationDetailDto>('GET', `/api/conversations/${res.json.id}`);
    expect(detail.json.parentTitle).toBe(parent.title);
    expect(detail.json.summary).toMatchObject({ kind: 'llm', throughMessageId: null });
    expect(detail.json.messages.length).toBeGreaterThanOrEqual(2);
    expect(detail.json.messages.length).toBeLessThan(parent.messages.length);
    expect(detail.json.messages.every((m) => m.meta.carried === true)).toBe(true);
    expect(detail.json.messages.at(-1)!.content).toBe(from.content);
    expect(detail.json.messages.map((m) => m.id)).not.toContain(from.id);
    // the parent is untouched
    const after = await app.api<ConversationDetailDto>('GET', `/api/conversations/${id}`);
    expect(after.json.messages).toHaveLength(parent.messages.length);

    // the next turn in the fork sees the summary and not the parent's first turn
    await chatEvents(app, 'e agora?', { conversationId: res.json.id });
    const last = fetch.calls.filter((c) => !isSummaryCall(c.body)).at(-1)!;
    expect(text(last.body)).toContain('Resumo gerado pelo LLM');
    expect(text(last.body)).not.toContain('TURNO1');
    expect(text(last.body)).toContain('e agora?');
  });

  it('rejects user messages (400), unknown messages and conversations (404)', async () => {
    const { app, id, parent } = await fourTurns();
    const user = parent.messages[0]!;
    expect(
      (await app.api('POST', `/api/conversations/${id}/fork`, { messageId: user.id })).status,
    ).toBe(400);
    expect(
      (await app.api('POST', `/api/conversations/${id}/fork`, { messageId: 'nope' })).status,
    ).toBe(404);
    expect(
      (await app.api('POST', `/api/conversations/nope/fork`, { messageId: user.id })).status,
    ).toBe(404);
    expect((await app.api('POST', `/api/conversations/${id}/fork`, {})).status).toBe(400);
  });

  it('keeps the fork when the parent is deleted', async () => {
    const { app, id, parent } = await fourTurns();
    const res = await app.api<ConversationDto>('POST', `/api/conversations/${id}/fork`, {
      messageId: parent.messages[1]!.id,
      title: 'Minha derivação',
    });
    expect(res.json.title).toBe('Minha derivação');
    await app.api('DELETE', `/api/conversations/${id}`);
    const detail = await app.api<ConversationDetailDto>('GET', `/api/conversations/${res.json.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ parentConversationId: id, parentTitle: null });
  });
});

describe('privacy vault', () => {
  it('drops the conversation vault scope when the conversation is deleted', async () => {
    const app = await setup();
    const id = await chat(app, 'oi');
    const other = await chat(app, 'outra');
    for (const scope of [id, other]) {
      app.db
        .insert(piiVault)
        .values({
          scopeId: scope,
          token: '[CPF_1]',
          kind: 'CPF',
          valueCipher: 'v1:x',
          valueHash: 'h',
          createdAt: 1,
        })
        .run();
    }
    expect((await app.api('DELETE', `/api/conversations/${id}`)).status).toBeLessThan(300);
    expect(
      app.db
        .select()
        .from(piiVault)
        .all()
        .map((r) => r.scopeId),
    ).toEqual([other]);
  });
});

describe('retention', () => {
  it('prunes the oldest unpinned conversations beyond maxConversations and their agent transcripts', async () => {
    const deleted: string[] = [];
    let n = 0;
    const agent: AgentRunner = {
      run: async () => ({
        sessionId: `sess-${++n}`,
        text: 'feito',
        toolCalls: [],
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      }),
      deleteSession: async (sessionId) => {
        deleted.push(sessionId);
      },
    };
    const app = await setup({ agentRunner: agent });
    await app.api('PUT', '/api/settings', { history: { maxConversations: 10 } });

    const oldest = await chat(app, 'tarefa do agente', {
      mode: 'agent',
      agent: { cwd: '/tmp', permissionMode: 'plan' },
    });
    const pinned = await chat(app, 'conversa fixada');
    await app.api('PATCH', `/api/conversations/${pinned}`, { pinned: true });
    for (let i = 0; i < 10; i++) await chat(app, `conversa ${i}`);

    await vi.waitFor(async () => {
      const list = await app.api<ConversationDto[]>('GET', '/api/conversations?limit=100');
      expect(list.json).toHaveLength(10);
    });
    const list = await app.api<ConversationDto[]>('GET', '/api/conversations?limit=100');
    const ids = list.json.map((c) => c.id);
    expect(ids).toContain(pinned);
    expect(ids).not.toContain(oldest);
    await vi.waitFor(() => expect(deleted).toEqual(['sess-1']));
  });
});

describe('history filters by origin, connection and period', () => {
  it('separates chat, document, agent and data conversations and filters by last activity', async () => {
    const agent: AgentRunner = {
      run: async () => ({
        sessionId: 's1',
        text: 'ok',
        toolCalls: [],
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      }),
    };
    const app = await setup({ agentRunner: agent });
    const plain = await chat(app, 'conversa normal');
    const doc = await chat(app, 'quero um relatório');
    // a document-template conversation (the preset itself is covered by the preset tests)
    app.db
      .update(conversations)
      .set({ presetKind: 'report', presetTemplateId: 'builtin-report' })
      .where(eq(conversations.id, doc))
      .run();
    const ag = await chat(app, 'tarefa do agente', {
      mode: 'agent',
      model: 'thinkflow/default',
      agent: { permissionMode: 'plan' },
    });
    const db1 = await app.api<{ id: string }>('POST', '/api/databases', {
      name: 'e-Cidade',
      host: 'localhost',
      database: 'ecidade',
      user: 'leitor',
      password: 'x',
    });
    const db2 = await app.api<{ id: string }>('POST', '/api/databases', {
      name: 'Homologação',
      host: 'localhost',
      database: 'homolog',
      user: 'leitor',
      password: 'x',
    });
    const data1 = await chat(app, 'select 1', {
      mode: 'data',
      databaseId: db1.json.id,
      directSql: true,
    });
    const data2 = await chat(app, 'select 2', {
      mode: 'data',
      databaseId: db2.json.id,
      directSql: true,
    });

    const ids = async (qs: string) =>
      (await app.api<ConversationDto[]>('GET', `/api/conversations?${qs}`)).json
        .map((c) => c.id)
        .sort();
    expect(await ids('origin=chat')).toEqual([plain]);
    expect(await ids('origin=document')).toEqual([doc]);
    expect(await ids('origin=agent')).toEqual([ag]);
    expect(await ids('origin=data')).toEqual([data1, data2].sort());
    expect(await ids(`origin=data&databaseId=${db2.json.id}`)).toEqual([data2]);

    // period: an old conversation falls outside a recent window
    const old = Date.UTC(2024, 0, 15);
    app.db.update(conversations).set({ updatedAt: old }).where(eq(conversations.id, plain)).run();
    const recent = await ids(`from=${Date.now() - 86_400_000}`);
    expect(recent).not.toContain(plain);
    expect(recent).toContain(ag);
    expect(await ids(`from=${Date.UTC(2024, 0, 1)}&to=${Date.UTC(2024, 0, 31)}`)).toEqual([plain]);
    expect((await app.api('GET', '/api/conversations?origin=outra')).status).toBe(400);
  });
});
