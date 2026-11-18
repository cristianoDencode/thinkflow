import { describe, expect, it } from 'vitest';
import { RouteChatRequest } from '../../src/contexts/routing/application/route-chat-request';
import {
  CapacityBook,
  parseTokenLimit,
  type CapacitySnapshot,
} from '../../src/contexts/routing/domain/capacity';
import type { ProviderExecutor } from '../../src/contexts/routing/domain/ports';
import type { ExecutionResult, ResolvedTarget } from '../../src/contexts/routing/domain/types';
import { FakeClock } from '../../src/shared/kernel/clock';
import {
  InMemoryComboRepository,
  InMemoryConnectionRepository,
  InMemoryLogRepository,
  makeCombo,
  makeConnection,
  seqIds,
} from '../helpers';

describe('parseTokenLimit', () => {
  it('reads Groq TPM errors', () => {
    expect(
      parseTokenLimit('on tokens per minute (TPM): Limit 8000, Requested 47687, please reduce'),
    ).toEqual({ limit: 8000, requested: 47687 });
  });
  it('reads OpenAI-style context errors', () => {
    expect(parseTokenLimit("This model's maximum context length is 128000 tokens")?.limit).toBe(
      128000,
    );
  });
  it('reads Anthropic "x tokens > y maximum"', () => {
    expect(parseTokenLimit('prompt is too long: 210000 tokens > 200000 maximum')).toEqual({
      limit: 200000,
      requested: 210000,
    });
  });
  it('returns null without numbers', () => {
    expect(parseTokenLimit('request too large')).toBeNull();
  });
});

describe('CapacityBook', () => {
  it('learns a calibrated limit and forgets it after a bigger success', () => {
    const book = new CapacityBook();
    // our estimate was 40k while the provider counted 47 687 → limit ≈ 8000*40/47.7*0.9
    const limit = book.recordRejection('c', 'm', 40_000, 'Limit 8000, Requested 47687', 0);
    expect(limit).toBeGreaterThan(5_500);
    expect(limit).toBeLessThan(7_000);
    expect(book.fits('c', 'm', 3_000, 0)).toBe(true);
    expect(book.fits('c', 'm', 20_000, 0)).toBe(false);
    book.recordSuccess('c', 'm', 30_000, 1);
    expect(book.fits('c', 'm', 20_000, 1)).toBe(true);
  });
  it('expires learned limits after a day', () => {
    const book = new CapacityBook();
    book.recordRejection('c', 'm', 10_000, 'too large', 0);
    expect(book.fits('c', 'm', 10_000, 0)).toBe(false);
    expect(book.fits('c', 'm', 10_000, 25 * 3600 * 1000)).toBe(true);
  });
  it('exposes the learned limit until it expires', () => {
    const book = new CapacityBook();
    expect(book.limit('c', 'm', 0)).toBeUndefined();
    book.recordSuccess('c', 'm', 500, 0);
    expect(book.limit('c', 'm', 0)).toBeUndefined(); // a success alone is not a limit
    const learned = book.recordRejection('c', 'm', 10_000, 'too large', 0);
    expect(book.limit('c', 'm', 0)).toBe(learned);
    expect(book.limit('c', 'm', 25 * 3600 * 1000)).toBeUndefined();
  });
});

class Exec implements ProviderExecutor {
  readonly calls: string[] = [];
  constructor(private readonly behave: (t: ResolvedTarget) => ExecutionResult) {}
  async execute(t: ResolvedTarget): Promise<ExecutionResult> {
    this.calls.push(t.connection.id);
    return this.behave(t);
  }
}

async function* one() {
  yield { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] };
}
const ok = (): ExecutionResult => ({ ok: true, stream: { format: 'openai', events: one() } });

function setup(behave: (t: ResolvedTarget) => ExecutionResult) {
  let saved: CapacitySnapshot = {};
  const executor = new Exec(behave);
  const router = new RouteChatRequest({
    connections: new InMemoryConnectionRepository([
      makeConnection({ id: 'groq-1', providerId: 'groq', priority: 1 }),
      makeConnection({ id: 'nvidia-1', providerId: 'nvidia', priority: 1 }),
    ]),
    combos: new InMemoryComboRepository([
      makeCombo('c', [
        { providerId: 'groq', model: 'small' },
        { providerId: 'nvidia', model: 'big' },
      ]),
    ]),
    aliases: { getAliases: async () => ({ default: '', opus: '', sonnet: '', haiku: '' }) },
    executor,
    logs: new InMemoryLogRepository(),
    capacity: { load: () => saved, save: (s) => (saved = s) },
    clock: new FakeClock(1_000_000),
    ids: seqIds(),
  });
  return { router, executor, saved: () => saved };
}

const body = (chars: number) => ({
  format: 'openai' as const,
  body: { model: 'c', messages: [{ role: 'user', content: 'x'.repeat(chars) }] },
});

describe('capacity-aware routing', () => {
  it('learns that a model is too small and goes straight to the bigger one next time', async () => {
    const { router, executor, saved } = setup((t) =>
      t.connection.id === 'groq-1' && bigRequest
        ? {
            ok: false,
            failure: { status: 413, message: 'Request too large. Limit 8000, Requested 50000' },
          }
        : ok(),
    );
    let bigRequest = true;
    expect((await router.execute(body(200_000), { source: 't' })).ok).toBe(true);
    expect(executor.calls).toEqual(['groq-1', 'nvidia-1']);
    expect(Object.keys(saved())).toContain('groq-1::small');

    executor.calls.length = 0;
    expect((await router.execute(body(200_000), { source: 't' })).ok).toBe(true);
    expect(executor.calls).toEqual(['nvidia-1']); // groq skipped up-front

    // small prompts still use the configured order (groq first)
    bigRequest = false;
    executor.calls.length = 0;
    await router.execute(body(400), { source: 't' });
    expect(executor.calls).toEqual(['groq-1']);
  });
});

describe('inputLimitHint', () => {
  const big = body(200_000);

  it('is undefined while any candidate has no learned limit', async () => {
    const { router } = setup(() => ok());
    expect(await router.inputLimitHint('c')).toBeUndefined();
    expect(await router.inputLimitHint('')).toBeUndefined();
    expect(await router.inputLimitHint('nope')).toBeUndefined();
  });

  it('returns the largest learned limit once every candidate has one', async () => {
    const { router } = setup((t) =>
      t.connection.id === 'groq-1'
        ? { ok: false, failure: { status: 413, message: 'Limit 8000, Requested 50000' } }
        : { ok: false, failure: { status: 400, message: 'maximum context length is 32000' } },
    );
    await router.execute(big, { source: 't' });
    const direct = await router.inputLimitHint('groq/small');
    const combo = await router.inputLimitHint('c');
    expect(direct).toBeGreaterThan(0);
    expect(combo).toBeGreaterThan(direct!);
    // a direct model that was never rejected stays unknown
    expect(await router.inputLimitHint('nvidia/other')).toBeUndefined();
  });

  it('does not advance the round-robin sequence or call the provider', async () => {
    const { router, executor } = setup(() => ok());
    await router.inputLimitHint('c');
    await router.inputLimitHint('c');
    expect(executor.calls).toEqual([]);
  });
});

describe('auto model without a model list', () => {
  it("falls back to the connection's default model so failures still cool it down", async () => {
    const executor = new Exec((t) =>
      t.connection.id === 'groq-1'
        ? { ok: false, failure: { status: null, message: 'ECONNREFUSED' } }
        : ok(),
    );
    const connections = new InMemoryConnectionRepository([
      makeConnection({ id: 'groq-1', providerId: 'groq', priority: 1, defaultModel: 'llama' }),
      makeConnection({ id: 'groq-2', providerId: 'groq', priority: 2, defaultModel: 'llama' }),
    ]);
    const router = new RouteChatRequest({
      connections,
      combos: new InMemoryComboRepository([]),
      aliases: { getAliases: async () => ({ default: '', opus: '', sonnet: '', haiku: '' }) },
      executor,
      logs: new InMemoryLogRepository(),
      discovery: {
        listModels: async () => {
          throw new Error('offline');
        },
      },
      clock: new FakeClock(1_000_000),
      ids: seqIds(),
    });
    const result = await router.execute(
      { format: 'openai', body: { model: 'groq/auto', messages: [] } },
      { source: 't' },
    );
    expect(result.ok).toBe(true);
    expect(executor.calls).toEqual(['groq-1', 'groq-2']);
    expect((await connections.findById('groq-1'))?.cooldownUntil).toBeGreaterThan(1_000_000);
  });
});
