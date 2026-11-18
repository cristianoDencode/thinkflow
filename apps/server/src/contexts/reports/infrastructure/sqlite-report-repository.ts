import { and, asc, desc, eq, gt, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import {
  reportStatusSchema,
  templateKindSchema,
  templateSpecSchema,
  type ReportStatus,
} from '@thinkflow/shared';
import type { Db } from '../../../shared/infrastructure/db/client';
import { reportNotes, reportSections, reports } from '../../../shared/infrastructure/db/schema';
import {
  ACTIVE_STATUSES,
  emptyMeta,
  type NoteSource,
  type Report,
  type ReportListItem,
  type ReportListQuery,
  type ReportMeta,
  type ReportNote,
  type ReportProgress,
  type ReportSection,
  type ResearchStep,
  type SectionOutline,
} from '../domain/report';
import type { ReportRepository } from '../domain/report-ports';

type Row = typeof reports.$inferSelect;
type SectionRow = typeof reportSections.$inferSelect;
type NoteRow = typeof reportNotes.$inferSelect;

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const parseStatus = (value: string): ReportStatus => {
  const parsed = reportStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : 'error';
};

const parseMeta = (text: string): ReportMeta => ({
  ...emptyMeta(),
  ...parseJson<Partial<ReportMeta>>(text, {}),
});

function toReport(row: Row): Report {
  return {
    id: row.id,
    title: row.title,
    kind: templateKindSchema.parse(row.kind),
    templateId: row.templateId,
    templateName: row.templateName,
    templateSnapshot: templateSpecSchema.parse(JSON.parse(row.templateSnapshot)),
    status: parseStatus(row.status),
    progress: parseJson<ReportProgress>(row.progress, {
      phase: parseStatus(row.status),
      current: 0,
      total: 0,
      label: '',
    }),
    error: row.error,
    failedPhase: row.failedPhase ? parseStatus(row.failedPhase) : null,
    cancelRequested: row.cancelRequested,
    model: row.model,
    variables: parseJson<Record<string, string>>(row.variables, {}),
    brief: row.brief,
    libraryId: row.libraryId,
    useMcp: row.useMcp,
    conversationId: row.conversationId,
    plan: parseJson<ResearchStep[] | null>(row.plan, null),
    researchDone: row.researchDone,
    outline: parseJson<SectionOutline[] | null>(row.outline, null),
    html: row.html,
    markdown: row.markdown,
    meta: parseMeta(row.meta),
    pdfKey: row.pdfKey,
    pdfAt: row.pdfAt,
    htmlHash: row.htmlHash,
    artifactsStoredAt: row.artifactsStoredAt,
    storageAttempts: row.storageAttempts,
    storageNextAt: row.storageNextAt,
    storageError: row.storageError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

const json = (value: unknown): string => JSON.stringify(value);

/** Domain patch -> column values (only the keys present). */
function toColumns(patch: Partial<Omit<Report, 'id'>>): Partial<typeof reports.$inferInsert> {
  const out: Partial<typeof reports.$inferInsert> = {};
  for (const [key, value] of Object.entries(patch) as [keyof Report, unknown][]) {
    switch (key) {
      case 'templateSnapshot':
      case 'progress':
      case 'variables':
      case 'plan':
      case 'outline':
      case 'meta':
        (out as Record<string, unknown>)[key] = value === null ? null : json(value);
        break;
      default:
        (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function toSection(row: SectionRow): ReportSection {
  return {
    reportId: row.reportId,
    ordinal: row.ordinal,
    title: row.title,
    requirements: row.requirements,
    role: row.role === 'screen' ? 'screen' : 'section',
    status:
      (['pending', 'writing', 'done', 'error'] as const).find((s) => s === row.status) ?? 'pending',
    markdown: row.markdown,
    html: row.html,
    noteIds: parseJson<string[]>(row.noteIds, []),
    model: row.model,
    providerId: row.providerId,
    warnings: parseJson<string[]>(row.warnings, []),
    error: row.error,
    updatedAt: row.updatedAt,
  };
}

function toNote(row: NoteRow): ReportNote {
  return {
    id: row.id,
    reportId: row.reportId,
    step: row.step,
    ordinal: row.ordinal,
    source: row.source as NoteSource,
    toolName: row.toolName,
    query: row.query,
    content: row.content,
    sectionHints: parseJson<number[]>(row.sectionHints, []),
    createdAt: row.createdAt,
  };
}

export class SqliteReportRepository implements ReportRepository {
  constructor(private readonly db: Db) {}

  async create(report: Report): Promise<void> {
    this.db
      .insert(reports)
      .values({ id: report.id, ...(toColumns(report) as Omit<typeof reports.$inferInsert, 'id'>) })
      .run();
  }

  async findById(id: string): Promise<Report | null> {
    const row = this.db.select().from(reports).where(eq(reports.id, id)).get();
    return row ? toReport(row) : null;
  }

  async list(query: ReportListQuery): Promise<ReportListItem[]> {
    const filters = [
      query.status ? eq(reports.status, query.status) : undefined,
      query.kind ? eq(reports.kind, query.kind) : undefined,
      query.q ? sql`${reports.title} like ${`%${escapeLike(query.q)}%`} escape '\\'` : undefined,
    ].filter((f): f is NonNullable<typeof f> => !!f);
    const rows = this.db
      .select({
        id: reports.id,
        title: reports.title,
        kind: reports.kind,
        templateId: reports.templateId,
        templateName: reports.templateName,
        status: reports.status,
        progress: reports.progress,
        error: reports.error,
        failedPhase: reports.failedPhase,
        cancelRequested: reports.cancelRequested,
        model: reports.model,
        variables: reports.variables,
        libraryId: reports.libraryId,
        useMcp: reports.useMcp,
        conversationId: reports.conversationId,
        plan: reports.plan,
        researchDone: reports.researchDone,
        hasMarkdown: sql<number>`${reports.markdown} is not null`,
        hasHtml: sql<number>`(${reports.html} is not null or ${reports.htmlHash} is not null)`,
        storagePending: sql<number>`${reports.html} is not null`,
        storageStored: sql<number>`(${reports.html} is null and ${reports.htmlHash} is not null)`,
        hasPdf: sql<number>`${reports.pdfKey} is not null`,
        sectionCount: sql<number>`(select count(*) from ${reportSections} where ${reportSections.reportId} = ${reports.id})`,
        meta: reports.meta,
        pdfAt: reports.pdfAt,
        createdAt: reports.createdAt,
        updatedAt: reports.updatedAt,
        startedAt: reports.startedAt,
        finishedAt: reports.finishedAt,
      })
      .from(reports)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(query.limit)
      .offset(query.offset)
      .all();
    return rows.map((row) => {
      const {
        plan,
        hasMarkdown,
        hasHtml,
        hasPdf,
        sectionCount,
        storagePending,
        storageStored,
        ...rest
      } = row;
      return {
        ...rest,
        kind: templateKindSchema.parse(row.kind),
        status: parseStatus(row.status),
        failedPhase: row.failedPhase ? parseStatus(row.failedPhase) : null,
        progress: parseJson<ReportProgress>(row.progress, {
          phase: parseStatus(row.status),
          current: 0,
          total: 0,
          label: '',
        }),
        variables: parseJson<Record<string, string>>(row.variables, {}),
        meta: parseMeta(row.meta),
        researchTotal: parseJson<ResearchStep[] | null>(plan, null)?.length ?? null,
        sectionCount: Number(sectionCount),
        hasMarkdown: !!hasMarkdown,
        hasHtml: !!hasHtml,
        hasPdf: !!hasPdf,
        storage: storagePending ? ('pending' as const) : storageStored ? ('stored' as const) : null,
      };
    });
  }

  async update(id: string, patch: Partial<Omit<Report, 'id'>>): Promise<void> {
    const set = toColumns(patch);
    if (Object.keys(set).length === 0) return;
    this.db.update(reports).set(set).where(eq(reports.id, id)).run();
  }

  async delete(id: string): Promise<void> {
    this.db.delete(reports).where(eq(reports.id, id)).run();
  }

  async listByStatus(statuses: readonly ReportStatus[]): Promise<Report[]> {
    return this.db
      .select()
      .from(reports)
      .where(inArray(reports.status, [...statuses]))
      .orderBy(asc(reports.createdAt))
      .all()
      .map(toReport);
  }

  async pruneOldest(keep: number): Promise<Report[]> {
    const rows = this.db
      .select()
      .from(reports)
      .where(notInArray(reports.status, [...ACTIVE_STATUSES]))
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .all();
    const stale = rows.slice(Math.max(keep, 0));
    for (const row of stale) this.db.delete(reports).where(eq(reports.id, row.id)).run();
    return stale.map(toReport);
  }

  async listStorageDue(now: number, limit: number): Promise<string[]> {
    return this.db
      .select({ id: reports.id })
      .from(reports)
      .where(
        and(
          isNotNull(reports.html),
          sql`(${reports.storageNextAt} is null or ${reports.storageNextAt} <= ${now})`,
        ),
      )
      .orderBy(asc(reports.updatedAt), asc(reports.id))
      .limit(limit)
      .all()
      .map((row) => row.id);
  }

  async countStoragePending(): Promise<number> {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(reports)
      .where(isNotNull(reports.html))
      .get();
    return Number(row?.n ?? 0);
  }

  async markArtifactsStored(id: string, hash: string, at: number): Promise<boolean> {
    const result = this.db
      .update(reports)
      .set({
        html: null,
        artifactsStoredAt: at,
        storageAttempts: 0,
        storageNextAt: null,
        storageError: null,
      })
      .where(and(eq(reports.id, id), eq(reports.htmlHash, hash), isNotNull(reports.html)))
      .run();
    return result.changes > 0;
  }

  async markStorageFailed(id: string, hash: string, error: string, nextAt: number): Promise<void> {
    this.db
      .update(reports)
      .set({
        storageAttempts: sql`${reports.storageAttempts} + 1`,
        storageError: error,
        storageNextAt: nextAt,
      })
      .where(and(eq(reports.id, id), eq(reports.htmlHash, hash)))
      .run();
  }

  async setHtmlHashIfMissing(id: string, hash: string): Promise<boolean> {
    const result = this.db
      .update(reports)
      .set({ htmlHash: hash })
      .where(and(eq(reports.id, id), sql`${reports.htmlHash} is null`, isNotNull(reports.html)))
      .run();
    return result.changes > 0;
  }

  async setPdfKeyIf(
    id: string,
    expectedHtmlHash: string,
    pdfKey: string,
    pdfAt: number,
  ): Promise<boolean> {
    const result = this.db
      .update(reports)
      .set({ pdfKey, pdfAt })
      .where(
        and(eq(reports.id, id), eq(reports.htmlHash, expectedHtmlHash), eq(reports.status, 'done')),
      )
      .run();
    return result.changes > 0;
  }

  async storageIndex(): Promise<Map<string, { htmlHash: string | null; pdfKey: string | null }>> {
    const rows = this.db
      .select({ id: reports.id, htmlHash: reports.htmlHash, pdfKey: reports.pdfKey })
      .from(reports)
      .all();
    return new Map(rows.map((r) => [r.id, { htmlHash: r.htmlHash, pdfKey: r.pdfKey }]));
  }

  async listLegacyPdfs(limit: number, afterId?: string): Promise<Report[]> {
    return this.db
      .select()
      .from(reports)
      .where(
        and(
          isNotNull(reports.pdfKey),
          sql`${reports.pdfKey} not like '%/%'`,
          afterId ? gt(reports.id, afterId) : undefined,
        ),
      )
      .orderBy(asc(reports.id))
      .limit(limit)
      .all()
      .map(toReport);
  }

  async addSections(sections: ReportSection[]): Promise<void> {
    for (const s of sections) {
      this.db
        .insert(reportSections)
        .values({
          reportId: s.reportId,
          ordinal: s.ordinal,
          title: s.title,
          requirements: s.requirements,
          role: s.role,
          status: s.status,
          markdown: s.markdown,
          html: s.html,
          noteIds: json(s.noteIds),
          model: s.model,
          providerId: s.providerId,
          warnings: json(s.warnings),
          error: s.error,
          updatedAt: s.updatedAt,
        })
        .onConflictDoNothing()
        .run();
    }
  }

  async sections(reportId: string): Promise<ReportSection[]> {
    return this.db
      .select()
      .from(reportSections)
      .where(eq(reportSections.reportId, reportId))
      .orderBy(asc(reportSections.ordinal))
      .all()
      .map(toSection);
  }

  async updateSection(
    reportId: string,
    ordinal: number,
    patch: Partial<Omit<ReportSection, 'reportId' | 'ordinal'>>,
  ): Promise<void> {
    const set: Partial<typeof reportSections.$inferInsert> = {};
    for (const [key, value] of Object.entries(patch)) {
      (set as Record<string, unknown>)[key] =
        key === 'noteIds' || key === 'warnings' ? json(value) : value;
    }
    if (Object.keys(set).length === 0) return;
    this.db
      .update(reportSections)
      .set(set)
      .where(and(eq(reportSections.reportId, reportId), eq(reportSections.ordinal, ordinal)))
      .run();
  }

  async resetWritingSections(reportId: string): Promise<void> {
    const where = and(eq(reportSections.reportId, reportId), eq(reportSections.status, 'writing'));
    this.db
      .update(reportSections)
      .set({ status: 'done' })
      .where(and(where, sql`${reportSections.markdown} <> ''`))
      .run();
    this.db.update(reportSections).set({ status: 'pending' }).where(where).run();
  }

  async addNotes(notes: ReportNote[]): Promise<void> {
    for (const n of notes) {
      this.db
        .insert(reportNotes)
        .values({
          id: n.id,
          reportId: n.reportId,
          step: n.step,
          ordinal: n.ordinal,
          source: n.source,
          toolName: n.toolName,
          query: n.query,
          content: n.content,
          sectionHints: json(n.sectionHints),
          createdAt: n.createdAt,
        })
        .run();
    }
  }

  async notes(reportId: string): Promise<ReportNote[]> {
    return this.db
      .select()
      .from(reportNotes)
      .where(eq(reportNotes.reportId, reportId))
      .orderBy(asc(reportNotes.step), asc(reportNotes.ordinal))
      .all()
      .map(toNote);
  }

  async deleteNotesFromStep(reportId: string, step: number): Promise<void> {
    this.db
      .delete(reportNotes)
      .where(and(eq(reportNotes.reportId, reportId), sql`${reportNotes.step} >= ${step}`))
      .run();
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
