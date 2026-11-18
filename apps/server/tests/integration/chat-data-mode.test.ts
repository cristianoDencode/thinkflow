import { afterEach, describe, expect, it } from 'vitest';
import type {
  AiReviewDto,
  ColumnRuleDto,
  ConversationDetailDto,
  ConversationDto,
  DatabaseConnectionDto,
  QueryResultDto,
} from '@thinkflow/shared';
import { messages } from '../../src/shared/infrastructure/db/schema';
import { FakePgGateway } from '../databases/fake-pg-gateway';
import { fakeFetch, sseResponse } from '../helpers';
import { createTestApp, sseEvents, type TestApp } from './test-app';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const SECRET_VALUE = 'Maria da Silva';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  listening = undefined;
});

const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'llama' };
const frame = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/** First model turn calls `executar_consulta`; the second one answers. */
function queryThenAnswer(sql: string) {
  let call = 0;
  return fakeFetch([
    {
      match: (url) => url === GROQ,
      respond: () =>
        ++call % 2 === 1
          ? sseResponse([
              frame({
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'executar_consulta',
                      arguments: JSON.stringify({ sql, objetivo: 'Listar contribuintes' }),
                    },
                  },
                ],
              }),
              frame({}, 'tool_calls'),
              'data: [DONE]\n\n',
            ])
          : sseResponse([
              frame({ content: 'Encontrei 3 contribuintes.' }),
              frame({}, 'stop'),
              'data: [DONE]\n\n',
            ]),
    },
  ]);
}

/** Every model turn answers with the next text (no tool calls). */
function answers(...texts: string[]) {
  let call = 0;
  return fakeFetch([
    {
      match: (url) => url === GROQ,
      respond: () =>
        sseResponse([
          frame({ role: 'assistant', content: texts[Math.min(call++, texts.length - 1)] }),
          frame({}, 'stop'),
          'data: [DONE]\n\n',
        ]),
    },
  ]);
}

const sqlAnswer = (sql: string, intro = 'Use esta consulta:') =>
  `${intro}\n\n\`\`\`sql\n${sql}\n\`\`\``;

async function setup(overrides: Parameters<typeof createTestApp>[0] = {}) {
  const pg = new FakePgGateway();
  t = await createTestApp({ pgGateway: pg, ...overrides });
  const created = await t.api<DatabaseConnectionDto>('POST', '/api/databases', {
    name: 'e-Cidade',
    host: 'localhost',
    database: 'ecidade',
    user: 'leitor',
    password: 'segredo',
    aiAccess: 'schema',
  });
  expect(created.status).toBe(201);
  return { pg, databaseId: created.json.id };
}

async function chat(payload: Record<string, unknown>) {
  const res = await t!.app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { cookie: t!.cookie },
    payload: { mode: 'data', model: 'groq/llama', ...payload },
  });
  expect(res.statusCode).toBe(200);
  return sseEvents(res.body);
}

describe('chat: data mode — SQL shown in the answer', () => {
  const BAD = 'select c.z01_nomee from public.cgm c limit 5';
  const GOOD = 'select c.z01_nome from public.cgm c limit 5';

  it('validates the SQL of the answer without running it and stores the result with the message', async () => {
    const fetch = answers(sqlAnswer(GOOD));
    const { pg, databaseId } = await setup({ fetchFn: fetch.fn });
    await t!.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });

    const events = await chat({ databaseId, content: 'Como listo os nomes?', useMcp: false });
    const types = events.map((e) => e.type);
    expect(types).not.toContain('answer_rewrite');
    expect(types.indexOf('sql_validation')).toBeLessThan(types.indexOf('done'));
    expect(events.find((e) => e.type === 'sql_validation')).toEqual({
      type: 'sql_validation',
      blocks: [{ index: 0, status: 'ok', issues: [], reason: null }],
    });
    expect(fetch.calls).toHaveLength(1);
    // EXPLAIN only: the query itself never reached the database
    expect(pg.explainedOnly).toEqual([GOOD]);
    expect(pg.queries).toEqual([]);

    const conversationId = (events[0] as { conversationId: string }).conversationId;
    const detail = await t!.api<ConversationDetailDto>(
      'GET',
      `/api/conversations/${conversationId}`,
    );
    expect(detail.json.messages[1]!.meta.sqlValidation).toEqual([
      { index: 0, status: 'ok', issues: [], reason: null },
    ]);
  });

  it('gives the model ONE corrective round when the SQL names something that does not exist', async () => {
    const fetch = answers(sqlAnswer(BAD, 'Rascunho:'), sqlAnswer(GOOD, 'Corrigido:'));
    const { pg, databaseId } = await setup({ fetchFn: fetch.fn });
    await t!.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });

    const events = await chat({ databaseId, content: 'Como listo os nomes?', useMcp: false });
    const types = events.map((e) => e.type);
    expect(fetch.calls).toHaveLength(2);
    expect(types.filter((e) => e === 'answer_rewrite')).toHaveLength(1);
    expect(types.filter((e) => e === 'sql_validation')).toHaveLength(1);
    expect(types.indexOf('answer_rewrite')).toBeLessThan(types.lastIndexOf('delta'));
    expect(types.indexOf('answer_rewrite')).toBeLessThan(types.indexOf('sql_validation'));
    expect(events.find((e) => e.type === 'answer_rewrite')).toEqual({
      type: 'answer_rewrite',
      keepChars: 0,
    });

    // the second request carries the draft and the findings (identifiers only), then asks for a rewrite
    const second = fetch.calls[1]!.body!.messages as { role: string; content: string }[];
    expect(second.at(-2)).toMatchObject({ role: 'assistant' });
    expect(second.at(-2)!.content).toContain(BAD);
    const correction = second.at(-1)!;
    expect(correction.role).toBe('user');
    expect(correction.content).toContain('Bloco SQL 1');
    expect(correction.content).toContain('z01_nomee');
    expect(correction.content).toContain('Parecidas: z01_nome');
    expect(correction.content).toContain('Reescreva a resposta inteira');

    // the final verdict is the one of the rewritten answer; the draft is not kept
    expect(events.find((e) => e.type === 'sql_validation')).toMatchObject({
      blocks: [{ index: 0, status: 'ok' }],
    });
    const conversationId = (events[0] as { conversationId: string }).conversationId;
    const detail = await t!.api<ConversationDetailDto>(
      'GET',
      `/api/conversations/${conversationId}`,
    );
    const stored = detail.json.messages[1]!;
    expect(stored.content).toBe(sqlAnswer(GOOD, 'Corrigido:'));
    expect(stored.meta.sqlValidation).toMatchObject([{ index: 0, status: 'ok' }]);
    expect(pg.queries).toEqual([]);
    // validation failures never touch the 6-query budget: nothing was executed at all
    expect(pg.explainedOnly).toEqual([GOOD]);
  });

  it('does not loop: a second wrong SQL is reported as invalid, with suggestions', async () => {
    const fetch = answers(sqlAnswer(BAD), sqlAnswer(BAD), sqlAnswer(GOOD));
    const { pg, databaseId } = await setup({ fetchFn: fetch.fn });
    await t!.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });

    const events = await chat({ databaseId, content: 'Como listo os nomes?', useMcp: false });
    expect(fetch.calls).toHaveLength(2);
    expect(events.filter((e) => e.type === 'answer_rewrite')).toHaveLength(1);
    const validation = events.find((e) => e.type === 'sql_validation') as unknown as {
      blocks: {
        index: number;
        status: string;
        issues: { message: string; suggestions: string[] }[];
      }[];
    };
    expect(validation.blocks).toHaveLength(1);
    expect(validation.blocks[0]).toMatchObject({ index: 0, status: 'invalid' });
    expect(validation.blocks[0]!.issues[0]).toEqual({
      message: 'coluna "z01_nomee" não existe em public.cgm (usada como c.z01_nomee).',
      suggestions: ['z01_nome', 'z01_nomecomple'],
    });
    expect(pg.queries).toEqual([]);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('reports an unreachable database as unchecked, without a corrective round', async () => {
    const fetch = answers(sqlAnswer(BAD));
    const { pg, databaseId } = await setup({ fetchFn: fetch.fn });
    await t!.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
    pg.unreachable = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    const events = await chat({ databaseId, content: 'Como listo os nomes?', useMcp: false });
    expect(fetch.calls).toHaveLength(1);
    expect(events.some((e) => e.type === 'answer_rewrite')).toBe(false);
    const validation = events.find((e) => e.type === 'sql_validation') as unknown as {
      blocks: { status: string; reason: string }[];
    };
    expect(validation.blocks[0]).toMatchObject({ status: 'unchecked' });
    expect(validation.blocks[0]!.reason).toContain('Conexão recusada');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('skips the check for answers without SQL blocks and for direct SQL', async () => {
    const fetch = answers('Não há SQL aqui, só ```inline```.');
    const { databaseId } = await setup({ fetchFn: fetch.fn });
    await t!.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
    const events = await chat({ databaseId, content: 'Oi', useMcp: false });
    expect(events.some((e) => e.type === 'sql_validation')).toBe(false);
  });
});

describe('chat: data mode', () => {
  it('runs direct SQL without calling any model and never persists the rows', async () => {
    const fetch = fakeFetch([]);
    const { pg, databaseId } = await setup({ fetchFn: fetch.fn });

    const events = await chat({
      databaseId,
      directSql: true,
      content: 'select id, nome\n  from contribuintes',
    });
    expect(events.map((e) => e.type)).toEqual(['conversation', 'query_result', 'done']);
    const result = (events[1] as unknown as { result: QueryResultDto }).result;
    expect(result.source).toBe('direct');
    expect(result.rowCount).toBe(3);
    expect(JSON.stringify(result.rows)).toContain(SECRET_VALUE);
    expect(fetch.calls).toHaveLength(0);
    expect(pg.queries).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ providerId: null, inputTokens: null });

    const conversationId = (events[0] as { conversationId: string }).conversationId;
    const detail = await t!.api<ConversationDetailDto>(
      'GET',
      `/api/conversations/${conversationId}`,
    );
    expect(detail.json).toMatchObject({
      mode: 'data',
      databaseId,
      title: 'select id, nome from contribuintes',
    });
    expect(detail.json.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.json.messages[0]?.content).toBe('select id, nome\n  from contribuintes');
    const meta = detail.json.messages[1]!.meta.queryResults!;
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({ id: result.id, rowCount: 3, source: 'direct', error: null });
    expect(meta[0]).not.toHaveProperty('rows');

    // not even the raw SQLite rows hold the query data
    const stored = JSON.stringify(t!.db.select().from(messages).all());
    expect(stored).not.toContain(SECRET_VALUE);
    expect(stored).toContain('queryResults');
  });

  it('reports a failing direct query inside the result, not as a stream error', async () => {
    const { pg, databaseId } = await setup();
    pg.respond = () => {
      throw new Error('relação "x" não existe');
    };
    const events = await chat({ databaseId, directSql: true, content: 'select * from x' });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const result = (
      events.find((e) => e.type === 'query_result') as unknown as {
        result: QueryResultDto;
      }
    ).result;
    expect(result.error).toContain('não existe');
    expect(result.rows).toEqual([]);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('lets the AI explore with tools: full rows to the screen, only a digest to the model', async () => {
    const fetch = queryThenAnswer('select * from contribuintes limit 10');
    const { pg, databaseId } = await setup({ fetchFn: fetch.fn });
    await t!.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });

    const events = await chat({
      databaseId,
      content: 'Quais contribuintes existem?',
      useMcp: false,
    });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('conversation');
    expect(types.indexOf('tool_call')).toBeLessThan(types.indexOf('query_result'));
    expect(types.indexOf('query_result')).toBeLessThan(types.indexOf('tool_result'));
    expect(types.at(-1)).toBe('done');

    const result = (
      events.find((e) => e.type === 'query_result') as unknown as {
        result: QueryResultDto;
      }
    ).result;
    expect(result.source).toBe('ai');
    expect(result.purpose).toBe('Listar contribuintes');
    expect(JSON.stringify(result.rows)).toContain(SECRET_VALUE);
    expect(pg.queries.map((q) => q.sql)).toEqual(['select * from contribuintes limit 10']);

    // the tool list given to the model is the data toolset
    const names = (fetch.calls[0]!.body!.tools as { function: { name: string } }[]).map(
      (x) => x.function.name,
    );
    expect(names).toEqual(expect.arrayContaining(['listar_tabelas', 'executar_consulta']));
    const system = (fetch.calls[0]!.body!.messages as { role: string; content: string }[])[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('somente leitura');

    // the second request carried back the digest only (aiAccess = schema)
    const second = fetch.calls[1]!.body!.messages as { role: string; content: string }[];
    const toolMessage = second.at(-1)!;
    expect(toolMessage.role).toBe('tool');
    expect(toolMessage.content).not.toContain(SECRET_VALUE);
    const toolResult = events.find((e) => e.type === 'tool_result') as { output: string };
    expect(toolResult.output).not.toContain(SECRET_VALUE);

    const conversationId = (events[0] as { conversationId: string }).conversationId;
    const detail = await t!.api<ConversationDetailDto>(
      'GET',
      `/api/conversations/${conversationId}`,
    );
    expect(detail.json).toMatchObject({ mode: 'data', databaseId });
    const assistant = detail.json.messages[1]!;
    expect(assistant.content).toBe('Encontrei 3 contribuintes.');
    expect(assistant.meta.queryResults).toHaveLength(1);
    expect(assistant.meta.queryResults![0]).not.toHaveProperty('rows');
    expect(JSON.stringify(t!.db.select().from(messages).all())).not.toContain(SECRET_VALUE);

    // accounted under its own source
    const logs = await t!.api<{ source: string }[]>('GET', '/api/logs');
    expect(logs.json.map((l) => l.source)).toEqual(['data-ai', 'data-ai']);
  });

  it('requires a valid connection before creating anything', async () => {
    const fetch = fakeFetch([]);
    const { databaseId } = await setup({ fetchFn: fetch.fn });

    const none = await chat({ content: 'Quantos contribuintes?' });
    expect(none).toEqual([{ type: 'error', message: 'Escolha uma conexão de banco em Database.' }]);

    const missing = await chat({ content: 'oi', databaseId: 'nao-existe', directSql: true });
    expect(missing).toEqual([
      { type: 'error', message: 'Escolha uma conexão de banco em Database.' },
    ]);

    expect(fetch.calls).toHaveLength(0);
    const list = await t!.api<ConversationDto[]>('GET', '/api/conversations?mode=data');
    expect(list.json).toEqual([]);

    // a valid connection works afterwards
    const ok = await chat({ databaseId, directSql: true, content: 'select 1' });
    expect(ok.at(-1)?.type).toBe('done');
  });

  it('lists data conversations by mode, keeps and switches the connection', async () => {
    const { databaseId } = await setup();
    const other = await t!.api<DatabaseConnectionDto>('POST', '/api/databases', {
      name: 'outro',
      host: 'localhost',
      database: 'outro',
      user: 'leitor',
    });

    const first = await chat({ databaseId, directSql: true, content: 'select 1' });
    const conversationId = (first[0] as { conversationId: string }).conversationId;

    // `undefined` keeps the stored connection
    await chat({ conversationId, directSql: true, content: 'select 2' });
    let list = await t!.api<ConversationDto[]>('GET', '/api/conversations?mode=data');
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ id: conversationId, mode: 'data', databaseId });
    expect(list.json[0]?.messageCount).toBe(4);

    // another connection replaces it
    await chat({
      conversationId,
      databaseId: other.json.id,
      directSql: true,
      content: 'select 3',
    });
    list = await t!.api<ConversationDto[]>('GET', '/api/conversations?mode=data');
    expect(list.json[0]?.databaseId).toBe(other.json.id);

    const chatOnly = await t!.api<ConversationDto[]>('GET', '/api/conversations?mode=chat');
    expect(chatOnly.json).toEqual([]);

    // forking keeps the connection
    const detail = await t!.api<ConversationDetailDto>(
      'GET',
      `/api/conversations/${conversationId}`,
    );
    const assistantId = detail.json.messages.find((m) => m.role === 'assistant')!.id;
    const fork = await t!.api<ConversationDto>(
      'POST',
      `/api/conversations/${conversationId}/fork`,
      {
        messageId: assistantId,
      },
    );
    expect(fork.status).toBe(201);
    expect(fork.json).toMatchObject({ mode: 'data', databaseId: other.json.id });
  });
});

let listening: string | undefined;

/** Streams a data-mode turn over a real socket so the test can answer an `ai_review` mid-stream. */
async function streamTurn(
  payload: Record<string, unknown>,
  onEvent: (event: Record<string, unknown>) => Promise<void>,
) {
  const address = listening ?? (listening = await t!.app.listen({ port: 0, host: '127.0.0.1' }));
  const res = await fetch(`${address}/api/chat`, {
    method: 'POST',
    headers: { cookie: t!.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'data', model: 'groq/llama', ...payload }),
  });
  expect(res.status).toBe(200);
  const events: Record<string, unknown>[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      if (!frame.startsWith('data:')) continue;
      const event = JSON.parse(frame.slice(5).trim()) as Record<string, unknown>;
      events.push(event);
      await onEvent(event);
    }
  }
  return events;
}

describe('chat: data mode, analyst review of unclassified columns', () => {
  const statusQuery = (pg: FakePgGateway) => {
    pg.respond = () => ({
      columns: [
        { name: 'id', type: 'int4', source: { schema: 'public', table: 'cgm', column: 'id' } },
        {
          name: 'situacao',
          type: 'text',
          source: { schema: 'public', table: 'cgm', column: 'situacao' },
        },
      ],
      rows: [
        [1, 'aberto'],
        [2, 'pago'],
      ],
      truncated: false,
      durationMs: 1,
    });
  };

  it('blocks the tool call on ai_review until the analyst answers, then remembers the rule', async () => {
    const fetch = queryThenAnswer('select id, situacao from cgm');
    const pg = new FakePgGateway();
    statusQuery(pg);
    t = await createTestApp({ pgGateway: pg, fetchFn: fetch.fn });
    const created = await t.api<DatabaseConnectionDto>('POST', '/api/databases', {
      name: 'e-Cidade',
      host: 'localhost',
      database: 'ecidade',
      user: 'leitor',
      aiAccess: 'masked',
    });
    await t.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });

    let review: AiReviewDto | undefined;
    const events = await streamTurn(
      { databaseId: created.json.id, content: 'Situação dos cadastros', useMcp: false },
      async (event) => {
        if (event.type !== 'ai_review') return;
        review = event.review as AiReviewDto;
        // nothing reached the model while the review is open
        expect(fetch.calls).toHaveLength(1);
        const bad = await t!.api('POST', `/api/chat/reviews/${review.reviewId}`, {
          decisions: 'x',
        });
        expect(bad.status).toBe(400);
        const ok = await t!.api('POST', `/api/chat/reviews/${review.reviewId}`, {
          decisions: [{ index: 1, action: 'reveal', remember: true }],
        });
        expect(ok.status).toBe(200);
        const again = await t!.api('POST', `/api/chat/reviews/${review.reviewId}`, {
          decisions: [],
        });
        expect(again.status).toBe(404);
      },
    );

    expect(review).toMatchObject({
      databaseId: created.json.id,
      sql: 'select id, situacao from cgm',
      columns: [
        {
          index: 1,
          name: 'situacao',
          type: 'text',
          source: { schema: 'public', table: 'cgm', column: 'situacao' },
          proposed: 'tokenize',
          sample: ['aberto', 'pago'],
        },
      ],
    });
    const types = events.map((e) => e.type);
    expect(types.indexOf('ai_review')).toBeLessThan(types.indexOf('ai_review_closed'));
    expect(events.find((e) => e.type === 'ai_review_closed')).toMatchObject({
      reviewId: review!.reviewId,
      reason: 'answered',
    });
    expect(types.indexOf('ai_review_closed')).toBeLessThan(types.indexOf('tool_result'));
    expect(types.at(-1)).toBe('done');

    const toolMessage = (fetch.calls[1]!.body!.messages as { role: string; content: string }[]).at(
      -1,
    )!;
    expect(toolMessage.content).toContain('aberto');

    const rules = await t.api<ColumnRuleDto[]>('GET', `/api/databases/${created.json.id}/ai-rules`);
    expect(rules.json).toHaveLength(1);
    expect(rules.json[0]).toMatchObject({
      schema: 'public',
      table: 'cgm',
      column: 'situacao',
      action: 'reveal',
      origin: 'analyst',
    });
  });

  it('a remembered rule skips the review next time, and tokenize keeps values from the model', async () => {
    const fetch = queryThenAnswer('select id, situacao from cgm');
    const pg = new FakePgGateway();
    statusQuery(pg);
    t = await createTestApp({ pgGateway: pg, fetchFn: fetch.fn });
    const created = await t.api<DatabaseConnectionDto>('POST', '/api/databases', {
      name: 'e-Cidade',
      host: 'localhost',
      database: 'ecidade',
      user: 'leitor',
      aiAccess: 'masked',
    });
    await t.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });

    const events = await streamTurn(
      { databaseId: created.json.id, content: 'Situação', useMcp: false },
      async (event) => {
        if (event.type !== 'ai_review') return;
        const id = (event.review as AiReviewDto).reviewId;
        await t!.api('POST', `/api/chat/reviews/${id}`, {
          decisions: [{ index: 1, action: 'tokenize', remember: true }],
        });
      },
    );
    const toolMessage = (fetch.calls[1]!.body!.messages as { role: string; content: string }[]).at(
      -1,
    )!;
    expect(toolMessage.content).not.toContain('aberto');
    expect(toolMessage.content).toMatch(/\[VALOR_\d+\]/);
    const toolResult = events.find((e) => e.type === 'tool_result') as { output: string };
    expect(toolResult.output).not.toContain('pago');
    // the screen still received the real rows
    const queryResult = events.find((e) => e.type === 'query_result') as unknown as {
      result: QueryResultDto;
    };
    expect(JSON.stringify(queryResult.result.rows)).toContain('aberto');

    // second turn: remembered rule, no review
    const second = await streamTurn(
      { databaseId: created.json.id, content: 'De novo', useMcp: false },
      async () => {},
    );
    expect(second.some((e) => e.type === 'ai_review')).toBe(false);
    expect(second.some((e) => e.type === 'tool_result')).toBe(true);
  });

  it('answering an unknown review is a 404', async () => {
    t = await createTestApp({ pgGateway: new FakePgGateway() });
    const res = await t.api('POST', '/api/chat/reviews/nao-existe', { decisions: [] });
    expect(res.status).toBe(404);
    const anon = await t.app.inject({
      method: 'POST',
      url: '/api/chat/reviews/x',
      payload: { decisions: [] },
    });
    expect(anon.statusCode).toBe(401);
  });
});
