import { eq } from 'drizzle-orm';
import type { Db } from '../../../shared/infrastructure/db/client';
import { connectionQuota } from '../../../shared/infrastructure/db/schema';
import type { QuotaStore } from '../domain/ports';
import type { QuotaObservation } from '../domain/quota';

type Row = typeof connectionQuota.$inferSelect;

const toObservation = (r: Row): QuotaObservation => ({
  metric: r.metric as QuotaObservation['metric'],
  window: r.window as QuotaObservation['window'],
  limit: r.limit,
  remaining: r.remaining,
  used: r.used,
  resetAt: r.resetAt,
  model: r.model,
  source: r.source as QuotaObservation['source'],
  observedAt: r.observedAt,
});

/** Last known provider-reported quota per connection/metric/window; survives restarts. */
export class SqliteQuotaStore implements QuotaStore {
  constructor(private readonly db: Db) {}

  record(connectionId: string, observations: QuotaObservation[]): void {
    try {
      for (const o of observations) {
        const row = { connectionId, ...o };
        this.db
          .insert(connectionQuota)
          .values(row)
          .onConflictDoUpdate({
            target: [connectionQuota.connectionId, connectionQuota.metric, connectionQuota.window],
            set: row,
          })
          .run();
      }
    } catch {
      // quota bookkeeping must never break a request
    }
  }

  list(connectionId: string): QuotaObservation[] {
    return this.db
      .select()
      .from(connectionQuota)
      .where(eq(connectionQuota.connectionId, connectionId))
      .all()
      .map(toObservation);
  }

  listAll(): Map<string, QuotaObservation[]> {
    const map = new Map<string, QuotaObservation[]>();
    for (const r of this.db.select().from(connectionQuota).all()) {
      const list = map.get(r.connectionId) ?? [];
      list.push(toObservation(r));
      map.set(r.connectionId, list);
    }
    return map;
  }
}
