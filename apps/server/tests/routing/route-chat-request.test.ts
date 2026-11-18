import { describe, expect, it } from 'vitest';
import { RouteChatRequest } from '../../src/contexts/routing/application/route-chat-request';
import type { ProviderExecutor } from '../../src/contexts/routing/domain/ports';
import {
  UpstreamStreamError,
  type ExecutionResult,
  type ResolvedTarget,
  type UpstreamEvent,
} from '../../src/contexts/routing/domain/types';
import { FakeClock } from '../../src/shared/kernel/clock';
import {
  InMemoryComboRepository,
  InMemoryConnectionRepository,
  InMemoryLogRepository,
  collect,
  makeCombo,
  makeConnection,
  seqIds,
} from '../helpers';

type Behaviour = ExecutionResult | (() => ExecutionResult);

class ScriptedExecutor implements ProviderExecutor {
  readonly calls: { connectionId: string; model: string }[] = [];
  constructor(private readonly script: Record<string, Behaviour>) {}
  async execute(target: ResolvedTarget): Promise<ExecutionResult> {
    this.calls.push({ connectionId: target.connection.id, model: target.model });
    const behaviour = this.script[target.connection.id] ?? ok();
    return typeof behaviour === 'function' ? behaviour() : behaviour;
  }
}

async function* events(items: UpstreamEvent[], failAfter?: Error): AsyncGenerator<UpstreamEvent> {
  for (const item of items) yield item;
  if (failAfter) throw failAfter;
}

const ok = (text = 'hi'): ExecutionResult => ({
  ok: true,
  stream: {
    format: 'openai',
    events: events([{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }]),
  },
});
const fail = (status: number | null, message: string, retryAfterMs?: number): ExecutionResult => ({
  ok: false,
  failure: { status, message, ...(retryAfterMs ? { retryAfterMs } : {}) },
});

function setup(
  script: Record<string, Behaviour>,
  opts: { comboTargets?: { providerId: string; model: string }[] } = {},
) {
  const clock = new FakeClock(1_000_000);
  const connections = new InMemoryConnectionRepository([
    makeConnection({ id: 'groq-1', providerId: 'groq', priority: 1 }),
    makeConnection({ id: 'groq-2', providerId: 'groq', priority: 2 }),
    makeConnection({ id: 'mistral-1', providerId: 'mistral', priority: 1 }),
  ]);
  const combos = new InMemoryComboRepository([
    makeCombo(
      'thinkflow/default',
      opts.comboTargets ?? [
        { providerId: 'groq', model: 'llama' },
        { providerId: 'mistral', model: 'flash' },
      ],
    ),
  ]);
  const logs = new InMemoryLogRepository();
  const executor = new ScriptedExecutor(script);
  const router = new RouteChatRequest({
    connections,
    combos,
    aliases: { getAliases: async () => ({ default: '', opus: '', sonnet: '', haiku: '' }) },
    executor,
    logs,
    clock,
    ids: seqIds(),
  });
  return { router, executor, connections, logs, clock };
}

const req = (model = 'thinkflow/default') => ({
  format: 'openai' as const,
  body: { model, messages: [] },
});

describe('RouteChatRequest', () => {
  it('uses the first healthy connection', async () => {
    const { router, executor } = setup({});
    const result = await router.execute(req(), { source: 'test' });
    expect(result.ok).toBe(true);
    expect(executor.calls).toEqual([{ connectionId: 'groq-1', model: 'llama' }]);
  });

  it('falls over to the next key of the same provider on 429 and cools the first one down', async () => {
    const { router, executor, connections, clock } = setup({
      'groq-1': fail(429, 'Rate limit', 30_000),
    });
    const result = await router.execute(req(), { source: 'test' });
    expect(result.ok && result.connectionId).toBe('groq-2');
    expect(executor.calls.map((c) => c.connectionId)).toEqual(['groq-1', 'groq-2']);
    const cooled = await connections.findById('groq-1');
    expect(cooled?.cooldownUntil).toBe(clock.now() + 30_000);
    expect(cooled?.status(clock.now())).toBe('cooldown');
  });

  it('skips cooling connections on later requests and uses them again after cooldown', async () => {
    const { router, executor, clock } = setup({ 'groq-1': fail(429, 'Rate limit', 10_000) });
    await router.execute(req(), { source: 'test' });
    executor.calls.length = 0;
    await router.execute(req(), { source: 'test' });
    expect(executor.calls.map((c) => c.connectionId)).toEqual(['groq-2']);
    clock.advance(10_001);
    executor.calls.length = 0;
    (executor as unknown as { script: Record<string, Behaviour> }).script['groq-1'] = ok();
    await router.execute(req(), { source: 'test' });
    expect(executor.calls.map((c) => c.connectionId)).toEqual(['groq-1']);
  });

  it('moves to the next combo target when the whole provider is exhausted', async () => {
    const { router, executor } = setup({
      'groq-1': fail(429, 'limit'),
      'groq-2': fail(503, 'down'),
    });
    const result = await router.execute(req(), { source: 'test' });
    expect(result.ok && result.providerId).toBe('mistral');
    expect(executor.calls.map((c) => c.connectionId)).toEqual(['groq-1', 'groq-2', 'mistral-1']);
  });

  it('skips to the next target (without cooldown) when the model is unavailable', async () => {
    const { router, executor, connections } = setup({ 'groq-1': fail(404, 'model not found') });
    const result = await router.execute(req(), { source: 'test' });
    expect(result.ok && result.providerId).toBe('mistral');
    expect(executor.calls.map((c) => c.connectionId)).toEqual(['groq-1', 'mistral-1']);
    expect((await connections.findById('groq-1'))?.cooldownUntil).toBeNull();
  });

  it('stops immediately on a malformed request', async () => {
    const { router, executor } = setup({ 'groq-1': fail(400, 'messages: field required') });
    const result = await router.execute(req(), { source: 'test' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.reason).toBe('bad_request');
    }
    expect(executor.calls).toHaveLength(1);
  });

  it('falls over when the stream fails before the first event', async () => {
    const { router } = setup({
      'groq-1': () => ({
        ok: true,
        stream: {
          format: 'openai',
          events: events([], new UpstreamStreamError('quota exceeded', 429)),
        },
      }),
    });
    const result = await router.execute(req(), { source: 'test' });
    expect(result.ok && result.connectionId).toBe('groq-2');
  });

  it('replays the peeked first event to the consumer', async () => {
    const { router } = setup({});
    const result = await router.execute(req(), { source: 'test' });
    if (!result.ok) throw new Error('expected success');
    const all = await collect(result.stream.events);
    expect(all).toHaveLength(1);
  });

  it('returns an aggregated error when everything fails, and logs attempts', async () => {
    const { router, logs } = setup({
      'groq-1': fail(429, 'a'),
      'groq-2': fail(429, 'b'),
      'mistral-1': fail(429, 'c'),
    });
    const result = await router.execute(req(), { source: 'test' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.attempts).toHaveLength(3);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(logs.entries.at(-1)?.success).toBe(false);
  });

  it('returns 503 when no connection is available', async () => {
    const { router } = setup({}, { comboTargets: [{ providerId: 'deepseek', model: 'x' }] });
    const result = await router.execute(req(), { source: 'test' });
    expect(!result.ok && result.status).toBe(503);
  });

  it('supports direct provider/model addressing and rejects unknown models', async () => {
    const { router, executor } = setup({});
    expect((await router.execute(req('mistral/flash-lite'), { source: 'test' })).ok).toBe(true);
    expect(executor.calls.at(-1)).toEqual({ connectionId: 'mistral-1', model: 'flash-lite' });
    const unknown = await router.execute(req('nope'), { source: 'test' });
    expect(!unknown.ok && unknown.status).toBe(404);
  });

  it('records usage when the response finishes', async () => {
    const { router, logs } = setup({});
    const result = await router.execute(req(), { source: 'test' });
    if (!result.ok) throw new Error('expected success');
    result.finish({ inputTokens: 10, outputTokens: 4 });
    await new Promise((r) => setTimeout(r, 0));
    expect(logs.entries.at(-1)).toMatchObject({
      success: true,
      inputTokens: 10,
      outputTokens: 4,
      providerId: 'groq',
    });
  });
});

describe('RouteChatRequest auto routing robustness', () => {
  const models = ['allam-2-7b', 'llama-3.3-70b-versatile', 'canopylabs/orpheus-v1-english'];
  function autoSetup(
    script: (model: string) => ExecutionResult,
    opts: { listed?: string[] | null; providerId?: string; defaultModel?: string } = {},
  ) {
    const calls: string[] = [];
    const clock = new FakeClock(1_000_000);
    const providerId = opts.providerId ?? 'groq';
    const router = new RouteChatRequest({
      connections: new InMemoryConnectionRepository([
        makeConnection({
          id: 'c1',
          providerId,
          defaultModel: opts.defaultModel ?? '',
        }),
      ]),
      combos: new InMemoryComboRepository([]),
      aliases: { getAliases: async () => ({ default: '', opus: '', sonnet: '', haiku: '' }) },
      executor: {
        execute: async (t: ResolvedTarget) => {
          calls.push(t.model);
          return script(t.model);
        },
      },
      discovery: {
        listModels: async () => {
          if (opts.listed === null) throw new Error('boom');
          return opts.listed ?? models;
        },
      },
      logs: new InMemoryLogRepository(),
      clock,
      ids: seqIds(),
    });
    return { router, calls };
  }
  const body = (tools: boolean) => ({
    format: 'openai' as const,
    body: {
      model: `${'groq'}/auto`,
      messages: [],
      ...(tools ? { tools: [{ type: 'function', function: { name: 'f' } }] } : {}),
    },
  });

  it('skips a no-tools model for tool requests, but not for plain chat', async () => {
    let allowPlain = false;
    const script = (m: string) =>
      m === 'llama-3.3-70b-versatile' && !allowPlain
        ? fail(400, '`tool calling` is not supported with this model')
        : ok();
    const { router, calls } = autoSetup(script, {
      listed: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
    });
    const r1 = await router.execute(body(true), { source: 't' });
    expect(r1.ok && r1.model).toBe('openai/gpt-oss-120b');
    expect(calls).toEqual(['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']);
    calls.length = 0;
    const r2 = await router.execute(body(true), { source: 't' });
    expect(r2.ok && r2.model).toBe('openai/gpt-oss-120b');
    expect(calls).toEqual(['openai/gpt-oss-120b']);
    calls.length = 0;
    allowPlain = true;
    const r3 = await router.execute(body(false), { source: 't' });
    expect(r3.ok && r3.model).toBe('llama-3.3-70b-versatile');
  });

  it('falls back to the catalog suggested model when listing fails', async () => {
    const { router, calls } = autoSetup(() => ok(), { listed: null, providerId: 'groq' });
    const r = await router.execute(body(false), { source: 't' });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['llama-3.3-70b-versatile']);
  });

  it('marks the failure retryable when an earlier attempt was transient', async () => {
    const { router } = autoSetup(
      (m) =>
        m === 'llama-3.3-70b-versatile'
          ? fail(503, 'screening unavailable')
          : fail(404, 'model not found'),
      { listed: ['llama-3.3-70b-versatile'] },
    );
    const r1 = await router.execute(body(false), { source: 't' });
    expect(!r1.ok && r1.reason).toBe('capacity');
    expect(!r1.ok && r1.retryable).toBe(true);
  });

  it('is not retryable when no attempt was transient', async () => {
    const { router } = autoSetup(() => fail(404, 'model not found'), {
      listed: ['llama-3.3-70b-versatile'],
    });
    const r = await router.execute(body(false), { source: 't' });
    expect(!r.ok && r.reason).toBe('model_unavailable');
    expect(!r.ok && r.retryable).toBe(false);
  });

  it('is retryable when the final reason is model_unavailable after a capacity failure', async () => {
    const clock = new FakeClock(1_000_000);
    const exec: ProviderExecutor = {
      execute: async (t: ResolvedTarget) =>
        t.connection.id === 'n1' ? fail(503, 'down') : fail(404, 'model not found'),
    };
    const router = new RouteChatRequest({
      connections: new InMemoryConnectionRepository([
        makeConnection({ id: 'n1', providerId: 'nvidia', priority: 1 }),
        makeConnection({ id: 'g1', providerId: 'groq', priority: 2 }),
      ]),
      combos: new InMemoryComboRepository([
        makeCombo('mix', [
          { providerId: 'nvidia', model: 'x' },
          { providerId: 'groq', model: 'y' },
        ]),
      ]),
      aliases: { getAliases: async () => ({ default: '', opus: '', sonnet: '', haiku: '' }) },
      executor: exec,
      logs: new InMemoryLogRepository(),
      clock,
      ids: seqIds(),
    });
    const r = await router.execute(req('mix'), { source: 't' });
    expect(!r.ok && r.reason).toBe('model_unavailable');
    expect(!r.ok && r.retryable).toBe(true);
  });
});

describe('RouteChatRequest proven models, timeouts and failure summary', () => {
  const emptyAliases = {
    getAliases: async () => ({ default: '', opus: '', sonnet: '', haiku: '' }),
  };
  const listed = ['openai/gpt-oss-20b', 'qwen/qwen3-32b'];

  function single(script: (model: string) => ExecutionResult) {
    const calls: string[] = [];
    const router = new RouteChatRequest({
      connections: new InMemoryConnectionRepository([
        makeConnection({ id: 'c1', providerId: 'groq' }),
      ]),
      combos: new InMemoryComboRepository([]),
      aliases: emptyAliases,
      executor: {
        execute: async (t: ResolvedTarget) => {
          calls.push(t.model);
          return script(t.model);
        },
      },
      discovery: { listModels: async () => listed },
      logs: new InMemoryLogRepository(),
      clock: new FakeClock(1_000_000),
      ids: seqIds(),
    });
    return { router, calls };
  }
  /** A request whose token estimate is about `tokens`. */
  const sized = (model: string, tokens: number) => ({
    format: 'openai' as const,
    body: { model, messages: [{ role: 'user', content: 'a'.repeat(tokens * 4 - 60) }] },
  });
  const timeout = (): ExecutionResult => ({
    ok: false,
    failure: { status: null, kind: 'timeout', message: 'Timeout ao conectar no provider' },
  });

  it('prefers a model proven at 30.4k over an unproven preferred one for a 31k estimate', async () => {
    const { router, calls } = single(() => ok());
    // qwen served 30.4k before (addressed directly); gpt-oss-20b is preferred but never worked
    expect((await router.execute(sized('groq/qwen/qwen3-32b', 30_425), { source: 't' })).ok).toBe(
      true,
    );
    calls.length = 0;
    const r = await router.execute(sized('groq/auto', 31_000), { source: 't' });
    expect(r.ok && r.model).toBe('qwen/qwen3-32b');
    expect(calls).toEqual(['qwen/qwen3-32b']);
  });

  it('keeps the preference order when nothing is proven for a large request', async () => {
    const { router, calls } = single(() => ok());
    await router.execute(sized('groq/auto', 31_000), { source: 't' });
    expect(calls).toEqual(['openai/gpt-oss-20b']);
  });

  it('retries a timeout on an unproven auto model with a proven one, then succeeds', async () => {
    const { router, calls } = single((m) => (m === 'openai/gpt-oss-20b' ? timeout() : ok()));
    await router.execute(sized('groq/qwen/qwen3-32b', 100), { source: 't' }); // qwen now has a success
    calls.length = 0;
    const r = await router.execute(sized('groq/auto', 100), { source: 't' });
    expect(calls).toEqual(['openai/gpt-oss-20b', 'qwen/qwen3-32b']);
    expect(r.ok && r.model).toBe('qwen/qwen3-32b');
    expect(r.attempts[0]).toMatchObject({ reason: 'network', model: 'openai/gpt-oss-20b' });
    // the hanging model is out for this connection
    calls.length = 0;
    await router.execute(sized('groq/auto', 100), { source: 't' });
    expect(calls).toEqual(['qwen/qwen3-32b']);
  });

  it('does not retry a timeout on a model that worked before', async () => {
    let hang = false;
    const { router, calls } = single(() => (hang ? timeout() : ok()));
    await router.execute(sized('groq/auto', 100), { source: 't' }); // gpt-oss-20b succeeds
    hang = true;
    calls.length = 0;
    const r = await router.execute(sized('groq/auto', 100), { source: 't' });
    expect(calls).toEqual(['openai/gpt-oss-20b']);
    expect(r.ok).toBe(false);
  });

  it('summarizes every connection when all of them fail', async () => {
    const script: Record<string, ExecutionResult> = {
      n1: fail(null, 'Timeout ao conectar no provider'),
      g1: fail(
        413,
        'Request too large for model x on tokens per minute (TPM): Limit 8000, Requested 30155',
      ),
      ge1: fail(
        400,
        'Function call is missing a thought_signature in functionCall parts of model gemini-3-flash',
      ),
      gh1: {
        ok: false,
        failure: {
          status: 502,
          kind: 'invalid_response',
          message:
            'Resposta inesperada do provider (text/plain: "OK") em vez de JSON/SSE — verifique o token e as permissões da conexão',
        },
      },
    };
    const router = new RouteChatRequest({
      connections: new InMemoryConnectionRepository([
        makeConnection({ id: 'n1', providerId: 'nvidia' }),
        makeConnection({ id: 'g1', providerId: 'groq' }),
        makeConnection({ id: 'ge1', providerId: 'mistral' }),
        makeConnection({ id: 'gh1', providerId: 'openrouter' }),
      ]),
      combos: new InMemoryComboRepository([
        makeCombo('mix', [
          { providerId: 'nvidia', model: 'a' },
          { providerId: 'groq', model: 'b' },
          { providerId: 'mistral', model: 'c' },
          { providerId: 'openrouter', model: 'd' },
        ]),
      ]),
      aliases: emptyAliases,
      executor: { execute: async (t: ResolvedTarget) => script[t.connection.id]! },
      logs: new InMemoryLogRepository(),
      clock: new FakeClock(1_000_000),
      ids: seqIds(),
    });
    const r = await router.execute(req('mix'), { source: 't' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(
      /^Todas as conexões falharam: NVIDIA NIM \(tempo esgotado\), Groq \(pedido grande demais: 30k tokens > limite 8k\/min\), Mistral \(modelo exige assinatura de ferramenta\), OpenRouter \(resposta inválida: "OK"\)\. Último erro \(invalid_response\): /,
    );
    expect(r.status).toBe(502);
    expect(r.attempts).toHaveLength(4); // the full attempts stay available
  });
});
