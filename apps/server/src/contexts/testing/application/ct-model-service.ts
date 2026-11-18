import {
  CT_DEFAULT_MODEL_ID,
  CT_DEFAULT_MODEL_NAME,
  CT_LAYOUT_LIMITS,
  DEFAULT_CT_LAYOUT,
  ctLayoutPreviewSchema,
  ctModelInputSchema,
  type CtLayout,
  type CtModelDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { ConflictError, DomainError, NotFoundError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import type { CtModel, CtModelRepository } from '../domain/ct-model';

export interface CtModelServiceDeps {
  repo: CtModelRepository;
  ids: IdGenerator;
  clock: Clock;
  /** HTML of the sample document with a look (the CT preview renderer). */
  previewSample(layout: CtLayout): string;
}

const BUILT_IN: CtModelDto = {
  id: CT_DEFAULT_MODEL_ID,
  name: CT_DEFAULT_MODEL_NAME,
  builtIn: true,
  layout: DEFAULT_CT_LAYOUT,
  createdAt: 0,
  updatedAt: 0,
};

const toDto = (model: CtModel): CtModelDto => ({ ...model, builtIn: false });
const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** Named looks of the CT document: the read-only "Padrão" plus the ones the person saved. */
export class CtModelService {
  constructor(private readonly deps: CtModelServiceDeps) {}

  /** "Padrão" first, then the saved ones, oldest first. */
  async list(): Promise<CtModelDto[]> {
    return [BUILT_IN, ...(await this.deps.repo.list()).map(toDto)];
  }

  async get(id: string): Promise<CtModelDto> {
    if (id === CT_DEFAULT_MODEL_ID) return BUILT_IN;
    const model = await this.deps.repo.find(id);
    if (!model) throw new NotFoundError('Modelo');
    return toDto(model);
  }

  /** The id when it names an existing model; otherwise the default (deleted / unknown models). */
  async resolveId(id: string | undefined): Promise<string> {
    if (!id || id === CT_DEFAULT_MODEL_ID) return CT_DEFAULT_MODEL_ID;
    return (await this.deps.repo.find(id)) ? id : CT_DEFAULT_MODEL_ID;
  }

  /** The look a document is rendered with (the default one for a missing / deleted model). */
  async layoutFor(id: string | undefined): Promise<CtLayout> {
    if (!id || id === CT_DEFAULT_MODEL_ID) return DEFAULT_CT_LAYOUT;
    return (await this.deps.repo.find(id))?.layout ?? DEFAULT_CT_LAYOUT;
  }

  async create(body: unknown): Promise<CtModelDto> {
    const input = ctModelInputSchema.parse(body);
    const existing = await this.deps.repo.list();
    if (existing.length >= CT_LAYOUT_LIMITS.maxModels) {
      throw new DomainError(
        `Limite de ${CT_LAYOUT_LIMITS.maxModels} modelos atingido. Exclua algum modelo.`,
        'ct_model_limit',
        400,
      );
    }
    this.assertFreeName(input.name, existing);
    const now = this.deps.clock.now();
    const model: CtModel = {
      id: this.deps.ids.next(),
      name: input.name,
      layout: input.layout,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repo.save(model);
    return toDto(model);
  }

  async update(id: string, body: unknown): Promise<CtModelDto> {
    this.assertEditable(id);
    const input = ctModelInputSchema.parse(body);
    const current = await this.deps.repo.find(id);
    if (!current) throw new NotFoundError('Modelo');
    this.assertFreeName(input.name, await this.deps.repo.list(), id);
    const model: CtModel = {
      ...current,
      name: input.name,
      layout: input.layout,
      updatedAt: this.deps.clock.now(),
    };
    await this.deps.repo.save(model);
    return toDto(model);
  }

  /** Sessions that used it fall back to the default model. */
  async remove(id: string): Promise<void> {
    this.assertEditable(id);
    if (!(await this.deps.repo.find(id))) throw new NotFoundError('Modelo');
    await this.deps.repo.delete(id);
  }

  /** HTML of a sample document with an unsaved look: the live preview of the editor. */
  preview(body: unknown): { html: string } {
    const { layout } = ctLayoutPreviewSchema.parse(body);
    return { html: this.deps.previewSample(layout) };
  }

  private assertEditable(id: string): void {
    if (id === CT_DEFAULT_MODEL_ID) {
      throw new DomainError(
        'O modelo Padrão não pode ser alterado nem excluído. Duplique-o para personalizar.',
        'ct_model_builtin',
        403,
      );
    }
  }

  private assertFreeName(name: string, existing: CtModel[], selfId?: string): void {
    if (sameName(name, CT_DEFAULT_MODEL_NAME)) {
      throw new ConflictError(
        `"${CT_DEFAULT_MODEL_NAME}" é o nome do modelo padrão. Escolha outro nome.`,
      );
    }
    if (existing.some((m) => m.id !== selfId && sameName(m.name, name))) {
      throw new ConflictError('Já existe um modelo com esse nome.');
    }
  }
}
