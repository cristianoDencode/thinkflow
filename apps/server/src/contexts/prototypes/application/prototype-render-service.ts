import {
  prototypeRenderQuerySchema,
  prototypeSendSchema,
  type PrototypeRenderDto,
  type PrototypeScene,
  type PrototypeSendResultDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { ConflictError, DomainError, NotFoundError } from '../../../shared/kernel/errors';
import { findBuiltinTemplate } from '../domain/builtin-templates';
import type {
  DocumentStepSink,
  PrototypeFileStore,
  PrototypeRenderer,
  PrototypeRepository,
} from '../domain/ports';
import {
  assetKey,
  renderDocument,
  thumbnailKey,
  withSentTo,
  type Prototype,
} from '../domain/prototype';
import { sceneAssetIds, sceneToHtml } from '../domain/scene';
import { thumbnailUrl, type PrototypeService } from './prototype-service';

/** A PNG of a full-HD screen is well under this; it only guards against a runaway render. */
const MAX_PNG_BYTES = 64 * 1024 * 1024;
/** Same cap as the images of test steps (`TEST_LIMITS.maxImageBytes`). */
const MAX_STEP_IMAGE_BYTES = 15 * 1024 * 1024;

export interface PrototypeRenderServiceDeps {
  prototypes: PrototypeService;
  repo: PrototypeRepository;
  files: PrototypeFileStore;
  renderer: PrototypeRenderer;
  documents: DocumentStepSink;
  clock: Clock;
}

export interface RenderOptions {
  scale?: 1 | 2;
  force?: boolean;
}

/** Renders prototypes to PNG and sends the image to the test-case document of a session. */
export class PrototypeRenderService {
  /** One render at a time per prototype and scale: concurrent clicks share the same work. */
  private readonly inflight = new Map<string, Promise<PrototypeRenderDto>>();

  /** Preview PNGs of the built-in templates (static content: rendered once per process). */
  private readonly builtinPreviews = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly deps: PrototypeRenderServiceDeps) {}

  /** PNG preview of a built-in template at its default size (nothing is stored). */
  builtinThumbnail(templateId: string): Promise<Uint8Array> {
    const template = findBuiltinTemplate(templateId);
    if (!template) return Promise.reject(new NotFoundError('Modelo'));
    let preview = this.builtinPreviews.get(templateId);
    if (!preview) {
      const { width, height, html, css } = template.snapshot;
      preview = this.deps.renderer
        .render({ document: renderDocument(html, css), width, height, scale: 1 })
        .then((outcome) => {
          if (outcome.ok) return outcome.png;
          throw new DomainError(
            `Não foi possível gerar a prévia do modelo: ${outcome.error}`,
            outcome.unavailable ? 'renderer_unavailable' : 'render_failed',
            outcome.unavailable ? 503 : 502,
          );
        });
      this.builtinPreviews.set(templateId, preview);
      // a failure is not remembered: the next request tries again
      preview.catch(() => this.builtinPreviews.delete(templateId));
    }
    return preview;
  }

  /** POST /render: query-string input, already validated by the route. */
  renderFromQuery(id: string, query: unknown): Promise<PrototypeRenderDto> {
    const input = prototypeRenderQuerySchema.parse(query ?? {});
    return this.render(id, { scale: input.scale === 2 ? 2 : 1, force: input.force });
  }

  async render(id: string, options: RenderOptions = {}): Promise<PrototypeRenderDto> {
    const scale = options.scale ?? 1;
    const key = `${id}:${scale}:${options.force ? 'f' : ''}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const work = this.renderNow(id, scale, options.force ?? false).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, work);
    return work;
  }

  private dto(
    p: Prototype,
    extra: { cached: boolean; blockedRequests: number | null; width: number; height: number },
  ): PrototypeRenderDto {
    return {
      thumbnailUrl: thumbnailUrl(p),
      width: extra.width,
      height: extra.height,
      scale: p.renderedScale,
      renderedVersionId: p.renderedVersionId ?? p.currentVersionId,
      cached: extra.cached,
      blockedRequests: extra.blockedRequests,
    };
  }

  private async renderNow(id: string, scale: 1 | 2, force: boolean): Promise<PrototypeRenderDto> {
    const { prototypes, repo, files, renderer, clock } = this.deps;
    const current = await prototypes.require(id);
    if (
      !force &&
      current.thumbnailKey &&
      current.renderedVersionId === current.currentVersionId &&
      current.renderedScale === scale &&
      (await files.get(current.thumbnailKey))
    ) {
      return this.dto(current, {
        cached: true,
        blockedRequests: null,
        width: current.width * scale,
        height: current.height * scale,
      });
    }

    await files.assertWritable();
    const content = await prototypes.currentContent(current);
    const outcome = await renderer.render({
      document: content.scene
        ? await this.sceneDocument(id, content.scene, current)
        : renderDocument(content.html, content.css),
      width: current.width,
      height: current.height,
      scale,
    });
    if (!outcome.ok) {
      throw outcome.unavailable
        ? new DomainError(
            `Não foi possível gerar a imagem: o Chromium não está disponível (${outcome.error})`,
            'renderer_unavailable',
            503,
          )
        : new DomainError(
            `Não foi possível gerar a imagem do protótipo: ${outcome.error}`,
            'render_failed',
            502,
          );
    }
    const key = thumbnailKey(id);
    await files.put(key, outcome.png, 'image/png', { maxBytes: MAX_PNG_BYTES });
    // an auto-save may have rewritten this very version while Chromium drew it: the image is then
    // stale, so it is not recorded as the version's render (the next render draws the new content)
    const latest = await prototypes.require(id);
    if (latest.updatedAt !== current.updatedAt) {
      return this.dto(latest, {
        cached: false,
        blockedRequests: outcome.blockedRequests,
        width: outcome.width,
        height: outcome.height,
      });
    }
    const renderedAt = clock.now();
    await repo.setRender(id, {
      thumbnailKey: key,
      renderedVersionId: current.currentVersionId,
      renderedAt,
      renderedScale: scale,
    });
    const saved = await prototypes.require(id);
    return this.dto(saved, {
      cached: false,
      blockedRequests: outcome.blockedRequests,
      width: outcome.width,
      height: outcome.height,
    });
  }

  /** A "Modo Livre" version: the scene with its images inlined (the render has no network). */
  private async sceneDocument(
    id: string,
    scene: PrototypeScene,
    size: Pick<Prototype, 'width' | 'height'>,
  ): Promise<string> {
    const assets = new Map<string, string>();
    for (const asset of sceneAssetIds(scene)) {
      const bytes = await this.deps.files.get(assetKey(id, asset));
      if (bytes)
        assets.set(asset, `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
    }
    return sceneToHtml(scene, size, assets);
  }

  async sendToSession(id: string, body: unknown): Promise<PrototypeSendResultDto> {
    const input = prototypeSendSchema.parse(body);
    const { prototypes, repo, files, documents, clock } = this.deps;
    const prototype = await prototypes.require(id);
    const sessionId = input.sessionId ?? prototype.sessionId;
    if (!sessionId) {
      throw new ConflictError(
        'Este protótipo não está vinculado a uma sessão de teste. Escolha a sessão de destino.',
      );
    }
    // refuse before spending a render when the session cannot take the image
    await documents.check({
      sessionId,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      ...(input.afterStepId ? { afterStepId: input.afterStepId } : {}),
    });

    const render = await this.render(id, { scale: input.scale ?? 1 });
    const latest = await prototypes.require(id);
    const png = latest.thumbnailKey ? await files.get(latest.thumbnailKey) : null;
    if (!png) {
      throw new DomainError(
        'A imagem gerada não foi encontrada. Tente novamente.',
        'render_missing',
        500,
      );
    }
    if (png.byteLength > MAX_STEP_IMAGE_BYTES) {
      throw new DomainError(
        `A imagem tem mais de ${MAX_STEP_IMAGE_BYTES / (1024 * 1024)} MB. Use a escala 1x ou reduza o tamanho do protótipo.`,
        'image_too_large',
        413,
      );
    }

    let stepId: string;
    if (input.target === 'newStep') {
      const added = await documents.addCaptureStep({
        sessionId,
        ...(input.afterStepId ? { afterStepId: input.afterStepId } : {}),
        title: input.title || `Protótipo: ${prototype.name}`.slice(0, 300),
        include: input.include ?? true,
        png,
        width: render.width,
        height: render.height,
      });
      stepId = added.stepId;
    } else {
      stepId = input.stepId!;
      await documents.replaceStepImage({
        sessionId,
        stepId,
        ...(input.include !== undefined ? { include: input.include } : {}),
        png,
        width: render.width,
        height: render.height,
      });
    }

    const sentTo = withSentTo(latest.sentTo, { sessionId, stepId, at: clock.now() });
    await repo.setSentTo(id, sentTo);
    return { sessionId, stepId, target: input.target, render, sentTo };
  }
}
