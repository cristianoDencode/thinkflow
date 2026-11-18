import { and, asc, eq } from 'drizzle-orm';
import { templateKindSchema, templateSpecSchema } from '@thinkflow/shared';
import type { Db } from '../../../shared/infrastructure/db/client';
import { reportTemplates } from '../../../shared/infrastructure/db/schema';
import type { ReportTemplateRepository } from '../domain/ports';
import type { ReportTemplate, TemplateKind } from '../domain/template';

type Row = typeof reportTemplates.$inferSelect;

function toTemplate(row: Row): ReportTemplate {
  return {
    id: row.id,
    name: row.name,
    kind: templateKindSchema.parse(row.kind),
    description: row.description,
    builtIn: row.builtIn,
    builtInVersion: row.builtInVersion,
    spec: templateSpecSchema.parse(JSON.parse(row.spec)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const toRow = (t: ReportTemplate): typeof reportTemplates.$inferInsert => ({
  id: t.id,
  name: t.name,
  kind: t.kind,
  description: t.description,
  builtIn: t.builtIn,
  builtInVersion: t.builtInVersion,
  spec: JSON.stringify(t.spec),
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

export class SqliteTemplateRepository implements ReportTemplateRepository {
  constructor(private readonly db: Db) {}

  async list(kind?: TemplateKind): Promise<ReportTemplate[]> {
    return this.db
      .select()
      .from(reportTemplates)
      .where(kind ? eq(reportTemplates.kind, kind) : undefined)
      .orderBy(asc(reportTemplates.createdAt), asc(reportTemplates.name))
      .all()
      .map(toTemplate);
  }

  async findById(id: string): Promise<ReportTemplate | null> {
    const row = this.db.select().from(reportTemplates).where(eq(reportTemplates.id, id)).get();
    return row ? toTemplate(row) : null;
  }

  async findByName(kind: TemplateKind, name: string): Promise<ReportTemplate | null> {
    const row = this.db
      .select()
      .from(reportTemplates)
      .where(and(eq(reportTemplates.kind, kind), eq(reportTemplates.name, name)))
      .get();
    return row ? toTemplate(row) : null;
  }

  async save(template: ReportTemplate): Promise<void> {
    const row = toRow(template);
    this.db
      .insert(reportTemplates)
      .values(row)
      .onConflictDoUpdate({ target: reportTemplates.id, set: row })
      .run();
  }

  async delete(id: string): Promise<void> {
    this.db.delete(reportTemplates).where(eq(reportTemplates.id, id)).run();
  }

  async count(): Promise<number> {
    return this.db.$count(reportTemplates);
  }
}
