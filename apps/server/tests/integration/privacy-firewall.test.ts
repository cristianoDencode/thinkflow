import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ConversationDetailDto, ConversationDto, SettingsDto } from '@thinkflow/shared';
import { ClaudeAgentRunner } from '../../src/contexts/chat/infrastructure/claude-agent-runner';
import { GatewayService } from '../../src/contexts/gateway/application/gateway-service';
import type { RouteOptions } from '../../src/contexts/routing/application/route-chat-request';
import { piiVault } from '../../src/shared/infrastructure/db/schema';
import { fakeFetch, openAIFrames, sseResponse } from '../helpers';
import { createTestApp, sseEvents, type TestApp } from './test-app';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const CPF = '529.982.247-25';
const NAME = 'JOAO DA SILVA';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A reply that writes tokens split across SSE chunks. */
function tokenReply(): Response {
  const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm' };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return sseResponse([
    chunk({ role: 'assistant', content: '' }),
    chunk({ content: 'Anotei o CPF [CP' }),
    chunk({ content: 'F_1] de [NOME_1].' }),
    chunk({}, 'stop'),
    'data: [DONE]\n\n',
  ]);
}

async function setup(reply: () => Response = tokenReply) {
  const fetch = fakeFetch([{ match: (u) => u === GROQ, respond: reply }]);
  t = await createTestApp({ fetchFn: fetch.fn });
  await t.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
  return { app: t, fetch };
}

async function chat(app: TestApp, content: string, extra: Record<string, unknown> = {}) {
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { cookie: app.cookie },
    payload: { model: 'groq/llama', content, ...extra },
  });
  return sseEvents(res.body);
}

const sent = (body: Record<string, unknown> | null) => JSON.stringify(body ?? {});

describe('privacy firewall in the chat', () => {
  it('sends tokens, shows and stores real values, and re-tokenizes the next turn', async () => {
    const { app, fetch } = await setup();
    const events = await chat(app, `Cadastre ${NAME}, CPF ${CPF}`);
    const conversationId = (events[0] as { conversationId: string }).conversationId;

    // what the provider received
    expect(sent(fetch.calls[0]!.body)).not.toContain(CPF);
    expect(sent(fetch.calls[0]!.body)).not.toContain(NAME);
    expect(sent(fetch.calls[0]!.body)).toContain('[CPF_1]');

    // what the analyst saw (SSE) and what was stored
    const shown = events
      .filter((e) => e.type === 'delta')
      .map((e) => String(e.text))
      .join('');
    expect(shown).toBe(`Anotei o CPF ${CPF} de ${NAME}.`);
    const detail = await app.api<ConversationDetailDto>(
      'GET',
      `/api/conversations/${conversationId}`,
    );
    expect(detail.json.messages.at(-1)?.content).toBe(`Anotei o CPF ${CPF} de ${NAME}.`);

    // next turn replays the (real) history: the provider still only sees tokens
    await chat(app, 'E agora?', { conversationId });
    const second = sent(fetch.calls[1]!.body);
    expect(second).not.toContain(CPF);
    expect(second).not.toContain(NAME);
    expect(second).toContain('[CPF_1]');
  });

  it('can be switched off in the settings (and warns by default being on)', async () => {
    const { app, fetch } = await setup(() => sseResponse(openAIFrames('ok')));
    const before = await app.api<SettingsDto>('GET', '/api/settings');
    expect(before.json.privacy).toEqual({ enabled: true, presidioUrl: '', minScore: 0.5 });
    const off = await app.api<SettingsDto>('PUT', '/api/settings', { privacy: { enabled: false } });
    expect(off.json.privacy.enabled).toBe(false);
    await chat(app, `CPF ${CPF}`);
    expect(sent(fetch.calls[0]!.body)).toContain(CPF);
  });

  it('a fork gets the parent tokens (same numbers) and deleting the conversation forgets them', async () => {
    const { app } = await setup();
    const events = await chat(app, `Cadastre ${NAME}, CPF ${CPF}`);
    const id = (events[0] as { conversationId: string }).conversationId;
    const detail = await app.api<ConversationDetailDto>('GET', `/api/conversations/${id}`);
    const forked = await app.api<ConversationDto>('POST', `/api/conversations/${id}/fork`, {
      messageId: detail.json.messages.at(-1)!.id,
    });
    expect(forked.status).toBe(201);
    const rows = (scope: string) =>
      app.db.select().from(piiVault).where(eq(piiVault.scopeId, scope)).all().length;
    expect(rows(id)).toBeGreaterThan(0);
    expect(rows(forked.json.id)).toBe(rows(id));
    await app.api('DELETE', `/api/conversations/${id}`);
    expect(rows(id)).toBe(0);
    expect(rows(forked.json.id)).toBeGreaterThan(0);
  });
});

describe('privacy firewall in the /v1 gateway', () => {
  it('tokenizes upstream and restores text for the client', async () => {
    const { app, fetch } = await setup();
    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-api-key': app.apiKey },
      payload: { model: 'groq/llama', messages: [{ role: 'user', content: `${NAME} ${CPF}` }] },
    });
    expect(res.statusCode).toBe(200);
    expect(sent(fetch.calls[0]!.body)).not.toContain(CPF);
    const content = (res.json() as { choices: { message: { content: string } }[] }).choices[0]!
      .message.content;
    expect(content).toBe(`Anotei o CPF ${CPF} de ${NAME}.`);
  });

  it('honors the scope header only for the internal agent key', async () => {
    const calls: RouteOptions[] = [];
    const router = {
      execute: async (_r: unknown, options: RouteOptions) => {
        calls.push(options);
        return {
          ok: false,
          status: 500,
          reason: 'x',
          message: 'x',
          attempts: [],
          retryable: false,
        };
      },
    };
    const gateway = new GatewayService(router as never, {} as never);
    const abort = new AbortController();
    const body = { model: 'm', messages: [] };

    await gateway.open('openai', body, {}, abort.signal, {
      apiKey: 'tf_internal',
      internal: true,
      scopeHeader: 'conv-9',
    });
    await gateway.open('openai', body, {}, abort.signal, {
      apiKey: 'tf_user',
      internal: false,
      scopeHeader: 'conv-9',
    });
    await gateway.open('openai', body, {}, abort.signal, { apiKey: 'tf_user' });
    await gateway.open('openai', body, {}, abort.signal, { apiKey: 'tf_user' });

    expect(calls[0]!.privacy).toEqual({ scope: 'conv-9', restoreToolArgs: true });
    expect(calls[1]!.privacy?.scope).toBeUndefined(); // a user key can never name a persistent scope
    expect(calls[1]!.privacy?.vault).toBeDefined();
    expect(calls[1]!.privacy?.restoreToolArgs).toBe(true);
    // same client, same in-memory vault; the header value is a different namespace
    expect(calls[3]!.privacy?.vault).toBe(calls[2]!.privacy?.vault);
    expect(calls[1]!.privacy?.vault).not.toBe(calls[2]!.privacy?.vault);
  });

  it('recognizes only keys issued as internal', async () => {
    const { app } = await setup();
    const auth = app.container.auth;
    const internal = auth.issueInternalKey();
    expect(auth.isInternalKey(internal)).toBe(true);
    expect(auth.isInternalKey(app.apiKey)).toBe(false);
    expect(auth.isInternalKey(undefined)).toBe(false);
  });
});

describe('agent runner', () => {
  it('names the conversation scope for the gateway', async () => {
    let env: Record<string, string | undefined> | undefined;
    const runner = new ClaudeAgentRunner({
      baseUrl: () => 'http://127.0.0.1:1',
      apiKey: () => 'tf_internal',
      queryFn: (({ options }: { options: { env: Record<string, string | undefined> } }) => {
        env = options.env;
        return (async function* () {})();
      }) as never,
    });
    await runner.run(
      {
        conversationId: 'conv-1',
        prompt: 'oi',
        model: 'm',
        sessionId: null,
        permissionMode: 'plan',
        cwd: '/tmp',
        mcpServers: [],
      },
      () => undefined,
    );
    expect(env?.ANTHROPIC_CUSTOM_HEADERS).toBe('x-thinkflow-privacy-scope: conv-1');
  });
});
