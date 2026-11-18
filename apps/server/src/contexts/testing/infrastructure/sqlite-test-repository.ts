import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  annotationSchema,
  cropSchema,
  downloadSourceSchema,
  downloadStatusSchema,
  runSnapshotSchema,
  runStatusSchema,
  stepResultSchema,
  testDefinitionSchema,
} from '@thinkflow/shared';
import { z } from 'zod';
import type { Db } from '../../../shared/infrastructure/db/client';
import {
  testDownloads,
  testEvidences,
  testRuns,
  testSessions,
} from '../../../shared/infrastructure/db/schema';
import type { DownloadFilter, TestDownload } from '../domain/download';
import type { TestSessionRepository } from '../domain/ports';
import type {
  RunDataSnapshot,
  SessionSecrets,
  TestEvidence,
  TestRun,
  TestSession,
} from '../domain/session';

interface Cipher {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
}

const secretsSchema = z.record(z.string(), z.record(z.string(), z.string()));

type SessionRow = typeof testSessions.$inferSelect;
type EvidenceRow = typeof testEvidences.$inferSelect;
type RunRow = typeof testRuns.$inferSelect;
type DownloadRow = typeof testDownloads.$inferSelect;

const toDownload = (row: DownloadRow): TestDownload => ({
  id: row.id,
  sessionId: row.sessionId,
  stepId: row.stepId,
  runId: row.runId,
  source: downloadSourceSchema.parse(row.source),
  fileName: row.fileName,
  size: row.size,
  contentType: row.contentType,
  url: row.url,
  status: downloadStatusSchema.parse(row.status),
  reason: row.reason,
  objectKey: row.objectKey,
  createdAt: row.createdAt,
});

const toEvidence = (row: EvidenceRow & { stepId: string }): TestEvidence => ({
  id: row.id,
  sessionId: row.sessionId,
  stepId: row.stepId,
  seq: row.seq,
  at: row.at,
  width: row.width,
  height: row.height,
  originalKey: row.originalKey,
  annotatedKey: row.annotatedKey,
  annotations: z.array(annotationSchema).parse(JSON.parse(row.annotations)),
  crop: row.crop ? cropSchema.parse(JSON.parse(row.crop)) : null,
  comment: row.comment,
  include: row.include,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Rows left without a step by an older version are turned into steps at boot (see the migration). */
const isLinked = (row: EvidenceRow): row is EvidenceRow & { stepId: string } => row.stepId !== null;

export class SqliteTestRepository implements TestSessionRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}

  private toSession(row: SessionRow): TestSession {
    let secrets: SessionSecrets = {};
    if (row.secretsEnc) {
      try {
        secrets = secretsSchema.parse(JSON.parse(this.cipher.decrypt(row.secretsEnc)));
      } catch {
        // a different THINKFLOW_SECRET: the secret values must be typed again
        secrets = {};
      }
    }
    return {
      id: row.id,
      name: row.name,
      startUrl: row.startUrl,
      definition: testDefinitionSchema.parse(JSON.parse(row.definition)),
      secrets,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toRun(row: RunRow): TestRun {
    return {
      id: row.id,
      sessionId: row.sessionId,
      seq: row.seq,
      rerunOf: row.rerunOf,
      snapshot: this.toSnapshot(row),
      dataSetId: row.dataSetId,
      status: runStatusSchema.parse(row.status),
      headed: row.headed,
      results: z.array(stepResultSchema).parse(JSON.parse(row.results)),
      error: row.error,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  private toSnapshot(row: RunRow): RunDataSnapshot | null {
    if (!row.dataSnapshot) return null;
    const plain = runSnapshotSchema.parse(JSON.parse(row.dataSnapshot));
    let secrets: Record<string, string> = {};
    if (row.dataSecretsEnc) {
      try {
        secrets = z
          .record(z.string(), z.string())
          .parse(JSON.parse(this.cipher.decrypt(row.dataSecretsEnc)));
      } catch {
        // a different THINKFLOW_SECRET: the secret values of the run are gone
        secrets = {};
      }
    }
    return { ...plain, secrets };
  }

  async list(): Promise<TestSession[]> {
    return this.db
      .select()
      .from(testSessions)
      .orderBy(desc(testSessions.updatedAt))
      .all()
      .map((row) => this.toSession(row));
  }

  async find(id: string): Promise<TestSession | null> {
    const row = this.db.select().from(testSessions).where(eq(testSessions.id, id)).get();
    return row ? this.toSession(row) : null;
  }

  async save(session: TestSession): Promise<void> {
    const hasSecrets = Object.values(session.secrets).some((v) => Object.keys(v).length > 0);
    const row: typeof testSessions.$inferInsert = {
      id: session.id,
      name: session.name,
      startUrl: session.startUrl,
      definition: JSON.stringify(session.definition),
      secretsEnc: hasSecrets ? this.cipher.encrypt(JSON.stringify(session.secrets)) : '',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
    this.db
      .insert(testSessions)
      .values(row)
      .onConflictDoUpdate({ target: testSessions.id, set: row })
      .run();
  }

  async touch(id: string, at: number): Promise<void> {
    this.db.update(testSessions).set({ updatedAt: at }).where(eq(testSessions.id, id)).run();
  }

  async delete(id: string): Promise<void> {
    this.db.delete(testSessions).where(eq(testSessions.id, id)).run();
  }

  async count(): Promise<number> {
    return this.db.$count(testSessions);
  }

  async evidences(sessionId: string): Promise<TestEvidence[]> {
    return this.db
      .select()
      .from(testEvidences)
      .where(eq(testEvidences.sessionId, sessionId))
      .orderBy(testEvidences.seq)
      .all()
      .filter(isLinked)
      .map(toEvidence);
  }

  async findEvidence(id: string): Promise<TestEvidence | null> {
    const row = this.db.select().from(testEvidences).where(eq(testEvidences.id, id)).get();
    return row && isLinked(row) ? toEvidence(row) : null;
  }

  async saveEvidence(e: TestEvidence): Promise<void> {
    const row: typeof testEvidences.$inferInsert = {
      ...e,
      annotations: JSON.stringify(e.annotations),
      crop: e.crop ? JSON.stringify(e.crop) : null,
    };
    this.db
      .insert(testEvidences)
      .values(row)
      .onConflictDoUpdate({ target: testEvidences.id, set: row })
      .run();
  }

  async deleteEvidence(id: string): Promise<void> {
    this.db.delete(testEvidences).where(eq(testEvidences.id, id)).run();
  }

  async evidenceCounts(): Promise<Map<string, number>> {
    const rows = this.db
      .select({ sessionId: testEvidences.sessionId, n: sql<number>`count(*)` })
      .from(testEvidences)
      .groupBy(testEvidences.sessionId)
      .all();
    return new Map(rows.map((r) => [r.sessionId, Number(r.n)]));
  }

  async runs(sessionId: string, limit: number): Promise<TestRun[]> {
    return this.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.sessionId, sessionId))
      .orderBy(desc(testRuns.createdAt), desc(testRuns.id))
      .limit(limit)
      .all()
      .map((r) => this.toRun(r));
  }

  async findRun(id: string): Promise<TestRun | null> {
    const row = this.db.select().from(testRuns).where(eq(testRuns.id, id)).get();
    return row ? this.toRun(row) : null;
  }

  async saveRun(run: TestRun): Promise<void> {
    const { snapshot, ...rest } = run;
    const hasSecrets = !!snapshot && Object.keys(snapshot.secrets).length > 0;
    const row: typeof testRuns.$inferInsert = {
      ...rest,
      results: JSON.stringify(run.results),
      dataSnapshot: snapshot
        ? JSON.stringify({
            dataSetName: snapshot.dataSetName,
            parameters: snapshot.parameters,
            values: snapshot.values,
          })
        : null,
      dataSecretsEnc:
        hasSecrets && snapshot ? this.cipher.encrypt(JSON.stringify(snapshot.secrets)) : '',
    };
    this.db
      .insert(testRuns)
      .values(row)
      .onConflictDoUpdate({ target: testRuns.id, set: row })
      .run();
  }

  async runsWithStatus(status: TestRun['status']): Promise<TestRun[]> {
    return this.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.status, status))
      .orderBy(testRuns.createdAt)
      .all()
      .map((r) => this.toRun(r));
  }

  async lastRuns(): Promise<Map<string, TestRun>> {
    // latest run per session (createdAt, then id as a tiebreaker)
    const rows = this.db
      .select()
      .from(testRuns)
      .where(
        and(
          sql`${testRuns.createdAt} = (select max(r2.created_at) from test_runs r2 where r2.session_id = ${testRuns.sessionId})`,
        ),
      )
      .all();
    const out = new Map<string, TestRun>();
    for (const row of rows) {
      const current = out.get(row.sessionId);
      if (!current || row.id > current.id) out.set(row.sessionId, this.toRun(row));
    }
    return out;
  }

  async nextRunSeq(sessionId: string): Promise<number> {
    const row = this.db
      .select({ max: sql<number>`coalesce(max(${testRuns.seq}), 0)` })
      .from(testRuns)
      .where(eq(testRuns.sessionId, sessionId))
      .get();
    return Number(row?.max ?? 0) + 1;
  }

  async runNumbers(sessionId: string): Promise<Map<string, number>> {
    const rows = this.db
      .select({ id: testRuns.id, seq: testRuns.seq })
      .from(testRuns)
      .where(eq(testRuns.sessionId, sessionId))
      .all();
    return new Map(rows.map((r) => [r.id, r.seq]));
  }

  async downloads(sessionId: string, filter: DownloadFilter = {}): Promise<TestDownload[]> {
    const where: SQL[] = [eq(testDownloads.sessionId, sessionId)];
    if (filter.source) where.push(eq(testDownloads.source, filter.source));
    if (filter.runId) where.push(eq(testDownloads.runId, filter.runId));
    return this.db
      .select()
      .from(testDownloads)
      .where(and(...where))
      .orderBy(desc(testDownloads.createdAt), desc(testDownloads.id))
      .all()
      .map(toDownload);
  }

  async findDownload(id: string): Promise<TestDownload | null> {
    const row = this.db.select().from(testDownloads).where(eq(testDownloads.id, id)).get();
    return row ? toDownload(row) : null;
  }

  async saveDownload(download: TestDownload): Promise<void> {
    const row: typeof testDownloads.$inferInsert = { ...download };
    this.db
      .insert(testDownloads)
      .values(row)
      .onConflictDoUpdate({ target: testDownloads.id, set: row })
      .run();
  }

  async deleteDownload(id: string): Promise<void> {
    this.db.delete(testDownloads).where(eq(testDownloads.id, id)).run();
  }

  async countDownloads(sessionId: string): Promise<number> {
    return this.db.$count(testDownloads, eq(testDownloads.sessionId, sessionId));
  }
}
