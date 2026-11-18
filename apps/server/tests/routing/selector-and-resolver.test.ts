import { describe, expect, it } from 'vitest';
import { selectConnections } from '../../src/contexts/routing/domain/connection-selector';
import {
  resolveModel,
  UnknownModelError,
  type ResolveContext,
} from '../../src/contexts/routing/domain/model-resolver';
import { makeCombo, makeConnection } from '../helpers';

describe('selectConnections', () => {
  it('filters disabled / cooling connections and orders by priority then LRU', () => {
    const a = makeConnection({ id: 'a', priority: 5 });
    const b = makeConnection({ id: 'b', priority: 1 });
    const c = makeConnection({ id: 'c', priority: 1 });
    const off = makeConnection({ id: 'off', enabled: false });
    const cooling = makeConnection({ id: 'cool', priority: 0 });
    cooling.registerFailure({ message: 'x', cooldownUntil: 2_000, backoffLevel: 1 }, 1_000);
    b.registerSuccess(500); // used more recently than c
    const ordered = selectConnections([a, b, c, off, cooling], { now: 1_000 });
    expect(ordered.map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });

  it('brings a connection back once its cooldown expires', () => {
    const cooling = makeConnection({ id: 'cool' });
    cooling.registerFailure({ message: 'x', cooldownUntil: 2_000, backoffLevel: 1 }, 1_000);
    expect(selectConnections([cooling], { now: 2_001 }).map((x) => x.id)).toEqual(['cool']);
  });

  it('respects a pinned connection', () => {
    const list = [makeConnection({ id: 'a' }), makeConnection({ id: 'b' })];
    expect(selectConnections(list, { now: 0, pinnedConnectionId: 'b' }).map((x) => x.id)).toEqual([
      'b',
    ]);
  });
});

describe('resolveModel', () => {
  const combo = makeCombo('thinkflow/default', [
    { providerId: 'groq', model: 'llama' },
    { providerId: 'mistral', model: 'flash' },
  ]);
  const ctx = (overrides: Partial<ResolveContext> = {}): ResolveContext => ({
    findCombo: (name) => (name === combo.name ? combo : undefined),
    hasProvider: (id) => ['groq', 'mistral', 'openrouter', 'anthropic'].includes(id),
    hasConnectionsFor: () => false,
    aliases: { default: '', opus: '', sonnet: '', haiku: '' },
    sequence: 0,
    ...overrides,
  });

  it('resolves combos', () => {
    const r = resolveModel('thinkflow/default', ctx());
    expect(r.kind).toBe('combo');
    expect(r.targets.map((t) => t.providerId)).toEqual(['groq', 'mistral']);
  });

  it('rotates round-robin combos by sequence', () => {
    const rr = makeCombo(
      'rr',
      [
        { providerId: 'groq', model: 'a' },
        { providerId: 'mistral', model: 'b' },
      ],
      'round-robin',
    );
    const r = resolveModel('rr', ctx({ findCombo: () => rr, sequence: 1 }));
    expect(r.targets.map((t) => t.model)).toEqual(['b', 'a']);
  });

  it('resolves provider/model keeping slashes in the model id', () => {
    const r = resolveModel('openrouter/meta-llama/llama-3.3-70b-instruct:free', ctx());
    expect(r.targets).toEqual([
      { providerId: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' },
    ]);
  });

  it('maps Claude model names through family aliases', () => {
    const r = resolveModel(
      'claude-sonnet-5-5',
      ctx({ aliases: { default: '', opus: '', sonnet: 'thinkflow/default', haiku: '' } }),
    );
    expect(r.label).toBe('thinkflow/default');
  });

  it('uses the real Anthropic provider when there is an Anthropic connection and no alias', () => {
    const r = resolveModel(
      'claude-opus-5-5',
      ctx({ hasConnectionsFor: (id) => id === 'anthropic' }),
    );
    expect(r.targets).toEqual([{ providerId: 'anthropic', model: 'claude-opus-5-5' }]);
  });

  it('falls back to the default alias, and errors without one', () => {
    expect(
      resolveModel(
        'whatever',
        ctx({ aliases: { default: 'thinkflow/default', opus: '', sonnet: '', haiku: '' } }),
      ).kind,
    ).toBe('combo');
    expect(() => resolveModel('whatever', ctx())).toThrow(UnknownModelError);
  });

  it('guards against alias loops', () => {
    expect(() =>
      resolveModel(
        'x',
        ctx({
          aliases: { default: 'y', opus: '', sonnet: '', haiku: '' },
          findCombo: () => undefined,
        }),
      ),
    ).toThrow(UnknownModelError);
  });
});
