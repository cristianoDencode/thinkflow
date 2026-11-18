import { describe, expect, it } from 'vitest';
import { providerCatalog } from '../../src/contexts/connections/domain/provider-catalog';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  HttpProviderExecutor,
} from '../../src/contexts/routing/infrastructure/http-provider-executor';
import { classifyFailure } from '../../src/contexts/routing/domain/error-classifier';
import {
  decideCooldown,
  AUTH_COOLDOWN_MS,
} from '../../src/contexts/routing/domain/cooldown-policy';
import type { ResolvedTarget } from '../../src/contexts/routing/domain/types';
import { fakeFetch, makeConnection, sseResponse } from '../helpers';

const target = (providerId: string, model = 'm'): ResolvedTarget => ({
  provider: providerCatalog.get(providerId)!,
  connection: makeConnection({ id: `${providerId}-1`, providerId }),
  model,
});

const history = (extra?: Record<string, unknown>) => ({
  format: 'openai' as const,
  body: {
    model: 'x',
    messages: [
      { role: 'user', content: 'oi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'listar_tabelas', arguments: '{}' },
            ...(extra ? { extra_content: extra } : {}),
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ],
  },
});

const sentCall = (calls: { body: Record<string, unknown> | null }[]) =>
  (calls[0]!.body!.messages as { tool_calls?: Record<string, unknown>[] }[])[1]!.tool_calls![0]!;

const okStream = () =>
  sseResponse(['data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n', 'data: [DONE]\n\n']);

describe('HttpProviderExecutor tool-call history', () => {
  it('strips extra_content from replayed tool calls', async () => {
    const f = fakeFetch([{ match: () => true, respond: okStream }]);
    await new HttpProviderExecutor(f.fn).execute(
      target('groq'),
      history({ google: { thought_signature: 'REAL==' } }),
    );
    expect(sentCall(f.calls)).not.toHaveProperty('extra_content');
  });

  it('disables DeepSeek thinking when tools are present', async () => {
    const f = fakeFetch([{ match: () => true, respond: okStream }]);
    const request = history();
    (request.body as Record<string, unknown>).tools = [
      { type: 'function', function: { name: 'f' } },
    ];
    await new HttpProviderExecutor(f.fn).execute(target('deepseek'), request);
    expect(f.calls[0]!.body!.thinking).toEqual({ type: 'disabled' });
    const g = fakeFetch([{ match: () => true, respond: okStream }]);
    await new HttpProviderExecutor(g.fn).execute(target('deepseek'), history());
    expect(g.calls[0]!.body).not.toHaveProperty('thinking');
  });

  it('does not mutate the caller request', async () => {
    const f = fakeFetch([{ match: () => true, respond: okStream }]);
    const request = history();
    const snapshot = JSON.stringify(request);
    await new HttpProviderExecutor(f.fn).execute(target('groq'), request);
    expect(JSON.stringify(request)).toBe(snapshot);
  });
});

describe('HttpProviderExecutor responses', () => {
  it('waits 45 s for the first byte by default', () => {
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(45_000);
  });

  it('reports a connect timeout as a timeout failure', async () => {
    const fetchFn = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const result = await new HttpProviderExecutor(fetchFn, { connectTimeoutMs: 5 }).execute(
      target('nvidia'),
      history(),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { status: null, kind: 'timeout', message: 'Timeout ao conectar no provider' },
    });
  });

  it('turns a 200 text/plain "OK" into a precise, long-cooldown failure', async () => {
    const f = fakeFetch([
      {
        match: () => true,
        respond: () =>
          new Response('OK\r\n', { status: 200, headers: { 'content-type': 'text/plain' } }),
      },
    ]);
    const result = await new HttpProviderExecutor(f.fn).execute(target('openrouter'), history());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe(
      'Resposta inesperada do provider (text/plain: "OK") em vez de JSON/SSE — verifique o token e as permissões da conexão',
    );
    const classification = classifyFailure(result.failure);
    expect(classification).toMatchObject({ reason: 'invalid_response', scope: 'connection' });
    const decision = decideCooldown(classification, { backoffLevel: 0 }, 1000);
    expect(decision?.cooldownUntil).toBe(1000 + AUTH_COOLDOWN_MS);
  });

  it('still accepts a JSON body from a provider that ignores stream: true', async () => {
    const completion = {
      id: 'c',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'oi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const f = fakeFetch([
      {
        match: () => true,
        respond: () =>
          new Response(JSON.stringify(completion), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    ]);
    const result = await new HttpProviderExecutor(f.fn).execute(target('groq'), history());
    expect(result.ok).toBe(true);
  });
});
