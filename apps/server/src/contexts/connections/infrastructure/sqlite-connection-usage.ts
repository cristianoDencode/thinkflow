import { sql } from 'drizzle-orm';
import type { Db } from '../../../shared/infrastructure/db/client';
import type { ConnectionUsageReader } from '../domain/ports';

/**
 * Reads the app's own request log. A request that failed over leaves one entry per attempt in
 * `attempts` (each with its connection), while tokens are only known for the final, successful one.
 */
export class SqliteConnectionUsageReader implements ConnectionUsageReader {
  constructor(private readonly db: Db) {}

  since(sinceMs: number): Map<string, { requests: number; tokens: number }> {
    const usage = new Map<string, { requests: number; tokens: number }>();
    const slot = (id: string) => {
      let u = usage.get(id);
      if (!u) usage.set(id, (u = { requests: 0, tokens: 0 }));
      return u;
    };
    // attempts that never reached the provider ("no model found") carry a reason but no status
    const attempts = this.db.all<{ cid: string; n: number }>(sql`
      SELECT json_extract(a.value, '$.connectionId') AS cid, count(*) AS n
      FROM request_logs r, json_each(r.attempts) a
      WHERE r.created_at >= ${sinceMs}
        AND json_extract(a.value, '$.connectionId') IS NOT NULL
        AND NOT (json_extract(a.value, '$.reason') = 'model_unavailable'
                 AND json_extract(a.value, '$.status') IS NULL)
      GROUP BY cid`);
    for (const row of attempts) slot(row.cid).requests = row.n;
    const tokens = this.db.all<{ cid: string; n: number }>(sql`
      SELECT connection_id AS cid, sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) AS n
      FROM request_logs
      WHERE created_at >= ${sinceMs} AND connection_id IS NOT NULL
      GROUP BY connection_id`);
    for (const row of tokens) slot(row.cid).tokens = row.n;
    return usage;
  }
}
