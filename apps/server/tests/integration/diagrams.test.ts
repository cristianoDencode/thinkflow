import { afterEach, describe, expect, it } from 'vitest';
import { DIAGRAM_PROMPT_RULES, hashDiagram, type ConversationDetailDto } from '@thinkflow/shared';
import { fakeFetch, openAIFrames, sseResponse } from '../helpers';
import { createTestApp, sseEvents, type TestApp } from './test-app';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const BROKEN = 'flowchart TD\nA[Início (x)] --> B';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function setup(reply: (body: { messages: { role: string; content: string }[] }) => string) {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  let current = '';
  const fetch = fakeFetch([
    {
      match: (url, body) => {
        if (url !== GROQ) return false;
        const parsed = body as unknown as { messages: { role: string; content: string }[] };
        bodies.push(parsed);
        current = reply(parsed);
        return true;
      },
      respond: () => sseResponse(openAIFrames(current)),
    },
  ]);
  t = await createTestApp({ fetchFn: fetch.fn });
  await t.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
  return { app: t, bodies };
}

async function chat(app: TestApp, content: string) {
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { cookie: app.cookie },
    payload: { model: 'groq/llama', content },
  });
  const events = sseEvents(res.body) as {
    type?: string;
    conversationId?: string;
    messageId?: string;
  }[];
  return {
    conversationId: events[0]!.conversationId!,
    messageId: events.find((e) => e.type === 'done')!.messageId!,
  };
}

describe('diagrams', () => {
  it('adds the diagram rules to the system prompt and normalizes the saved answer', async () => {
    const { app, bodies } = await setup(() => 'Segue:\nflowchart TD\nA[Início (x)] --> B\nFim.');
    const { conversationId } = await chat(app, 'faça um diagrama');
    expect(bodies[0]!.messages[0]!.content).toContain(DIAGRAM_PROMPT_RULES);
    const detail = await app.api<ConversationDetailDto>(
      'GET',
      `/api/conversations/${conversationId}`,
    );
    const answer = detail.json.messages.find((m) => m.role === 'assistant')!;
    expect(answer.content).toContain('```mermaid');
    expect(answer.content).toContain('A["Início (x)"]');
  });

  it('repairs a diagram, records the usage source and caches it in the message meta', async () => {
    const { app, bodies } = await setup((body) =>
      body.messages[0]!.content.startsWith('Você corrige diagramas')
        ? '```mermaid\nflowchart TD\nA["Início x"] --> B\n```'
        : 'resposta comum',
    );
    const { conversationId, messageId } = await chat(app, 'oi');
    const res = await app.api<{ code: string | null; repaired: boolean }>(
      'POST',
      '/api/diagrams/repair',
      { code: BROKEN, error: 'Parse error', model: 'groq/llama', messageId },
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ code: 'flowchart TD\nA["Início x"] --> B', repaired: true });
    expect(bodies.at(-1)!.messages[1]!.content).toContain('Parse error');

    const detail = await app.api<ConversationDetailDto>(
      'GET',
      `/api/conversations/${conversationId}`,
    );
    const meta = detail.json.messages.find((m) => m.id === messageId)!.meta;
    expect(meta.diagramRepairs).toEqual({
      [hashDiagram(BROKEN)]: 'flowchart TD\nA["Início x"] --> B',
    });

    const usage = await app.api<{ bySource: { source: string }[] }>('GET', '/api/usage');
    expect(JSON.stringify(usage.json)).toContain('diagram-repair');
  });

  it('stores null when the model cannot repair and validates input', async () => {
    const { app } = await setup((body) =>
      body.messages[0]!.content.startsWith('Você corrige') ? 'não sei' : 'ok',
    );
    const { messageId } = await chat(app, 'oi');
    const res = await app.api<{ code: string | null; repaired: boolean }>(
      'POST',
      '/api/diagrams/repair',
      { code: BROKEN, error: '', model: 'groq/llama', messageId },
    );
    expect(res.json).toEqual({ code: null, repaired: false });
    expect((await app.api('POST', '/api/diagrams/repair', { code: '', model: 'x' })).status).toBe(
      400,
    );
  });

  it('rate-limits repairs to 20 per minute', async () => {
    const { app } = await setup(() => 'não sei');
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (
        await app.api('POST', '/api/diagrams/repair', {
          code: BROKEN,
          error: '',
          model: 'groq/llama',
        })
      ).status;
    }
    expect(last).toBe(429);
  });
});
