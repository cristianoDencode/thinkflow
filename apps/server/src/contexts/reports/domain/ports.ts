import type { ReportTemplate, TemplateKind } from './template';

export interface ReportTemplateRepository {
  list(kind?: TemplateKind): Promise<ReportTemplate[]>;
  findById(id: string): Promise<ReportTemplate | null>;
  findByName(kind: TemplateKind, name: string): Promise<ReportTemplate | null>;
  /** Upserts by id. */
  save(template: ReportTemplate): Promise<void>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}
