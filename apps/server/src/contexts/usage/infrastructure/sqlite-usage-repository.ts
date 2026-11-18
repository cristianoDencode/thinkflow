import { and, asc, between, like, lt, sql } from 'drizzle-orm';
import type { Db } from '../../../shared/infrastructure/db/client';
import { usageDaily } from '../../../shared/infrastructure/db/schema';
import type { UsageEntry, UsageRepository } from '../domain/ports';

export class SqliteUsageRepository implements UsageRepository {
  constructor(private readonly db: Db) {}

  async record(e: UsageEntry): Promise<void> {
    this.db
      .insert(usageDaily)
      .values(e)
      .onConflictDoUpdate({
        target: [usageDaily.day, usageDaily.providerId, usageDaily.model, usageDaily.source],
        set: {
          requests: sql`${usageDaily.requests} + ${e.requests}`,
          failures: sql`${usageDaily.failures} + ${e.failures}`,
          inputTokens: sql`${usageDaily.inputTokens} + ${e.inputTokens}`,
          outputTokens: sql`${usageDaily.outputTokens} + ${e.outputTokens}`,
          estimatedRequests: sql`${usageDaily.estimatedRequests} + ${e.estimatedRequests}`,
        },
      })
      .run();
  }

  async monthRows(month: string): Promise<UsageEntry[]> {
    return this.db
      .select()
      .from(usageDaily)
      .where(like(usageDaily.day, `${month}-%`))
      .all();
  }

  async dailyTotals(fromDay: string, toDay: string) {
    return this.db
      .select({
        day: usageDaily.day,
        totalTokens: sql<number>`sum(${usageDaily.inputTokens} + ${usageDaily.outputTokens})`,
      })
      .from(usageDaily)
      .where(and(between(usageDaily.day, fromDay, toDay)))
      .groupBy(usageDaily.day)
      .orderBy(asc(usageDaily.day))
      .all();
  }

  async months(): Promise<string[]> {
    return this.db
      .selectDistinct({ month: sql<string>`substr(${usageDaily.day}, 1, 7)` })
      .from(usageDaily)
      .all()
      .map((r) => r.month);
  }

  async pruneBefore(day: string): Promise<void> {
    this.db.delete(usageDaily).where(lt(usageDaily.day, day)).run();
  }
}
