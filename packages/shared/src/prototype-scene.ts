import { z } from 'zod';

/*
 * "Modo Livre" of the prototype editor: a free-form composition (Figma-like) instead of the HTML
 * flow layout. A scene is a background image (the captured screen with its e-Cidade components
 * hidden) plus layers drawn on top — each recognized component cut out as an image, palette blocks
 * rendered to images, text boxes and rectangles. Images live in the object store as assets
 * (`prototypes/<prototypeId>/assets/<sha256>.png`) and are referenced by their hash. A version
 * with a scene renders the scene (positioned `<img>`/`<div>`s); without one, its HTML.
 */

export const SCENE_LIMITS = {
  maxLayers: 500,
  /** One asset (PNG) in bytes. */
  maxAssetBytes: 8 * 1024 * 1024,
  maxTextLength: 5000,
  maxNameLength: 120,
} as const;

/** sha256 hex of the PNG bytes. */
export const sceneAssetIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Components (`data-ec` kinds) that stay in the background (their recognized children become
 * layers). Typed as strings so this file need not import prototypes.ts (no import cycle).
 */
export const SCENE_CONTAINER_KINDS: ReadonlySet<string> = new Set(['fieldset', 'tabs']);

const coord = z.number().finite().min(-100_000).max(100_000);
const size = z.number().finite().min(1).max(100_000);
const color = z.string().max(64);

export const sceneTextSchema = z.object({
  value: z.string().max(SCENE_LIMITS.maxTextLength),
  fontSize: z.number().min(4).max(400).default(11),
  fontFamily: z.string().max(120).default('Arial, Helvetica, sans-serif'),
  color: color.default('#000000'),
  bold: z.boolean().default(false),
  align: z.enum(['left', 'center', 'right']).default('left'),
});
export type SceneText = z.infer<typeof sceneTextSchema>;

export const sceneRectSchema = z.object({
  fill: color.default('#e0e0e0'),
  stroke: color.optional(),
  strokeWidth: z.number().min(0).max(100).optional(),
  radius: z.number().min(0).max(10_000).optional(),
});
export type SceneRect = z.infer<typeof sceneRectSchema>;

export const sceneLayerSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().max(SCENE_LIMITS.maxNameLength),
    type: z.enum(['image', 'text', 'rect']),
    x: coord,
    y: coord,
    width: size,
    height: size,
    visible: z.boolean().default(true),
    locked: z.boolean().default(false),
    image: z.object({ asset: sceneAssetIdSchema }).optional(),
    text: sceneTextSchema.optional(),
    rect: sceneRectSchema.optional(),
    /** Where the layer came from (a recognized e-Cidade component kind), for its name/icon. */
    source: z.object({ kind: z.string().max(40).optional() }).optional(),
  })
  .refine((l) => (l.type === 'image' ? !!l.image : l.type === 'text' ? !!l.text : !!l.rect), {
    message: 'A camada não tem os dados do seu tipo.',
  });
export type SceneLayer = z.infer<typeof sceneLayerSchema>;

export const prototypeSceneSchema = z.object({
  version: z.literal(1),
  /** The captured screen with its components hidden; null = plain page. */
  background: z.object({ asset: sceneAssetIdSchema }).nullable(),
  /** Bottom to top. */
  layers: z.array(sceneLayerSchema).max(SCENE_LIMITS.maxLayers),
});
export type PrototypeScene = z.infer<typeof prototypeSceneSchema>;

/** `POST /api/prototypes/:id/assets` (a pasted/uploaded image). */
export const sceneAssetUploadSchema = z.object({
  /** PNG as base64 (no `data:` prefix). */
  png: z.string().min(1),
});

/** `POST /api/prototypes/:id/assets/from-block`: a palette block rendered to an image. */
export const sceneBlockRenderSchema = z.object({
  html: z.string().min(1),
  css: z.string().default(''),
});

export interface SceneAssetDto {
  asset: string;
  width: number;
  height: number;
}

/** `POST /api/prototypes/:id/scene/from-html`: the current version decomposed into a scene. */
export interface SceneFromHtmlDto {
  scene: PrototypeScene;
}

/** URL of an asset of a prototype (served by the API). */
export const sceneAssetUrl = (prototypeId: string, asset: string) =>
  `/api/prototypes/${encodeURIComponent(prototypeId)}/assets/${asset}`;
