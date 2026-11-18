import { describe, expect, it } from 'vitest';
import { RouteChatRequest } from '../../src/contexts/routing/application/route-chat-request';
import { PrivacyFirewall } from '../../src/contexts/privacy/application/privacy-firewall';
import { restoreStream } from '../../src/contexts/privacy/application/restore-stream';
import type { VaultStore } from '../../src/contexts/privacy/domain/ports';
import { InMemoryVault, type Vault } from '../../src/contexts/privacy/domain/vault';
import type { ProviderExecutor } from '../../src/contexts/routing/domain/ports';
import type {
  ExecutionResult,
  ResolvedTarget,
  RoutableRequest,
  UpstreamEvent,
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

const CPF = '529.982.247-25';
const NAME = 'JOAO DA SILVA';

class MemoryStore implements VaultStore {
  readonly vaults = new Map<string, InMemoryVault>();
  forScope(id: string): Vault {
    const v = this.vaults.get(id) ?? new InMemoryVault();
    this.vaults.set(id, v);
    return v;
  }
  deleteScope(id: string): void {
    this.vaults.delete(id);
  }
  copyScope(): void {}
}

async function* gen(items: UpstreamEvent[]): AsyncGenerator<UpstreamEvent> {
  for (const item of items) yield item;
}

const text = (content: string, finish: string | null = null): UpstreamEvent => ({
  id: 'x',
  choices: [{ index: 0, delta: { content }, finish_reason: finish }],
});
const toolArgs = (args: string): UpstreamEvent => ({
  id: 'x',
  choices: [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
      finish_reason: null,
    },
  ],
});

/** Captures what would be sent to the provider; replies with the scripted events. */
class CapturingExecutor implements ProviderExecutor {
  readonly bodies: RoutableRequest[] = [];
  readonly connections: string[] = [];
  constructor(
    private readonly events: () => UpstreamEvent[],
    private readonly failFirst = false,
  ) {}
  async execute(target: ResolvedTarget, request: RoutableRequest): Promise<ExecutionResult> {
    this.bodies.push(request);
    this.connections.push(target.connection.id);
    if (this.failFirst && this.bodies.length === 1)
      return { ok: false, failure: { status: 429, message: 'limit' } };
    return { ok: true, stream: { format: 'openai', events: gen(this.events()) } };
  }
}

function setup(opts: {
  events?: () => UpstreamEvent[];
  enabled?: boolean;
  failFirst?: boolean;
  firewall?: PrivacyFirewall | 'none';
}) {
  const store = new MemoryStore();
  const executor = new CapturingExecutor(
    opts.events ?? (() => [text('ok', 'stop')]),
    opts.failFirst,
  );
  const firewall =
    opts.firewall === 'none'
      ? undefined
      : (opts.firewall ??
        new PrivacyFirewall({
          vaults: store,
          settings: () => ({ enabled: opts.enabled ?? true, presidioUrl: '', minScore: 0.5 }),
        }));
  const logs = new InMemoryLogRepository();
  const router = new RouteChatRequest({
    connections: new InMemoryConnectionRepository([
      makeConnection({ id: 'groq-1', providerId: 'groq', priority: 1 }),
      makeConnection({ id: 'groq-2', providerId: 'groq', priority: 2 }),
    ]),
    combos: new InMemoryComboRepository([
      makeCombo('thinkflow/default', [{ providerId: 'groq', model: 'llama' }]),
    ]),
    aliases: { getAliases: async () => ({ default: '', opus: '', sonnet: '', haiku: '' }) },
    executor,
    logs,
    ...(firewall ? { privacy: firewall } : {}),
    clock: new FakeClock(1_000_000),
    ids: seqIds(),
  });
  return { router, executor, store, logs };
}

const request = (): RoutableRequest => ({
  format: 'openai',
  body: {
    model: 'thinkflow/default',
    messages: [{ role: 'user', content: `${NAME} tem o CPF ${CPF}` }],
  },
});

async function drain(
  result: Awaited<ReturnType<RouteChatRequest['execute']>>,
): Promise<UpstreamEvent[]> {
  if (!result.ok) throw new Error(result.message);
  const events = await collect(result.stream.events);
  result.finish({});
  return events;
}

const contentOf = (events: UpstreamEvent[]): string =>
  events
    .map((e) => (e.choices as { delta: { content?: string } }[])?.[0]?.delta.content ?? '')
    .join('');
const argsOf = (events: UpstreamEvent[]): string =>
  events
    .map(
      (e) =>
        (e.choices as { delta: { tool_calls?: { function: { arguments?: string } }[] } }[])?.[0]
          ?.delta.tool_calls?.[0]?.function.arguments ?? '',
    )
    .join('');

describe('RouteChatRequest + privacy firewall', () => {
  it('sends only tokens upstream and restores text split across chunks', async () => {
    const { router, executor } = setup({
      events: () => [
        text('O CPF é [CP'),
        text('F_1] e o nome '),
        text('[NOME_1]. Ok [1, 2]', 'stop'),
      ],
    });
    const events = await drain(
      await router.execute(request(), { source: 'test', privacy: { scope: 'conv-1' } }),
    );
    const sent = JSON.stringify(executor.bodies[0]!.body);
    expect(sent).not.toContain(CPF);
    expect(sent).not.toContain(NAME);
    expect(sent).toContain('[CPF_1]');
    expect(contentOf(events)).toBe(`O CPF é ${CPF} e o nome ${NAME}. Ok [1, 2]`);
  });

  it('flushes a half token held back when the stream ends', async () => {
    const { router } = setup({ events: () => [text('veja [CPF_', 'stop')] });
    const events = await drain(await router.execute(request(), { source: 'test' }));
    expect(contentOf(events)).toBe('veja [CPF_');
  });

  it('does not restore tool-call arguments by default, but does for restoreToolArgs', async () => {
    const script = () => [toolArgs('{"cpf":"[CP'), toolArgs('F_1]"}'), text('', 'tool_calls')];
    const plain = setup({ events: script });
    const a = await drain(
      await plain.router.execute(request(), { source: 'test', privacy: { scope: 's' } }),
    );
    expect(argsOf(a)).toBe('{"cpf":"[CPF_1]"}');

    const restored = setup({ events: script });
    const b = await drain(
      await restored.router.execute(request(), {
        source: 'test',
        privacy: { scope: 's', restoreToolArgs: true },
      }),
    );
    expect(argsOf(b)).toBe(`{"cpf":"${CPF}"}`);
    expect(() => JSON.parse(argsOf(b))).not.toThrow();
  });

  it('JSON-escapes restored values inside tool arguments', async () => {
    const { router, store } = setup({ events: () => [toolArgs('{"q":"[ENDERECO_1]"}')] });
    store.forScope('s').tokenFor('ENDERECO', 'Rua "A", 1\\2');
    const events = await drain(
      await router.execute(request(), {
        source: 'test',
        privacy: { scope: 's', restoreToolArgs: true },
      }),
    );
    expect(JSON.parse(argsOf(events))).toEqual({ q: 'Rua "A", 1\\2' });
  });

  it('failover to the next connection sends the same protected body', async () => {
    const { router, executor } = setup({ failFirst: true });
    await drain(await router.execute(request(), { source: 'test' }));
    expect(executor.connections).toEqual(['groq-1', 'groq-2']);
    for (const sent of executor.bodies) {
      expect(JSON.stringify(sent.body)).not.toContain(CPF);
    }
    expect(executor.bodies[0]!.body).toEqual(executor.bodies[1]!.body);
  });

  it('leaves the body and the stream alone when the firewall is disabled', async () => {
    const { router, executor } = setup({
      enabled: false,
      events: () => [text('[CPF_1] fica', 'stop')],
    });
    const events = await drain(await router.execute(request(), { source: 'test' }));
    expect(JSON.stringify(executor.bodies[0]!.body)).toContain(CPF);
    expect(contentOf(events)).toBe('[CPF_1] fica');
  });

  it('works without any firewall (old wiring)', async () => {
    const { router, executor } = setup({ firewall: 'none' });
    await drain(await router.execute(request(), { source: 'test' }));
    expect(executor.bodies).toHaveLength(1);
  });

  it('fails closed with privacy_error when protecting throws', async () => {
    const broken = {
      enabled: () => true,
      vaultFor: () => new InMemoryVault(),
      protect: async () => {
        throw new Error('boom');
      },
    } as unknown as PrivacyFirewall;
    const { router, executor, logs } = setup({ firewall: broken });
    const result = await router.execute(request(), { source: 'test' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.reason).toBe('privacy_error');
      expect(result.message).toContain('dados pessoais');
    }
    expect(executor.bodies).toHaveLength(0);
    expect(logs.entries.at(-1)?.reason).toBe('privacy_error');
  });

  it('logs counts only (tokenized spans and unfiltered images)', async () => {
    const { router, logs } = setup({});
    const req = request();
    (req.body.messages as unknown[]).push({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
    });
    await drain(await router.execute(req, { source: 'test' }));
    const entry = logs.entries.at(-1)!;
    expect(entry.privacyTokenized).toBeGreaterThanOrEqual(2);
    expect(entry.imagesUnfiltered).toBe(1);
    expect(JSON.stringify(entry)).not.toContain(CPF);
  });

  it('keeps the same scope vault across calls (same value, same token)', async () => {
    const { router, executor } = setup({});
    await drain(await router.execute(request(), { source: 'a', privacy: { scope: 'c' } }));
    await drain(await router.execute(request(), { source: 'b', privacy: { scope: 'c' } }));
    expect(executor.bodies[0]!.body).toEqual(executor.bodies[1]!.body);
  });
});

describe('restoreStream (Anthropic)', () => {
  it('restores text across deltas, flushes at block stop, leaves thinking and tool input alone', async () => {
    const vault = new InMemoryVault();
    vault.tokenFor('CPF', CPF);
    const events: UpstreamEvent[] = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'vi [CPF_1]' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'CPF [CP' } },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'F_1] e [CPF_' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 't', name: 'x', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"c":"[CPF_1]"}' },
      },
      { type: 'content_block_stop', index: 2 },
    ];
    const run = async (restoreToolArgs: boolean) => {
      const out = await collect(
        restoreStream(gen(events), 'anthropic', vault, { restoreToolArgs }),
      );
      const textOut = out
        .filter((e) => (e.delta as { type?: string } | undefined)?.type === 'text_delta')
        .map((e) => (e.delta as { text: string }).text)
        .join('');
      const json = out
        .filter((e) => (e.delta as { type?: string } | undefined)?.type === 'input_json_delta')
        .map((e) => (e.delta as { partial_json: string }).partial_json)
        .join('');
      const thinking = out
        .filter((e) => (e.delta as { type?: string } | undefined)?.type === 'thinking_delta')
        .map((e) => (e.delta as { thinking: string }).thinking)
        .join('');
      return { textOut, json, thinking };
    };
    const off = await run(false);
    expect(off.textOut).toBe(`CPF ${CPF} e [CPF_`);
    expect(off.json).toBe('{"c":"[CPF_1]"}');
    expect(off.thinking).toBe('vi [CPF_1]');
    const on = await run(true);
    expect(on.json).toBe(`{"c":"${CPF}"}`);
  });
});
