import {
  AUTOSAVE_MERGE_MS,
  AUTOSAVE_NOTE,
  PROTOTYPE_LIMITS,
  SCENE_LIMITS,
  prototypeBlockInputSchema,
  prototypeBlockUpdateSchema,
  prototypeCreateSchema,
  prototypeImportSchema,
  prototypeSceneSchema,
  prototypeSaveAsTemplateSchema,
  prototypeUpdateSchema,
  type PrototypeBlockDto,
  type PrototypeCaptureResultDto,
  type PrototypeDetailDto,
  type PrototypeDto,
  type PrototypeKind,
  type PrototypeScene,
  type PrototypeSnapshot,
  type PrototypeTemplateDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { ConflictError, DomainError, NotFoundError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import {
  BUILTIN_TEMPLATES,
  findBuiltinTemplate,
  isBuiltinTemplateId,
} from '../domain/builtin-templates';
import { sanitizeHtml, sanitizeStylesheet } from '../domain/html-sanitizer';
import { hasSystemProfile } from '../domain/system-profiles';
import type { PrototypeFileStore, PrototypeRepository, SessionLookup } from '../domain/ports';
import { sceneAssetIds } from '../domain/scene';
import {
  assetKey,
  BLANK_SNAPSHOT,
  captureName,
  clampSize,
  formatCaptureDate,
  countComponents,
  prepareCapture,
  prepareSnapshot,
  PrototypeTooLargeError,
  prototypePrefix,
  snapshotBytes,
  sourceOf,
  versionKey,
  type Prototype,
  type PrototypeVersion,
} from '../domain/prototype';

export interface PrototypeServiceDeps {
  repo: PrototypeRepository;
  files: PrototypeFileStore;
  sessions: SessionLookup;
  clock: Clock;
  ids: IdGenerator;
  onError?: (err: unknown) => void;
  /** A prototype was created or got a new current version (capture, edit, restore): fire and forget. */
  onVersionSaved?: (prototypeId: string) => void;
}

/** A screen as the recorded browser captured it (raw: not yet sanitized nor scrubbed). */
export interface CapturedScreen {
  sessionId: string;
  stepId: string | null;
  menuPath: string | null;
  /** Keep the typed values and grid cells (default: scrubbed for LGPD). */
  keepData: boolean;
  screen: {
    html: string;
    css: string;
    width: number;
    height: number;
    url: string | null;
    title: string | null;
    /** Frames left as empty boxes (another origin, too deep): reported to the person. */
    blankFrames?: number;
  };
}

/** What a version file holds: the HTML/CSS and, in "Modo Livre", the scene. */
export interface StoredContent {
  html: string;
  css: string;
  scene?: PrototypeScene;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Authenticated URL of the rendered PNG; `v` busts the browser cache after a re-render. */
export const thumbnailUrl = (p: Pick<Prototype, 'id' | 'renderedAt' | 'updatedAt'>): string =>
  `/api/prototypes/${p.id}/thumbnail?v=${p.renderedAt ?? p.updatedAt}`;

/** Authenticated URL of the preview PNG of a built-in template. */
export const builtinThumbnailUrl = (templateId: string): string =>
  `/api/prototypes/templates/${encodeURIComponent(templateId)}/thumbnail`;

export function toPrototypeDto(p: Prototype): PrototypeDto {
  const linked = p.sessionId !== null;
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    source: p.source,
    sessionId: p.sessionId,
    sessionName: linked ? p.sessionName : null,
    stepId: linked ? p.stepId : null,
    width: p.width,
    height: p.height,
    scrubbed: p.scrubbed,
    versionCount: p.versionCount,
    thumbnailUrl: p.thumbnailKey ? thumbnailUrl(p) : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export class PrototypeService {
  constructor(private readonly deps: PrototypeServiceDeps) {}

  /** `kind` defaults to the prototypes (templates only show up when asked for, or with `all`). */
  async list(
    filter: { sessionId?: string; kind?: PrototypeKind | 'all' } = {},
  ): Promise<PrototypeDto[]> {
    const kind = filter.kind ?? 'prototype';
    const items = await this.deps.repo.list({
      ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
      ...(kind === 'all' ? {} : { kind }),
    });
    return items.map(toPrototypeDto);
  }

  /** Built-in templates first, then the user's (newest first). */
  async templates(): Promise<PrototypeTemplateDto[]> {
    const mine = await this.deps.repo.list({ kind: 'template' });
    return [
      ...BUILTIN_TEMPLATES.map((t): PrototypeTemplateDto => ({
        id: t.id,
        name: t.name,
        description: t.description,
        builtin: true,
        width: t.snapshot.width,
        height: t.snapshot.height,
        sizes: t.sizes,
        thumbnailUrl: builtinThumbnailUrl(t.id),
        updatedAt: 0,
      })),
      ...mine.map((p): PrototypeTemplateDto => ({
        id: p.id,
        name: p.name,
        description: '',
        builtin: false,
        width: p.width,
        height: p.height,
        sizes: [],
        thumbnailUrl: p.thumbnailKey ? thumbnailUrl(p) : null,
        updatedAt: p.updatedAt,
      })),
    ];
  }

  async require(id: string): Promise<Prototype> {
    const prototype = await this.deps.repo.find(id);
    if (!prototype) throw new NotFoundError('Protótipo');
    return prototype;
  }

  async get(id: string): Promise<PrototypeDetailDto> {
    return this.detail(await this.require(id));
  }

  async create(body: unknown): Promise<PrototypeDetailDto> {
    const input = prototypeCreateSchema.parse(body);
    const sessionId = await this.checkedSession(input.sessionId ?? null);
    if (input.fromTemplateId)
      return this.createFromTemplate(input.fromTemplateId, input, sessionId);
    const snapshot = prepareSnapshot(input.snapshot ?? BLANK_SNAPSHOT);
    const prototype = await this.store({
      name: input.name,
      sessionId,
      stepId: null,
      source: {
        ...sourceOf({
          url: input.source?.url ?? null,
          title: input.source?.title ?? null,
          menuPath: input.source?.menuPath ?? null,
        }),
        ...(input.source?.file ? { file: input.source.file } : {}),
      },
      snapshot,
      scrubbed: false,
      note: input.snapshot ? 'Importado' : 'Em branco',
    });
    return this.detail(prototype);
  }

  /** A new prototype that starts as a copy of a template (built-in asset or the user's own). */
  private async createFromTemplate(
    templateId: string,
    input: { name: string; width?: number | undefined; height?: number | undefined },
    sessionId: string | null,
  ): Promise<PrototypeDetailDto> {
    let snapshot: PrototypeSnapshot;
    let source: Prototype['source'];
    let templateName: string;
    let assetsFrom: string | undefined;
    if (isBuiltinTemplateId(templateId)) {
      const builtin = findBuiltinTemplate(templateId);
      if (!builtin) throw new NotFoundError('Modelo');
      snapshot = builtin.snapshot;
      source = sourceOf({ url: null, title: builtin.name, menuPath: null });
      templateName = builtin.name;
    } else {
      const template = await this.deps.repo.find(templateId);
      if (!template || template.kind !== 'template') throw new NotFoundError('Modelo');
      snapshot = {
        ...(await this.readFile(template.id, template.currentVersionId)),
        width: template.width,
        height: template.height,
      };
      source = template.source;
      templateName = template.name;
      assetsFrom = template.id;
    }
    const size = clampSize(input.width ?? snapshot.width, input.height ?? snapshot.height);
    const prototype = await this.store({
      name: input.name,
      sessionId,
      stepId: null,
      source,
      snapshot: prepareSnapshot({ ...snapshot, ...size }),
      scrubbed: false,
      note: `Criado do modelo ${templateName}`.slice(0, 200),
      ...(assetsFrom ? { assetsFrom } : {}),
    });
    return this.detail(prototype);
  }

  /** Copies the current version of a prototype into a new template (no link to the original). */
  async saveAsTemplate(id: string, body: unknown): Promise<PrototypeDetailDto> {
    const input = prototypeSaveAsTemplateSchema.parse(body);
    const current = await this.require(id);
    const content = await this.readFile(current.id, current.currentVersionId);
    const template = await this.store({
      name: input.name,
      kind: 'template',
      sessionId: null,
      stepId: null,
      source: current.source,
      snapshot: prepareSnapshot({ ...content, width: current.width, height: current.height }),
      scrubbed: current.scrubbed,
      note: `Modelo criado de ${current.name}`.slice(0, 200),
      assetsFrom: current.id,
    });
    return this.detail(template);
  }

  /** Called by the recorder: the screen the person is looking at becomes a prototype. */
  async createFromCapture(input: CapturedScreen): Promise<PrototypeCaptureResultDto> {
    const now = this.deps.clock.now();
    const sessionId = await this.checkedSession(input.sessionId);
    const { screen } = input;
    const source = sourceOf({ url: screen.url, title: screen.title, menuPath: input.menuPath });
    const { snapshot, components } = prepareCapture(
      { html: screen.html, css: screen.css, ...clampSize(screen.width, screen.height) },
      { scrub: !input.keepData },
    );
    const warnings: string[] = [];
    if ((screen.blankFrames ?? 0) > 0) {
      warnings.push(
        `${screen.blankFrames} quadro(s) de outra origem não puderam ser lidos e ficaram como caixas vazias.`,
      );
    }
    const prototype = await this.store({
      name: captureName(source, now),
      sessionId,
      stepId: input.stepId,
      source,
      snapshot,
      scrubbed: !input.keepData,
      note: 'Captura',
    });
    return {
      ...toPrototypeDto(prototype),
      components: components as Record<string, number>,
      warnings,
    };
  }

  /**
   * A screen sent by an external mapper (`POST /api/prototypes/import`, formatVersion 1): the same
   * treatment as an in-app capture (sanitize, scrub unless `keepData`, annotate components), but
   * not linked to a test session.
   */
  async importCapture(body: unknown): Promise<PrototypeCaptureResultDto> {
    const input = prototypeImportSchema.parse(body);
    const { snapshot: screen } = input;
    const source = {
      ...sourceOf({
        url: input.source?.url ?? null,
        title: input.source?.title ?? null,
        menuPath: input.source?.menuPath ?? null,
      }),
    };
    const file = input.source?.file?.replace(/\s+/g, ' ').trim();
    if (file) source.file = file.slice(0, 300);
    const { snapshot } = prepareCapture(
      { html: screen.html, css: screen.css, ...clampSize(screen.width, screen.height) },
      { scrub: !input.keepData },
    );
    // counts what is in the stored HTML: markers the mapper wrote itself count too
    const components = countComponents(snapshot.html);
    const warnings: string[] = [];
    const system = input.source?.system;
    if (system && !hasSystemProfile(system)) {
      warnings.push(
        `Sistema "${system.slice(0, 60)}" sem perfil próprio: foram usadas as heurísticas genéricas de reconhecimento de componentes.`,
      );
    }
    if (Object.keys(components).length === 0) {
      warnings.push('Nenhum componente reconhecido; a tela segue editável como HTML livre.');
    }
    const prototype = await this.store({
      name: input.name,
      sessionId: null,
      stepId: null,
      source,
      snapshot,
      scrubbed: !input.keepData,
      note: 'Captura importada',
    });
    return {
      ...toPrototypeDto(prototype),
      components: components as Record<string, number>,
      warnings,
    };
  }

  async update(id: string, body: unknown): Promise<PrototypeDetailDto> {
    const input = prototypeUpdateSchema.parse(body);
    const current = await this.require(id);
    const patch: Partial<Pick<Prototype, 'name' | 'sessionId' | 'stepId'>> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.sessionId !== undefined) {
      const sessionId = await this.checkedSession(input.sessionId);
      if (sessionId !== current.sessionId) {
        patch.sessionId = sessionId;
        patch.stepId = null; // the step belonged to the previous session
      }
    }
    if (input.snapshot) {
      const snapshot = prepareSnapshot(input.snapshot);
      if (snapshot.scene) await this.assertAssetsExist(id, snapshot.scene);
      const autosaved = input.autosave ? await this.recentAutosave(current) : null;
      if (autosaved) await this.replaceVersion(current, autosaved, snapshot, patch);
      else {
        const note = input.autosave ? AUTOSAVE_NOTE : input.note || 'Edição';
        await this.addVersion(current, snapshot, note, patch);
      }
    } else if (Object.keys(patch).length > 0) {
      await this.deps.repo.update(id, patch, this.deps.clock.now());
    }
    return this.detail(await this.require(id));
  }

  async delete(id: string): Promise<void> {
    await this.require(id);
    await this.deps.repo.delete(id);
    try {
      await this.deps.files.deletePrefix(prototypePrefix(id));
    } catch (err) {
      this.deps.onError?.(err); // the prototype is gone; stray files are harmless
    }
  }

  async version(
    id: string,
    versionId: string,
  ): Promise<Pick<PrototypeSnapshot, 'html' | 'css' | 'width' | 'height' | 'scene'>> {
    await this.require(id);
    const version = await this.deps.repo.findVersion(id, versionId);
    if (!version) throw new NotFoundError('Versão do protótipo');
    return {
      ...(await this.readFile(id, versionId)),
      width: version.width,
      height: version.height,
    };
  }

  async restore(id: string, versionId: string): Promise<PrototypeDetailDto> {
    const current = await this.require(id);
    const version = await this.deps.repo.findVersion(id, versionId);
    if (!version) throw new NotFoundError('Versão do protótipo');
    const file = await this.readFile(id, versionId);
    await this.addVersion(
      current,
      { ...file, width: version.width, height: version.height },
      `Restaurado de ${formatCaptureDate(version.createdAt)}`,
      {},
    );
    return this.detail(await this.require(id));
  }

  /** The HTML/CSS (and scene) of the current version: what gets rendered to PNG. */
  async currentContent(p: Prototype): Promise<StoredContent> {
    return this.readFile(p.id, p.currentVersionId);
  }

  /** The last rendered PNG; null until one exists. */
  async thumbnail(id: string): Promise<Uint8Array | null> {
    const p = await this.require(id);
    return p.thumbnailKey ? this.deps.files.get(p.thumbnailKey) : null;
  }

  /* ------------------------------ blocks ------------------------------ */

  blocks(): Promise<PrototypeBlockDto[]> {
    return this.deps.repo.blocks();
  }

  async createBlock(body: unknown): Promise<PrototypeBlockDto> {
    const input = prototypeBlockInputSchema.parse(body);
    if ((await this.deps.repo.countBlocks()) >= PROTOTYPE_LIMITS.maxBlocks) {
      throw new ConflictError(`Limite de ${PROTOTYPE_LIMITS.maxBlocks} blocos atingido.`);
    }
    const html = sanitizeHtml(input.html);
    const css = sanitizeStylesheet(input.css);
    if (snapshotBytes(html, css) > PROTOTYPE_LIMITS.maxBlockBytes) {
      throw new PrototypeTooLargeError(PROTOTYPE_LIMITS.maxBlockBytes);
    }
    const block: PrototypeBlockDto = {
      id: this.deps.ids.next(),
      name: input.name,
      category: input.category,
      html,
      css,
      source: input.source ?? null,
      createdAt: this.deps.clock.now(),
    };
    await this.deps.repo.insertBlock(block);
    return block;
  }

  async updateBlock(id: string, body: unknown): Promise<PrototypeBlockDto> {
    const input = prototypeBlockUpdateSchema.parse(body);
    if (!(await this.deps.repo.findBlock(id))) throw new NotFoundError('Bloco');
    await this.deps.repo.updateBlock(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
    });
    const block = await this.deps.repo.findBlock(id);
    if (!block) throw new NotFoundError('Bloco');
    return block;
  }

  async deleteBlock(id: string): Promise<void> {
    if (!(await this.deps.repo.findBlock(id))) throw new NotFoundError('Bloco');
    await this.deps.repo.deleteBlock(id);
  }

  /* ------------------------------ internals ------------------------------ */

  private async checkedSession(sessionId: string | null): Promise<string | null> {
    if (sessionId === null) return null;
    if (!(await this.deps.sessions.exists(sessionId))) {
      throw new DomainError('Sessão de teste não encontrada.', 'not_found', 404);
    }
    return sessionId;
  }

  private async detail(p: Prototype): Promise<PrototypeDetailDto> {
    const [file, versions] = await Promise.all([
      this.readFile(p.id, p.currentVersionId),
      this.deps.repo.versions(p.id),
    ]);
    return {
      ...toPrototypeDto(p),
      versionId: p.currentVersionId,
      html: file.html,
      css: file.css,
      ...(file.scene ? { scene: file.scene } : {}),
      components: countComponents(file.html),
      versions: versions.map((v) => ({ id: v.id, createdAt: v.createdAt, note: v.note })),
      sentTo: p.sentTo,
    };
  }

  private async readFile(prototypeId: string, versionId: string): Promise<StoredContent> {
    const bytes = await this.deps.files.get(versionKey(prototypeId, versionId));
    if (!bytes) throw new NotFoundError('Conteúdo do protótipo');
    const parsed = JSON.parse(decoder.decode(bytes)) as {
      html?: unknown;
      css?: unknown;
      scene?: unknown;
    };
    const scene = parsed.scene === undefined ? null : prototypeSceneSchema.safeParse(parsed.scene);
    return {
      html: typeof parsed.html === 'string' ? parsed.html : '',
      css: typeof parsed.css === 'string' ? parsed.css : '',
      ...(scene?.success ? { scene: scene.data } : {}),
    };
  }

  /** 400 when the scene uses an image that was never uploaded to this prototype. */
  private async assertAssetsExist(prototypeId: string, scene: PrototypeScene): Promise<void> {
    for (const asset of sceneAssetIds(scene)) {
      if (!(await this.deps.files.has(assetKey(prototypeId, asset)))) {
        throw new DomainError(
          'A composição usa uma imagem que não existe neste protótipo. Envie a imagem de novo.',
          'scene_asset_missing',
          400,
        );
      }
    }
  }

  /** The images of `scene` copied from one prototype to another (a template and its copies). */
  private async copyAssets(fromId: string, toId: string, scene: PrototypeScene): Promise<void> {
    const { files } = this.deps;
    for (const asset of sceneAssetIds(scene)) {
      const bytes = await files.get(assetKey(fromId, asset));
      if (!bytes) {
        throw new DomainError(
          'A composição usa uma imagem que não foi encontrada.',
          'scene_asset_missing',
          400,
        );
      }
      await files.put(assetKey(toId, asset), bytes, 'image/png', {
        maxBytes: SCENE_LIMITS.maxAssetBytes,
      });
    }
  }

  private async writeFile(
    prototypeId: string,
    versionId: string,
    snapshot: PrototypeSnapshot,
  ): Promise<void> {
    const body = encoder.encode(
      JSON.stringify({
        html: snapshot.html,
        css: snapshot.css,
        ...(snapshot.scene ? { scene: snapshot.scene } : {}),
      }),
    );
    await this.deps.files.put(versionKey(prototypeId, versionId), body, 'application/json', {
      maxBytes: PROTOTYPE_LIMITS.maxSnapshotBytes * 2,
    });
  }

  /** A new prototype with its first version. */
  private async store(input: {
    name: string;
    kind?: PrototypeKind;
    sessionId: string | null;
    stepId: string | null;
    source: Prototype['source'];
    snapshot: PrototypeSnapshot;
    scrubbed: boolean;
    note: string;
    /** Prototype whose images the snapshot's scene uses (they are copied to the new one). */
    assetsFrom?: string;
  }): Promise<Prototype> {
    const { repo, files, clock, ids } = this.deps;
    if ((await repo.count()) >= PROTOTYPE_LIMITS.maxPrototypes) {
      throw new ConflictError(`Limite de ${PROTOTYPE_LIMITS.maxPrototypes} protótipos atingido.`);
    }
    await files.assertWritable();
    const now = clock.now();
    const id = ids.next();
    const version: PrototypeVersion = {
      id: ids.next(),
      prototypeId: id,
      seq: 1,
      note: input.note,
      width: input.snapshot.width,
      height: input.snapshot.height,
      bytes: snapshotBytes(input.snapshot.html, input.snapshot.css),
      createdAt: now,
    };
    const prototype: Prototype = {
      id,
      name: input.name,
      kind: input.kind ?? 'prototype',
      sessionId: input.sessionId,
      sessionName: null,
      stepId: input.stepId,
      source: input.source,
      width: input.snapshot.width,
      height: input.snapshot.height,
      scrubbed: input.scrubbed,
      currentVersionId: version.id,
      versionCount: 1,
      thumbnailKey: null,
      renderedVersionId: null,
      renderedAt: null,
      renderedScale: 1,
      sentTo: [],
      createdAt: now,
      updatedAt: now,
    };
    const { scene } = input.snapshot;
    if (scene && !input.assetsFrom && sceneAssetIds(scene).length > 0) {
      // images belong to one prototype: a brand new one has none to refer to
      throw new DomainError(
        'A composição usa imagens que não existem neste protótipo.',
        'scene_asset_missing',
        400,
      );
    }
    try {
      await this.writeFile(id, version.id, input.snapshot);
      if (scene && input.assetsFrom) await this.copyAssets(input.assetsFrom, id, scene);
      await repo.insert(prototype, version);
    } catch (err) {
      await files.deletePrefix(prototypePrefix(id)).catch(() => undefined);
      throw err;
    }
    this.versionSaved(id);
    return this.require(id);
  }

  /**
   * The current version when it is itself an auto-save younger than `AUTOSAVE_MERGE_MS`: the next
   * auto-save overwrites it instead of piling up versions (a burst of edits is one version).
   */
  private async recentAutosave(current: Prototype): Promise<PrototypeVersion | null> {
    const version = await this.deps.repo.findVersion(current.id, current.currentVersionId);
    if (!version || version.note !== AUTOSAVE_NOTE) return null;
    return this.deps.clock.now() - version.createdAt < AUTOSAVE_MERGE_MS ? version : null;
  }

  /** `snapshot` replaces the content of `version` (the current one): same id, same `seq`, new time. */
  private async replaceVersion(
    current: Prototype,
    version: PrototypeVersion,
    snapshot: PrototypeSnapshot,
    patch: Partial<Pick<Prototype, 'name' | 'sessionId' | 'stepId'>>,
  ): Promise<void> {
    const { repo, files, clock } = this.deps;
    await files.assertWritable();
    await this.writeFile(current.id, version.id, snapshot);
    await repo.replaceVersion(
      current.id,
      version.id,
      {
        width: snapshot.width,
        height: snapshot.height,
        bytes: snapshotBytes(snapshot.html, snapshot.css),
        createdAt: clock.now(),
      },
      patch,
    );
    this.versionSaved(current.id);
  }

  /** Stores `snapshot` as the newest (current) version; old versions beyond the cap are dropped. */
  private async addVersion(
    current: Prototype,
    snapshot: PrototypeSnapshot,
    note: string,
    patch: Partial<Pick<Prototype, 'name' | 'sessionId' | 'stepId'>>,
  ): Promise<void> {
    const { repo, files, clock, ids } = this.deps;
    await files.assertWritable();
    const latest = (await repo.versions(current.id))[0];
    const version: PrototypeVersion = {
      id: ids.next(),
      prototypeId: current.id,
      seq: (latest?.seq ?? 0) + 1,
      note,
      width: snapshot.width,
      height: snapshot.height,
      bytes: snapshotBytes(snapshot.html, snapshot.css),
      createdAt: clock.now(),
    };
    await this.writeFile(current.id, version.id, snapshot);
    let dropped: string[];
    try {
      ({ dropped } = await repo.addVersion(
        current.id,
        version,
        patch,
        PROTOTYPE_LIMITS.maxVersionsPerPrototype,
      ));
    } catch (err) {
      await files.delete(versionKey(current.id, version.id)).catch(() => undefined);
      throw err;
    }
    for (const versionId of dropped) {
      await files
        .delete(versionKey(current.id, versionId))
        .catch((err: unknown) => this.deps.onError?.(err));
    }
    this.versionSaved(current.id);
  }

  private versionSaved(id: string): void {
    try {
      this.deps.onVersionSaved?.(id);
    } catch (err) {
      this.deps.onError?.(err); // a failing hook never fails the save
    }
  }
}
