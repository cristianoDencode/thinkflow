import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationDetailDto, McpServerDto, McpTestResultDto } from '@thinkflow/shared';
import type { AgentRunner } from '../../src/contexts/chat/domain/conversation';
import type { McpGateway, McpServer } from '../../src/contexts/mcp/domain/mcp-server';
import { McpClientPool } from '../../src/contexts/mcp/infrastructure/mcp-client-pool';
import { fakeFetch, sseResponse } from '../helpers';
import { createTestApp, sseEvents, type TestApp } from './test-app';

const here = path.dirname(fileURLToPath(import.meta.url));
const ECHO_SERVER = path.resolve(here, '../fixtures/echo-mcp-server.mjs');
const GROQ = 'https://api.groq.com/openai/v1/chat/completions';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'llama' };
const frame = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

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
    return { text: 'resultado da busca', isError: false };
  }
  async invalidate() {}
  async closeAll() {}
}

describe('McpClientPool (real stdio server)', () => {
  it('lists and calls tools of a stdio MCP server', async () => {
    const pool = new McpClientPool();
    const server: McpServer = {
      id: 's1',
      name: 'echo',
      enabled: true,
      createdAt: 0,
      config: { transport: 'stdio', command: process.execPath, args: [ECHO_SERVER], env: {} },
    };
    try {
      const tools = await pool.listTools(server);
      expect(tools.map((x) => x.name).sort()).toEqual(['echo', 'fail']);
      expect(await pool.callTool(server, 'echo', { text: 'oi' })).toEqual({
        text: 'echo: oi',
        isError: false,
      });
      expect((await pool.callTool(server, 'fail', {})).isError).toBe(true);
    } finally {
      await pool.closeAll();
    }
  });
});

describe('MCP API', () => {
  it('creates, tests, toggles and hides secrets of MCP servers', async () => {
    t = await createTestApp();
    const created = await t.api<McpServerDto>('POST', '/api/mcp', {
      transport: 'stdio',
      name: 'echo',
      command: process.execPath,
      args: [ECHO_SERVER],
      env: { SECRET_TOKEN: 'sEcReT-xyz-123' },
    });
    expect(created.status).toBe(201);
    expect(created.json.envKeys).toEqual(['SECRET_TOKEN']);
    expect(JSON.stringify(created.json)).not.toContain('sEcReT-xyz-123');

    const tested = await t.api<McpTestResultDto>('POST', `/api/mcp/${created.json.id}/test`);
    expect(tested.json.ok).toBe(true);
    expect(tested.json.tools.map((x) => x.name)).toContain('echo');

    const toggled = await t.api<McpServerDto>('PATCH', `/api/mcp/${created.json.id}/enabled`, {
      enabled: false,
    });
    expect(toggled.json.enabled).toBe(false);

    const duplicate = await t.api('POST', '/api/mcp', {
      transport: 'http',
      name: 'echo',
      url: 'http://localhost:9/mcp',
    });
    expect(duplicate.status).toBe(409);
  });
});

describe('chat', () => {
  it('runs a tool loop with MCP tools and persists the conversation', async () => {
    let call = 0;
    const fetch = fakeFetch([
      {
        match: (url) => url === GROQ,
        respond: () =>
          ++call === 1
            ? sseResponse([
                frame({
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'mcp__docs__lookup', arguments: '{"q":' },
                    },
                  ],
                }),
                frame({ tool_calls: [{ index: 0, function: { arguments: '"ddd"}' } }] }),
                frame({}, 'tool_calls'),
                'data: [DONE]\n\n',
              ])
            : sseResponse([
                frame({ content: 'Segundo a busca, ' }),
                frame({ content: 'DDD é ótimo.' }),
                frame({}, 'stop'),
                'data: [DONE]\n\n',
              ]),
      },
    ]);
    const mcp = new FakeMcpGateway();
    t = await createTestApp({ fetchFn: fetch.fn, mcpGateway: mcp });
    await t.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
    await t.api('POST', '/api/mcp', {
      transport: 'http',
      name: 'docs',
      url: 'http://localhost:9/mcp',
    });

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: t.cookie },
      payload: { model: 'groq/llama', content: 'O que é DDD?' },
    });
    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.body);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('conversation');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types.at(-1)).toBe('done');
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('Segundo a busca, DDD é ótimo.');
    expect(events).toContainEqual({ type: 'step', step: 'search', status: 'done' });
    expect(mcp.calls).toEqual([{ tool: 'lookup', args: { q: 'ddd' } }]);

    // second request carried the tool result back to the model
    const second = fetch.calls[1]!.body!.messages as { role: string; content: string }[];
    expect(second.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'resultado da busca',
    });
    expect((fetch.calls[0]!.body!.tools as unknown[]).length).toBe(1);

    const conversationId = (events[0] as { conversationId: string }).conversationId;
    const detail = await t.api<ConversationDetailDto>(
      'GET',
      `/api/conversations/${conversationId}`,
    );
    expect(detail.json.title).toBe('O que é DDD?');
    expect(detail.json.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.json.messages[1]?.meta.toolCalls?.[0]?.output).toBe('resultado da busca');

    const fb = await t.api('POST', `/api/messages/${detail.json.messages[1]!.id}/feedback`, {
      feedback: 'up',
    });
    expect(fb.status).toBe(200);
  });

  it('reports routing errors as stream events', async () => {
    t = await createTestApp({ fetchFn: fakeFetch([]).fn });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: t.cookie },
      payload: { model: 'groq/llama', content: 'oi' },
    });
    const events = sseEvents(res.body);
    expect(events.find((e) => e.type === 'error')?.message).toMatch(/Nenhuma conexão/);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('delegates agent mode to the agent runner and keeps the session id', async () => {
    const seen: unknown[] = [];
    const agent: AgentRunner = {
      run: async (params, emit) => {
        seen.push(params);
        emit({ type: 'tool_call', id: 't1', name: 'Read', input: { file: 'a' } });
        emit({ type: 'tool_result', id: 't1', name: 'Read', output: 'conteúdo', isError: false });
        emit({ type: 'delta', text: 'Plano pronto' });
        return {
          sessionId: 'sess-1',
          text: 'Plano pronto',
          toolCalls: [],
          costUsd: 0.01,
          inputTokens: 10,
          outputTokens: 2,
        };
      },
    };
    t = await createTestApp({ agentRunner: agent });
    const first = await t.app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: t.cookie },
      payload: {
        mode: 'agent',
        model: 'thinkflow/default',
        content: 'Planeje',
        agent: { permissionMode: 'plan', cwd: '/tmp' },
      },
    });
    const events = sseEvents(first.body);
    expect(events.at(-1)).toMatchObject({ type: 'done', costUsd: 0.01 });
    const conversationId = (events[0] as { conversationId: string }).conversationId;

    await t.app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: t.cookie },
      payload: { conversationId, mode: 'agent', model: 'thinkflow/default', content: 'Continue' },
    });
    expect(seen[0]).toMatchObject({ sessionId: null, permissionMode: 'plan', cwd: '/tmp' });
    // cwd and permission mode come from what was stored on the conversation
    expect(seen[1]).toMatchObject({ sessionId: 'sess-1', permissionMode: 'plan', cwd: '/tmp' });
  });

  describe('agent continuation', () => {
    interface Run {
      sessionId: string | null;
      prompt: string;
      cwd: string;
    }
    const setup = async (
      onRun: (params: Run, n: number) => { sessionId: string | null; error?: string },
      extra: Partial<AgentRunner> = {},
    ) => {
      const runs: Run[] = [];
      const agent: AgentRunner = {
        run: async (params, emit) => {
          runs.push({ sessionId: params.sessionId, prompt: params.prompt, cwd: params.cwd });
          const r = onRun(params, runs.length);
          if (!r.error) emit({ type: 'delta', text: `resposta ${runs.length}` });
          return {
            sessionId: r.sessionId,
            text: r.error ? '' : `resposta ${runs.length}`,
            toolCalls: [],
            costUsd: null,
            inputTokens: null,
            outputTokens: null,
            ...(r.error ? { error: r.error } : {}),
          };
        },
        ...extra,
      };
      t = await createTestApp({ agentRunner: agent });
      const send = async (payload: Record<string, unknown>) => {
        const res = await t!.app.inject({
          method: 'POST',
          url: '/api/chat',
          headers: { cookie: t!.cookie },
          payload: { mode: 'agent', model: 'thinkflow/default', ...payload },
        });
        return sseEvents(res.body);
      };
      return { runs, send };
    };
    const idOf = (events: Record<string, unknown>[]) => events[0]!.conversationId as string;

    it('seeds a fresh session after a model switch and drops the old one', async () => {
      const { runs, send } = await setup(() => ({ sessionId: 'sess-1' }));
      const id = idOf(
        await send({
          content: 'primeira pergunta',
          agent: { permissionMode: 'plan', cwd: '/tmp' },
        }),
      );
      await send({ conversationId: id, content: 'segunda', model: 'groq/outro' });
      expect(runs[0]!.prompt).toBe('primeira pergunta'); // nothing to carry yet
      expect(runs[1]).toMatchObject({ sessionId: null, cwd: '/tmp' });
      expect(runs[1]!.prompt).toContain('<contexto_anterior>');
      expect(runs[1]!.prompt).toContain('primeira pergunta');
      expect(runs[1]!.prompt).toContain('resposta 1');
      expect(runs[1]!.prompt.endsWith('segunda')).toBe(true);
      // the stored user message stays plain
      const detail = await t!.app.inject({
        method: 'GET',
        url: `/api/conversations/${id}`,
        headers: { cookie: t!.cookie },
      });
      const stored = (detail.json() as ConversationDetailDto).messages.map((m) => m.content);
      expect(stored).toContain('segunda');
    });

    it('starts over when the working directory changes', async () => {
      const { runs, send } = await setup(() => ({ sessionId: 'sess-1' }));
      const id = idOf(
        await send({ content: 'um', agent: { permissionMode: 'plan', cwd: '/tmp' } }),
      );
      await send({
        conversationId: id,
        content: 'dois',
        agent: { permissionMode: 'plan', cwd: '/var' },
      });
      expect(runs[1]).toMatchObject({ sessionId: null, cwd: '/var' });
      expect(runs[1]!.prompt).toContain('<contexto_anterior>');
    });

    it('recovers when Claude Code no longer finds the session', async () => {
      const { runs, send } = await setup((params, n) =>
        params.sessionId === 'sess-1'
          ? { sessionId: 'sess-1', error: 'No conversation found with session ID: sess-1' }
          : { sessionId: n === 1 ? 'sess-1' : 'sess-2' },
      );
      const id = idOf(
        await send({ content: 'um', agent: { permissionMode: 'plan', cwd: '/tmp' } }),
      );
      const events = await send({ conversationId: id, content: 'dois' });
      expect(runs).toHaveLength(3);
      expect(runs[1]!.sessionId).toBe('sess-1');
      expect(runs[2]!.sessionId).toBeNull();
      expect(runs[2]!.prompt).toContain('<contexto_anterior>');
      expect(events.some((e) => e.type === 'error')).toBe(false);
      expect(
        events.find((e) => e.type === 'reasoning' && /Sessão anterior/.test(String(e.text))),
      ).toBeTruthy();
      const detail = await t!.app.inject({
        method: 'GET',
        url: `/api/conversations/${id}`,
        headers: { cookie: t!.cookie },
      });
      expect((detail.json() as ConversationDetailDto).messages.at(-1)?.content).toBe('resposta 3');
      // the new session is the one resumed next
      await send({ conversationId: id, content: 'tres' });
      expect(runs[3]!.sessionId).toBe('sess-2');
    });

    it('does not retry other agent errors', async () => {
      const { runs, send } = await setup((_p, n) =>
        n === 1 ? { sessionId: 'sess-1' } : { sessionId: 'sess-1', error: 'Prompt is too long' },
      );
      const id = idOf(
        await send({ content: 'um', agent: { permissionMode: 'plan', cwd: '/tmp' } }),
      );
      const events = await send({ conversationId: id, content: 'dois' });
      expect(runs).toHaveLength(2);
      expect(events.find((e) => e.type === 'error')?.message).toBe('Prompt is too long');
    });

    it('forgets the agent session when the conversation is deleted', async () => {
      const removed: [string, string][] = [];
      const { send } = await setup(() => ({ sessionId: 'sess-1' }), {
        deleteSession: async (sessionId, cwd) => {
          removed.push([sessionId, cwd]);
        },
      });
      const id = idOf(
        await send({ content: 'um', agent: { permissionMode: 'plan', cwd: '/tmp' } }),
      );
      const res = await t!.app.inject({
        method: 'DELETE',
        url: `/api/conversations/${id}`,
        headers: { cookie: t!.cookie },
      });
      expect(res.statusCode).toBeLessThan(300);
      await new Promise((r) => setTimeout(r, 10));
      expect(removed).toEqual([['sess-1', '/tmp']]);
    });
  });
});
