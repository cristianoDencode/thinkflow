import type { ConversationDetailDto, LibraryDto } from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpGateway, McpServer } from '../../src/contexts/mcp/domain/mcp-server';
import { LIBRARY_TURN_LIMIT_TEXT } from '../../src/contexts/library/domain/tool-format';
import { fakeFetch, multipartBody, sseResponse } from '../helpers';
import { createTestApp, sseEvents, type TestApp } from './test-app';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const TOOL = 'buscar_na_biblioteca';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'llama' };
const frame = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const toolCallResponse = (name: string, args: object, id = 'call_1') =>
  sseResponse([
    frame({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
    frame({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ]);
const textResponse = (text: string) =>
  sseResponse([frame({ content: text }), frame({}, 'stop'), 'data: [DONE]\n\n']);

class FakeMcpGateway implements McpGateway {
  calls: string[] = [];
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
  async callTool(_server: McpServer, tool: string) {
    this.calls.push(tool);
    return { text: 'resultado mcp', isError: false };
  }
  async invalidate() {}
  async closeAll() {}
}

type Message = { role: string; content?: string; tool_call_id?: string };

/** Scripted provider: answers call N with `script[N]` (the last entry repeats). */
async function setup(
  script: (() => Response)[],
  overrides: Parameters<typeof createTestApp>[0] = {},
) {
  let n = 0;
  const fetch = fakeFetch([
    {
      match: (url) => url === GROQ,
      respond: () => script[Math.min(n++, script.length - 1)]!(),
    },
  ]);
  t = await createTestApp({ fetchFn: fetch.fn, ...overrides });
  await t.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
  const created = await t.api<LibraryDto>('POST', '/api/libraries', { name: 'Regras do sistema' });
  const body = await multipartBody([
    {
      name: 'regras.md',
      bytes: '# Aprovação\n\nO prazo de aprovação é de 5 dias úteis para qualquer solicitação.\n',
    },
  ]);
  await t.app.inject({
    method: 'POST',
    url: `/api/libraries/${created.json.id}/documents`,
    headers: { cookie: t.cookie, ...body.headers },
    payload: body.payload,
  });
  await t.container.library.whenIdle();
  return { fetch, libraryId: created.json.id };
}

async function chat(payload: Record<string, unknown>) {
  const res = await t!.app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { cookie: t!.cookie },
    payload: { model: 'groq/llama', content: 'Qual o prazo de aprovação?', ...payload },
  });
  const events = sseEvents(res.body);
  const conversationId = (events[0] as { conversationId: string }).conversationId;
  return { events, conversationId };
}

const toolNames = (body: Record<string, unknown> | null) =>
  ((body?.tools ?? []) as { function: { name: string } }[]).map((x) => x.function.name);
const messagesOf = (body: Record<string, unknown> | null) => (body?.messages ?? []) as Message[];

describe('chat with a library', () => {
  it('injects the tool and system note, returns excerpts with the document name, and persists', async () => {
    const { fetch, libraryId } = await setup([
      () => toolCallResponse(TOOL, { consulta: 'prazo aprovação' }),
      () => textResponse('São 5 dias úteis (regras.md).'),
    ]);
    const { events, conversationId } = await chat({ libraryId, useMcp: false });

    const first = fetch.calls[0]!.body;
    expect(toolNames(first)).toEqual([TOOL]);
    expect(messagesOf(first)[0]!.content).toContain('Biblioteca conectada: «Regras do sistema»');

    const toolMessage = messagesOf(fetch.calls[1]!.body).find((m) => m.role === 'tool')!;
    expect(toolMessage.content).toContain('regras.md');
    expect(toolMessage.content).toContain('5 dias úteis');
    expect(toolMessage.content!.length).toBeLessThanOrEqual(6000);

    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', name: TOOL }));
    expect(events.at(-1)?.type).toBe('done');

    const detail = await t!.api<ConversationDetailDto>(
      'GET',
      `/api/conversations/${conversationId}`,
    );
    expect(detail.json.libraryId).toBe(libraryId);
    const assistant = detail.json.messages.at(-1)!;
    expect(assistant.meta.library).toEqual({ id: libraryId, name: 'Regras do sistema' });
    expect(assistant.meta.toolCalls?.[0]?.output).toContain('regras.md');
  });

  it('keeps the library across turns when the field is omitted and clears it with null', async () => {
    const { fetch, libraryId } = await setup([() => textResponse('ok')]);
    const first = await chat({ libraryId, useMcp: false });
    expect(toolNames(fetch.calls[0]!.body)).toEqual([TOOL]);

    await chat({ conversationId: first.conversationId, useMcp: false });
    expect(toolNames(fetch.calls[1]!.body)).toEqual([TOOL]);
    // a reload shows the same library
    expect(
      (await t!.api<ConversationDetailDto>('GET', `/api/conversations/${first.conversationId}`))
        .json.libraryId,
    ).toBe(libraryId);

    await chat({ conversationId: first.conversationId, useMcp: false, libraryId: null });
    expect(toolNames(fetch.calls[2]!.body)).toEqual([]);
    expect(messagesOf(fetch.calls[2]!.body)[0]!.content).not.toContain('Biblioteca conectada');
    expect(
      (await t!.api<ConversationDetailDto>('GET', `/api/conversations/${first.conversationId}`))
        .json.libraryId,
    ).toBeNull();

    // a plain turn without any library never offers the tool
    await chat({ useMcp: false });
    expect(toolNames(fetch.calls[3]!.body)).toEqual([]);
  });

  it('copies the library to forks', async () => {
    const { libraryId } = await setup([() => textResponse('ok')]);
    const { conversationId } = await chat({ libraryId, useMcp: false });
    const detail = await t!.api<ConversationDetailDto>(
      'GET',
      `/api/conversations/${conversationId}`,
    );
    const fork = await t!.api<{ libraryId: string | null }>(
      'POST',
      `/api/conversations/${conversationId}/fork`,
      { messageId: detail.json.messages.at(-1)!.id },
    );
    expect(fork.json.libraryId).toBe(libraryId);
  });

  it('combines the library tool with MCP tools', async () => {
    const mcp = new FakeMcpGateway();
    const { fetch, libraryId } = await setup(
      [
        () => toolCallResponse('mcp__docs__lookup', { q: 'x' }, 'call_mcp'),
        () => toolCallResponse(TOOL, { consulta: 'prazo' }, 'call_lib'),
        () => textResponse('pronto'),
      ],
      { mcpGateway: mcp },
    );
    await t!.api('POST', '/api/mcp', {
      transport: 'http',
      name: 'docs',
      url: 'http://localhost:9/mcp',
    });
    const { events } = await chat({ libraryId, useMcp: true });

    expect(toolNames(fetch.calls[0]!.body).sort()).toEqual([TOOL, 'mcp__docs__lookup']);
    expect(mcp.calls).toEqual(['lookup']);
    const results = events.filter((e) => e.type === 'tool_result') as { name: string }[];
    expect(results.map((r) => r.name)).toEqual(['mcp__docs__lookup', TOOL]);
    const last = messagesOf(fetch.calls[2]!.body).filter((m) => m.role === 'tool');
    expect(last.map((m) => m.content)).toEqual([
      'resultado mcp',
      expect.stringContaining('regras.md'),
    ]);

    // MCP off: only the library tool is offered
    await chat({ libraryId, useMcp: false });
    expect(toolNames(fetch.calls[3]!.body)).toEqual([TOOL]);
  });

  it('limits library calls per turn', async () => {
    const calls = [1, 2, 3, 4, 5].map(
      (i) => () => toolCallResponse(TOOL, { consulta: `prazo ${i}` }, `call_${i}`),
    );
    const { fetch, libraryId } = await setup([...calls, () => textResponse('fim')]);
    const { events } = await chat({ libraryId, useMcp: false });
    const results = events.filter((e) => e.type === 'tool_result') as { output: string }[];
    expect(results).toHaveLength(5);
    expect(results.slice(0, 4).every((r) => !r.output.includes(LIBRARY_TURN_LIMIT_TEXT))).toBe(
      true,
    );
    expect(results[4]!.output).toBe(LIBRARY_TURN_LIMIT_TEXT);
    expect(events.at(-1)?.type).toBe('done');
    expect(fetch.calls).toHaveLength(6);
  });

  it('falls back with a notice when the library was deleted', async () => {
    const { fetch, libraryId } = await setup([() => textResponse('ok')]);
    const first = await chat({ libraryId, useMcp: false });
    await t!.api('DELETE', `/api/libraries/${libraryId}`);
    const second = await chat({ conversationId: first.conversationId, useMcp: false });
    expect(toolNames(fetch.calls[1]!.body)).toEqual([]);
    expect(second.events).toContainEqual({
      type: 'reasoning',
      text: 'A biblioteca conectada não foi encontrada; seguindo sem biblioteca.',
    });
    expect(
      (await t!.api<ConversationDetailDto>('GET', `/api/conversations/${first.conversationId}`))
        .json.libraryId,
    ).toBeNull();
  });

  it('caps tool output by the context budget', async () => {
    const { fetch, libraryId } = await setup([
      () => toolCallResponse(TOOL, { consulta: 'prazo' }),
      () => textResponse('ok'),
    ]);
    await t!.api('PUT', '/api/settings', { history: { contextBudgetTokens: 2000 } });
    await chat({ libraryId, useMcp: false });
    const tool = messagesOf(fetch.calls[1]!.body).find((m) => m.role === 'tool')!;
    expect(tool.content!.length).toBeLessThanOrEqual(Math.floor(2000 * 4 * 0.25));
    expect(tool.content).toContain('regras.md');
  });

  it('ignores the library in agent mode', async () => {
    const seen: unknown[] = [];
    const { libraryId } = await setup([() => textResponse('ok')], {
      agentRunner: {
        run: async (params) => {
          seen.push(params);
          return {
            sessionId: 's',
            text: 'ok',
            toolCalls: [],
            costUsd: null,
            inputTokens: null,
            outputTokens: null,
          };
        },
      },
    });
    const { events } = await chat({
      mode: 'agent',
      model: 'thinkflow/default',
      libraryId,
      agent: { permissionMode: 'plan', cwd: '/tmp' },
    });
    expect(events.at(-1)?.type).toBe('done');
    expect(seen).toHaveLength(1);
  });
});
