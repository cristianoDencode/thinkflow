import { desc, lt } from 'drizzle-orm';
import type { Db } from '../../../shared/infrastructure/db/client';
import { requestLogs } from '../../../shared/infrastructure/db/schema';
import type { RequestLogEntry, RequestLogRepository } from '../domain/ports';

const RETENTION_ROWS = 5_000;

export class SqliteRequestLogRepository implements RequestLogRepository {
  private writes = 0;

  constructor(private readonly db: Db) {}

  async add(entry: RequestLogEntry): Promise<void> {
    this.db
      .insert(requestLogs)
      .values({ ...entry, attempts: JSON.stringify(entry.attempts) })
      .run();
    if (++this.writes % 200 === 0) this.prune();
  }

  async list(limit: number): Promise<RequestLogEntry[]> {
    return this.db
      .select()
      .from(requestLogs)
      .orderBy(desc(requestLogs.createdAt))
      .limit(limit)
      .all()
      .map((row) => ({
        ...row,
        attempts: JSON.parse(row.attempts) as RequestLogEntry['attempts'],
      }));
  }

  private prune(): void {
    const cutoff = this.db
      .select({ createdAt: requestLogs.createdAt })
      .from(requestLogs)
      .orderBy(desc(requestLogs.createdAt))
      .limit(1)
      .offset(RETENTION_ROWS)
      .get();
    if (cutoff)
      this.db.delete(requestLogs).where(lt(requestLogs.createdAt, cutoff.createdAt)).run();
  }
}
