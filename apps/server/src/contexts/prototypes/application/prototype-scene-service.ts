import { createHash, randomBytes } from 'node:crypto';
import {
  FREE_WRAPPER_ATTR,
  PROTOTYPE_LIMITS,
  SCENE_LIMITS,
  sceneAssetIdSchema,
  sceneAssetUploadSchema,
  sceneBlockRenderSchema,
  type PrototypeFreeLayoutDto,
  type PrototypeScene,
  type SceneAssetDto,
  type SceneFromHtmlDto,
  type SceneLayer,
} from '@thinkflow/shared';
import { DomainError, NotFoundError } from '../../../shared/kernel/errors';
import { sanitizeHtml, sanitizeStylesheet } from '../domain/html-sanitizer';
import type { PrototypeFailure, PrototypeFileStore, PrototypeRenderer } from '../domain/ports';
import {
  assetKey,
  prepareSnapshot,
  PrototypeTooLargeError,
  renderDocument,
  snapshotBytes,
} from '../domain/prototype';
import { blockDocument, markSceneLayers, pngDimensions } from '../domain/scene';
import type { PrototypeService } from './prototype-service';

/** Larger than any screen a prototype can have; a "PNG" claiming more is not an image we draw. */
const MAX_ASSET_SIDE = 16_384;
/** Viewport the palette blocks are drawn in (the element is cut out of it). */
const BLOCK_VIEWPORT = { width: 1600, height: 1200 } as const;
/** Base64 grows the payload by 4/3. */
const MAX_BASE64_LENGTH = Math.ceil((SCENE_LIMITS.maxAssetBytes * 4) / 3) + 8;
/** A `data-tf-free` wrapper (not `data-tf-free-src`, which marks the hidden originals). */
const FREE_WRAPPER = new RegExp(`\\s${FREE_WRAPPER_ATTR}(?=[\\s=>/])`);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Body limit of `POST /assets`: the base64 plus the JSON envelope. */
export const ASSET_BODY_LIMIT = MAX_BASE64_LENGTH + 64 * 1024;

export interface PrototypeSceneServiceDeps {
  prototypes: Pick<PrototypeService, 'require' | 'currentContent'>;
  files: PrototypeFileStore;
  renderer: PrototypeRenderer;
}

/** The images of the "Modo Livre" and the decomposition of a screen into a scene. */
export class PrototypeSceneService {
  constructor(private readonly deps: PrototypeSceneServiceDeps) {}

  /** The PNG of an asset; 404 when the prototype or the asset does not exist. */
  async asset(prototypeId: string, asset: string): Promise<Uint8Array> {
    const id = sceneAssetIdSchema.parse(asset);
    await this.deps.prototypes.require(prototypeId);
    const bytes = await this.deps.files.get(assetKey(prototypeId, id));
    if (!bytes) throw new NotFoundError('Imagem');
    return bytes;
  }

  /** A pasted/uploaded PNG (base64) becomes an asset. */
  async upload(prototypeId: string, body: unknown): Promise<SceneAssetDto> {
    const input = sceneAssetUploadSchema.parse(body);
    await this.deps.prototypes.require(prototypeId);
    const raw = input.png.replace(/^data:image\/png;base64,/, '').replace(/\s+/g, '');
    if (raw.length > MAX_BASE64_LENGTH) throw tooLarge();
    if (!BASE64.test(raw)) throw badImage();
    return this.store(prototypeId, new Uint8Array(Buffer.from(raw, 'base64')));
  }

  /** A palette block (HTML + CSS) drawn on the e-Cidade window background, as an asset. */
  async fromBlock(prototypeId: string, body: unknown): Promise<SceneAssetDto> {
    const input = sceneBlockRenderSchema.parse(body);
    await this.deps.prototypes.require(prototypeId);
    if (snapshotBytes(input.html, input.css) > PROTOTYPE_LIMITS.maxBlockBytes) {
      throw new PrototypeTooLargeError(PROTOTYPE_LIMITS.maxBlockBytes);
    }
    // sanitized exactly like what gets saved, so a block can never carry scripts or remote URLs
    const html = sanitizeHtml(input.html);
    const css = sanitizeStylesheet(input.css);
    const outcome = await this.deps.renderer.renderBlock({
      document: blockDocument(html, css),
      ...BLOCK_VIEWPORT,
    });
    if (!outcome.ok) throw renderError(outcome);
    return this.store(prototypeId, outcome.png);
  }

  /**
   * Cuts the CURRENT version (its HTML, never an older scene) into a scene: the screen without its
   * components as the background and one image layer per component. Nothing is saved as a version.
   */
  async fromHtml(prototypeId: string): Promise<SceneFromHtmlDto> {
    const { prototypes, files, renderer } = this.deps;
    const prototype = await prototypes.require(prototypeId);
    const content = await prototypes.currentContent(prototype);
    const marked = markSceneLayers(content.html);
    await files.assertWritable();
    const outcome = await renderer.decompose({
      document: renderDocument(marked.html, content.css),
      width: prototype.width,
      height: prototype.height,
      scale: 1,
      layerCount: marked.layers.length,
    });
    if (!outcome.ok) throw renderError(outcome);

    const background = await this.store(prototypeId, outcome.background);
    const info = new Map(marked.layers.map((l) => [l.n, l]));
    const layers: SceneLayer[] = [];
    for (const cut of outcome.layers) {
      const meta = info.get(cut.n);
      if (!meta || layers.length >= SCENE_LIMITS.maxLayers) continue;
      const asset = await this.store(prototypeId, cut.png);
      layers.push({
        id: randomBytes(6).toString('hex'),
        name: meta.name,
        type: 'image',
        x: cut.x,
        y: cut.y,
        width: cut.width,
        height: cut.height,
        visible: true,
        locked: false,
        image: { asset: asset.asset },
        source: { kind: meta.kind },
      });
    }
    const scene: PrototypeScene = { version: 1, background: { asset: background.asset }, layers };
    return { scene };
  }

  /**
   * The CURRENT version (its HTML) as a FREE LAYOUT: every component, loose control and group
   * copied into an absolutely positioned `<div data-tf-free>` with its computed styles inlined
   * (see `PrototypeRenderer.freeLayout`). Nothing is saved as a version: the editor loads the
   * result and saves it with the first edit. A screen that is already a free layout comes back
   * unchanged, and so does one with nothing to move.
   */
  async freeLayout(prototypeId: string): Promise<PrototypeFreeLayoutDto> {
    const { prototypes, renderer } = this.deps;
    const prototype = await prototypes.require(prototypeId);
    const content = await prototypes.currentContent(prototype);
    if (FREE_WRAPPER.test(content.html)) return { html: content.html, css: content.css };
    const marked = markSceneLayers(content.html);
    if (marked.layers.length === 0) return { html: content.html, css: content.css };
    const outcome = await renderer.freeLayout({
      document: renderDocument(marked.html, content.css),
      width: prototype.width,
      height: prototype.height,
    });
    if (!outcome.ok) throw renderError(outcome);
    // the page produced this markup: it gets the same cleaning as anything that is saved
    const { html, css } = prepareSnapshot({
      html: outcome.html,
      css: content.css,
      width: prototype.width,
      height: prototype.height,
    });
    return { html, css };
  }

  /** Stores the PNG under its hash (the same image twice is one object). */
  private async store(prototypeId: string, png: Uint8Array): Promise<SceneAssetDto> {
    const size = pngDimensions(png);
    if (!size || size.width < 1 || size.height < 1) throw badImage();
    if (size.width > MAX_ASSET_SIDE || size.height > MAX_ASSET_SIDE) {
      throw new DomainError(
        `A imagem é grande demais (máximo ${MAX_ASSET_SIDE}px de lado).`,
        'asset_too_large',
        413,
      );
    }
    if (png.byteLength > SCENE_LIMITS.maxAssetBytes) throw tooLarge();
    await this.deps.files.assertWritable();
    const asset = createHash('sha256').update(png).digest('hex');
    const key = assetKey(prototypeId, asset);
    if (!(await this.deps.files.has(key))) {
      await this.deps.files.put(key, png, 'image/png', { maxBytes: SCENE_LIMITS.maxAssetBytes });
    }
    return { asset, width: size.width, height: size.height };
  }
}

const badImage = () => new DomainError('Imagem inválida (PNG esperado).', 'bad_image', 400);

const tooLarge = () =>
  new DomainError(
    `A imagem tem mais de ${SCENE_LIMITS.maxAssetBytes / (1024 * 1024)} MB.`,
    'asset_too_large',
    413,
  );

function renderError(outcome: PrototypeFailure): DomainError {
  return outcome.unavailable
    ? new DomainError(
        `Não foi possível gerar a imagem: o Chromium não está disponível (${outcome.error})`,
        'renderer_unavailable',
        503,
      )
    : new DomainError(`Não foi possível gerar a imagem: ${outcome.error}`, 'render_failed', 502);
}
