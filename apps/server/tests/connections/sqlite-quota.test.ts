import { afterEach, describe, expect, it } from 'vitest';
import { SecretBox } from '../../src/shared/infrastructure/crypto';
import { openDatabase, type DbHandle } from '../../src/shared/infrastructure/db/client';
import { requestLogs } from '../../src/shared/infrastructure/db/schema';
import { SqliteConnectionUsageReader } from '../../src/contexts/connections/infrastructure/sqlite-connection-usage';
import { SqliteQuotaStore } from '../../src/contexts/connections/infrastructure/sqlite-quota-store';
import { SqliteConnectionRepository } from '../../src/contexts/connections/infrastructure/sqlite-repositories';
import type { QuotaObservation } from '../../src/contexts/connections/domain/quota';
import type { RequestAttemptDto } from '@thinkflow/shared';
import { makeConnection } from '../helpers';

let handle: DbHandle | undefined;
afterEach(() => handle?.close());

const obs = (over: Partial<QuotaObservation> = {}): QuotaObservation => ({
  metric: 'tokens',
  window: 'day',
  limit: 200000,
  remaining: 617,
  used: 199383,
  resetAt: 5000,
  model: 'm',
  source: 'error',
  observedAt: 1000,
  ...over,
});

describe('SqliteQuotaStore', () => {
  it('upserts per connection/metric/window and survives a reload', () => {
    handle = openDatabase(':memory:');
    const store = new SqliteQuotaStore(handle.db);
    store.record('c1', [obs(), obs({ metric: 'requests', limit: 1000 })]);
    store.record('c1', [obs({ used: 199900, remaining: 100, observedAt: 2000 })]);
    store.record('c2', [obs({ limit: 5 })]);
    const rows = store.list('c1');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.metric === 'tokens')).toMatchObject({
      used: 199900,
      observedAt: 2000,
    });
    expect([...store.listAll().keys()].sort()).toEqual(['c1', 'c2']);
  });

  it('is removed together with its connection', async () => {
    handle = openDatabase(':memory:');
    const secrets = new SecretBox('x'.repeat(32));
    const repo = new SqliteConnectionRepository(handle.db, secrets);
    await repo.save(makeConnection({ id: 'c1' }));
    await repo.save(makeConnection({ id: 'c2' }));
    const store = new SqliteQuotaStore(handle.db);
    store.record('c1', [obs()]);
    store.record('c2', [obs()]);
    await repo.delete('c1');
    expect(store.list('c1')).toEqual([]);
    expect(store.list('c2')).toHaveLength(1);
  });
});

describe('SqliteConnectionUsageReader', () => {
  const attempt = (connectionId: string | null, reason: string, status?: number) =>
    ({
      providerId: 'groq',
      model: 'm',
      connectionId,
      reason,
      ...(status ? { status } : {}),
    }) satisfies RequestAttemptDto;

  it('counts every attempt and the tokens of finished requests since the cutoff', () => {
    handle = openDatabase(':memory:');
    const { db } = handle;
    let n = 0;
    const add = (
      createdAt: number,
      attempts: RequestAttemptDto[],
      extra: Partial<typeof requestLogs.$inferInsert> = {},
    ) =>
      db
        .insert(requestLogs)
        .values({
          id: `r${++n}`,
          createdAt,
          source: 'test',
          requestedModel: 'auto',
          success: true,
          latencyMs: 1,
          attempts: JSON.stringify(attempts),
          ...extra,
        })
        .run();
    // before the cutoff: ignored
    add(99, [attempt('a', 'success')], {
      connectionId: 'a',
      inputTokens: 1000,
      outputTokens: 1000,
    });
    // failed over from a (429) to b
    add(100, [attempt('a', 'rate_limited', 429), attempt('b', 'success')], {
      connectionId: 'b',
      inputTokens: 10,
      outputTokens: 5,
    });
    // a succeeded without reported tokens
    add(200, [attempt('a', 'success')], { connectionId: 'a' });
    // everything failed: no connection_id on the row, attempts still count
    add(300, [attempt('a', 'server', 500), attempt(null, 'no_available_connection')], {
      success: false,
    });
    // never reached the provider ("no model found"): not a request
    add(400, [attempt('c', 'model_unavailable')], { success: false });

    const usage = new SqliteConnectionUsageReader(db).since(100);
    expect(usage.get('a')).toEqual({ requests: 3, tokens: 0 });
    expect(usage.get('b')).toEqual({ requests: 1, tokens: 15 });
    expect(usage.has('c')).toBe(false);
  });
});
