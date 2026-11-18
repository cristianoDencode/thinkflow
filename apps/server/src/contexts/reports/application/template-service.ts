import {
  TEMPLATE_LIMITS,
  templateInputSchema,
  type ReportTemplateDto,
  type ReportTemplateSummaryDto,
  type TemplateKind,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { ConflictError, DomainError, NotFoundError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import { BUILTIN_TEMPLATES } from '../domain/builtin-templates';
import type { ReportTemplateRepository } from '../domain/ports';
import { copyName, templateSummary, type ReportTemplate } from '../domain/template';

export interface TemplateServiceDeps {
  repo: ReportTemplateRepository;
  clock: Clock;
  ids: IdGenerator;
}

const toDto = (t: ReportTemplate): ReportTemplateDto => ({
  id: t.id,
  name: t.name,
  kind: t.kind,
  description: t.description,
  builtIn: t.builtIn,
  builtInVersion: t.builtInVersion,
  spec: t.spec,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

const builtinReadOnly = () =>
  new DomainError(
    'Modelos padrão não podem ser alterados nem excluídos. Use "Duplicar" para criar uma cópia editável.',
    'builtin_template',
    400,
  );

export class TemplateService {
  constructor(private readonly deps: TemplateServiceDeps) {}

  async list(kind?: TemplateKind): Promise<ReportTemplateSummaryDto[]> {
    return (await this.deps.repo.list(kind)).map(templateSummary);
  }

  /** The full template, for the pipeline and the editor. */
  async find(id: string): Promise<ReportTemplate | null> {
    return this.deps.repo.findById(id);
  }

  async get(id: string): Promise<ReportTemplateDto> {
    const template = await this.deps.repo.findById(id);
    if (!template) throw new NotFoundError('Modelo');
    return toDto(template);
  }

  async create(body: unknown): Promise<ReportTemplateDto> {
    const input = templateInputSchema.parse(body);
    if ((await this.deps.repo.count()) >= TEMPLATE_LIMITS.maxTemplates)
      throw new DomainError(
        `Limite de ${TEMPLATE_LIMITS.maxTemplates} modelos atingido. Exclua algum para criar outro.`,
        'template_limit',
        400,
      );
    await this.assertNameFree(input.kind, input.name, null);
    const now = this.deps.clock.now();
    const template: ReportTemplate = {
      id: this.deps.ids.next(),
      name: input.name,
      kind: input.kind,
      description: input.description,
      builtIn: false,
      builtInVersion: null,
      spec: input.spec,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repo.save(template);
    return toDto(template);
  }

  async update(id: string, body: unknown): Promise<ReportTemplateDto> {
    const existing = await this.deps.repo.findById(id);
    if (!existing) throw new NotFoundError('Modelo');
    if (existing.builtIn) throw builtinReadOnly();
    const input = templateInputSchema.parse(body);
    await this.assertNameFree(input.kind, input.name, id);
    const template: ReportTemplate = {
      ...existing,
      name: input.name,
      kind: input.kind,
      description: input.description,
      spec: input.spec,
      updatedAt: this.deps.clock.now(),
    };
    await this.deps.repo.save(template);
    return toDto(template);
  }

  /** Reports keep their own snapshot of the spec, so deleting a template never breaks them. */
  async delete(id: string): Promise<void> {
    const existing = await this.deps.repo.findById(id);
    if (!existing) throw new NotFoundError('Modelo');
    if (existing.builtIn) throw builtinReadOnly();
    await this.deps.repo.delete(id);
  }

  async duplicate(id: string): Promise<ReportTemplateDto> {
    const source = await this.deps.repo.findById(id);
    if (!source) throw new NotFoundError('Modelo');
    if ((await this.deps.repo.count()) >= TEMPLATE_LIMITS.maxTemplates)
      throw new DomainError(
        `Limite de ${TEMPLATE_LIMITS.maxTemplates} modelos atingido. Exclua algum para criar outro.`,
        'template_limit',
        400,
      );
    const sameKind = new Set((await this.deps.repo.list(source.kind)).map((t) => t.name));
    const now = this.deps.clock.now();
    const copy: ReportTemplate = {
      ...source,
      id: this.deps.ids.next(),
      name: copyName(source.name, (candidate) => sameKind.has(candidate)),
      builtIn: false,
      builtInVersion: null,
      // deep copy: the spec is plain JSON
      spec: structuredClone(source.spec),
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repo.save(copy);
    return toDto(copy);
  }

  /**
   * Boot hook: inserts the missing built-in templates and upgrades the ones whose stored version is
   * lower than the code's. A user template that already owns a built-in's (kind, name) is renamed.
   */
  async ensureBuiltIns(): Promise<void> {
    const now = this.deps.clock.now();
    for (const seed of BUILTIN_TEMPLATES) {
      const stored = await this.deps.repo.findById(seed.id);
      if (stored && (stored.builtInVersion ?? 0) >= seed.builtInVersion) continue;

      const clash = await this.deps.repo.findByName(seed.kind, seed.name);
      if (clash && clash.id !== seed.id) {
        const taken = new Set((await this.deps.repo.list(seed.kind)).map((t) => t.name));
        await this.deps.repo.save({
          ...clash,
          name: copyName(clash.name, (candidate) => taken.has(candidate)),
          updatedAt: now,
        });
      }
      await this.deps.repo.save({
        id: seed.id,
        name: seed.name,
        kind: seed.kind,
        description: seed.description,
        builtIn: true,
        builtInVersion: seed.builtInVersion,
        spec: structuredClone(seed.spec),
        createdAt: stored?.createdAt ?? now,
        updatedAt: now,
      });
    }
  }

  private async assertNameFree(
    kind: TemplateKind,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await this.deps.repo.findByName(kind, name);
    if (clash && clash.id !== exceptId)
      throw new ConflictError(`Já existe um modelo "${name}" deste tipo`);
  }
}
