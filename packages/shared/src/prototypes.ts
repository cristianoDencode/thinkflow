import { z } from 'zod';
import { prototypeSceneSchema, type PrototypeScene } from './prototype-scene';

/*
 * Screen prototypes ("Protótipos"): a screen of a legacy web system captured as standalone
 * HTML/CSS (from the recorded browser or sent by an external mapper, see prototype-import.ts),
 * edited as components in a visual editor and rendered to PNG for the test-case document. This
 * file is the contract shared by the server and the web app. The system-specific part (look,
 * palette, starting window, assistant prompts) is a "system profile" (system-profiles.ts);
 * e-Cidade is the first built-in one, which is why the identifiers keep the `ecidade`/`ec` names.
 */

export const PROTOTYPE_LIMITS = {
  maxPrototypes: 2000,
  /** HTML + CSS of one version, data-URI images included. */
  maxSnapshotBytes: 15 * 1024 * 1024,
  maxVersionsPerPrototype: 100,
  maxBlocks: 500,
  maxBlockBytes: 2 * 1024 * 1024,
  minSize: 200,
  maxWidth: 3840,
  maxHeight: 4320,
} as const;

/*
 * Component markers. The capture annotates recognized e-Cidade elements (keeping their original
 * markup and look) with `data-ec="<kind>"` on the component root and `data-ec-part="<part>"` on
 * its inner pieces; the editor turns every `data-ec` element into an editable component of that
 * kind (same traits as the built-in palette blocks, which carry the same attributes) and offers
 * the recognized components of a screen in a palette category "Desta tela". Attributes only —
 * never classes — so the captured CSS keeps applying unchanged.
 */
export const ECIDADE_COMPONENT_KINDS = [
  'window-title', // blue title bar "Consultas > Consulta Empenho"
  'status-bar', // bottom "Instituição: … Departamento: …"
  'fieldset', // fieldset + legend
  'field', // label + text input
  'lookup', // red underlined label link + code input (+ read-only description input)
  'date', // label + date input + "D" calendar button
  'date-range', // label + date "D" a date "D"
  'select', // label + select
  'textarea', // label + textarea
  'checkbox',
  'radio-group',
  'button',
  'button-bar', // row of buttons (Pesquisa / Limpar campos / Incluir …)
  'grid', // data table with header
  'tabs',
  'message',
] as const;
export type EcidadeComponentKind = (typeof ECIDADE_COMPONENT_KINDS)[number];

export const ECIDADE_COMPONENT_PARTS = [
  'label',
  'input',
  'desc', // read-only description input of a lookup
  'button',
  'separator', // the "a" between dates
  'legend',
  'header',
  'row',
  'cell',
  'tab',
  'panel',
  'title',
  'text',
] as const;
export type EcidadeComponentPart = (typeof ECIDADE_COMPONENT_PARTS)[number];

export const EC_KIND_ATTR = 'data-ec';
export const EC_PART_ATTR = 'data-ec-part';

/** Where the captured screen came from. */
export const prototypeSourceSchema = z.object({
  /** Page/frame URL without query string. */
  url: z.string().max(2000).nullable().default(null),
  /** Source file of the routine, e.g. `emp1_empconsulta001.php`. */
  file: z.string().max(300).nullable().default(null),
  /** e.g. "DB:FINANCEIRO > Empenho > Consultas > Consulta Empenho". */
  menuPath: z.string().max(1000).nullable().default(null),
  /** Page or window title at capture time. */
  title: z.string().max(300).nullable().default(null),
});
export type PrototypeSource = z.infer<typeof prototypeSourceSchema>;

export const prototypeSnapshotSchema = z.object({
  html: z.string(),
  css: z.string().default(''),
  width: z.number().int().min(PROTOTYPE_LIMITS.minSize).max(PROTOTYPE_LIMITS.maxWidth),
  height: z.number().int().min(PROTOTYPE_LIMITS.minSize).max(PROTOTYPE_LIMITS.maxHeight),
  /** "Modo Livre" composition; when present the version renders the scene, not the HTML. */
  scene: prototypeSceneSchema.optional(),
});
export type PrototypeSnapshot = z.infer<typeof prototypeSnapshotSchema>;

export interface PrototypeVersionDto {
  id: string;
  createdAt: number;
  /** "Captura", "Edição", "IA: …", "Restaurado de …". */
  note: string;
}

/** A prototype is a screen to edit; a template ("modelo") is a starting point for new prototypes. */
export const PROTOTYPE_KINDS = ['prototype', 'template'] as const;
export type PrototypeKind = (typeof PROTOTYPE_KINDS)[number];

export const BUILTIN_TEMPLATE_PREFIX = 'builtin:';
/** Id of the built-in "Tela de sistema — perfil e-Cidade" template (`GET /api/prototypes/templates`). */
export const ECIDADE_WINDOW_TEMPLATE_ID = `${BUILTIN_TEMPLATE_PREFIX}ecidade-window`;

export interface PrototypeDto {
  id: string;
  name: string;
  kind: PrototypeKind;
  source: PrototypeSource;
  /** Test session it belongs to (optional link). */
  sessionId: string | null;
  sessionName: string | null;
  /** Step of that session where it was captured. */
  stepId: string | null;
  width: number;
  height: number;
  /** Field values / grid cells were cleared at capture time (LGPD default). */
  scrubbed: boolean;
  versionCount: number;
  /** Authenticated URL of the last rendered PNG, null until rendered. */
  thumbnailUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A step of a test session the rendered PNG was sent to (newest last; one entry per step). */
export interface PrototypeSentTo {
  sessionId: string;
  stepId: string;
  /** Epoch ms of the last send. */
  at: number;
}

/** Result of "Protótipo" in the recorded browser: the new prototype plus what the capture found. */
export interface PrototypeCaptureResultDto extends PrototypeDto {
  /** Recognized e-Cidade components by `data-ec` kind (see ECIDADE_COMPONENT_KINDS). */
  components: Record<string, number>;
  /** Things the capture could not do (pt-BR), e.g. frames of another origin left as empty boxes. */
  warnings: string[];
}

export interface PrototypeDetailDto extends PrototypeDto {
  /** Current version. */
  versionId: string;
  /** Recognized e-Cidade components of the current version by `data-ec` kind. */
  components?: Record<string, number>;
  html: string;
  css: string;
  /** "Modo Livre" composition of the current version (absent: the version is plain HTML). */
  scene?: PrototypeScene;
  versions: PrototypeVersionDto[];
  /** Where the image was sent in the test-case document (steps may have been deleted since). */
  sentTo: PrototypeSentTo[];
}

/**
 * POST /api/prototypes — blank prototype, pasted HTML or a copy of a template (captures are
 * created by the recorder). `fromTemplateId` is a user template's id or a built-in id
 * (`builtin:…`); `width`/`height` then override the template's size.
 */
export const prototypeCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    snapshot: prototypeSnapshotSchema.optional(),
    source: prototypeSourceSchema.optional(),
    sessionId: z.string().max(64).nullable().optional(),
    fromTemplateId: z.string().min(1).max(100).optional(),
    width: z.number().int().min(PROTOTYPE_LIMITS.minSize).max(PROTOTYPE_LIMITS.maxWidth).optional(),
    height: z
      .number()
      .int()
      .min(PROTOTYPE_LIMITS.minSize)
      .max(PROTOTYPE_LIMITS.maxHeight)
      .optional(),
  })
  .refine((v) => !(v.fromTemplateId && v.snapshot), {
    message: 'Informe um modelo ou um conteúdo, não os dois.',
    path: ['fromTemplateId'],
  });
export type PrototypeCreateInput = z.infer<typeof prototypeCreateSchema>;

/** POST /api/prototypes/:id/save-as-template — copies the current version as a new template. */
export const prototypeSaveAsTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export type PrototypeSaveAsTemplateInput = z.infer<typeof prototypeSaveAsTemplateSchema>;

/** One entry of `GET /api/prototypes/templates`: a built-in or a user template. */
export interface PrototypeTemplateDto {
  /** `builtin:…` for the built-ins, otherwise the id of the template prototype. */
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  width: number;
  height: number;
  /** Other sizes offered when starting from it (built-ins), e.g. 1366×768 and 1920×1080. */
  sizes: { width: number; height: number }[];
  /** Authenticated URL of the preview PNG; null until rendered (user templates). */
  thumbnailUrl: string | null;
  updatedAt: number;
}

/** PUT /api/prototypes/:id — rename/link; a snapshot creates a new version. */
export const prototypeUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sessionId: z.string().max(64).nullable().optional(),
  snapshot: prototypeSnapshotSchema.optional(),
  note: z.string().trim().max(200).optional(),
  /**
   * Saved by the editor's auto-save: when the current version is itself a recent auto-save
   * (`AUTOSAVE_NOTE`, younger than `AUTOSAVE_MERGE_MS`) it is replaced instead of adding one.
   */
  autosave: z.boolean().optional(),
});
export type PrototypeUpdateInput = z.infer<typeof prototypeUpdateSchema>;

export const AUTOSAVE_NOTE = 'Auto-save';
/** Auto-saves closer than this to the current auto-save version update it in place. */
export const AUTOSAVE_MERGE_MS = 10 * 60 * 1000;

/**
 * "Modo Livre": `POST /api/prototypes/:id/free-layout` turns the current version into a FREE
 * LAYOUT — still HTML: every component/loose control/group copied, with its computed styles
 * inlined, into an absolutely positioned wrapper `<div data-tf-free="n">` at the end of the body;
 * the originals stay in place hidden (`data-tf-free-src`) so the frame around keeps its layout.
 * Nothing is saved: the editor loads it and saves on the first edit.
 */
export interface PrototypeFreeLayoutDto {
  html: string;
  css: string;
}
export const FREE_WRAPPER_ATTR = 'data-tf-free';
export const FREE_SOURCE_ATTR = 'data-tf-free-src';

/** Reusable component for the editor palette (built-in e-Cidade blocks are client-side). */
export interface PrototypeBlockDto {
  id: string;
  name: string;
  category: string;
  html: string;
  css: string;
  /** Where a favorite came from ("Favorito de <prototype>"); null for other blocks. */
  source: string | null;
  createdAt: number;
}

/** Category of the built-in e-Cidade palette: blocks saved here are the "favorites". */
export const ECIDADE_BLOCK_CATEGORY = 'e-Cidade';

export const prototypeBlockInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(40).default('Meus blocos'),
  html: z.string().min(1),
  css: z.string().default(''),
  source: z.string().trim().min(1).max(200).nullable().optional(),
});
export type PrototypeBlockInput = z.infer<typeof prototypeBlockInputSchema>;

/** PUT /api/prototypes/blocks/:blockId — rename and/or move a block to another category. */
export const prototypeBlockUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().min(1).max(40).optional(),
  })
  .refine((v) => v.name !== undefined || v.category !== undefined, {
    message: 'Informe o nome ou a categoria.',
  });
export type PrototypeBlockUpdateInput = z.infer<typeof prototypeBlockUpdateSchema>;

export const PROTOTYPE_RENDER_SCALES = [1, 2] as const;

/** POST /api/prototypes/:id/render?scale=1|2&force=true — both optional. */
export const prototypeRenderQuerySchema = z.object({
  /** Device scale factor: 2 gives a sharper image for the document (twice the pixels). */
  scale: z.coerce
    .number()
    .int()
    .refine((n) => n === 1 || n === 2, 'Escala deve ser 1 ou 2')
    .default(1),
  /** Render again even if the current version was already rendered at this scale. */
  force: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
});
export type PrototypeRenderQuery = z.infer<typeof prototypeRenderQuerySchema>;

export interface PrototypeRenderDto {
  /** Authenticated URL of the PNG. */
  thumbnailUrl: string;
  /** Pixel size of the PNG (the prototype size times `scale`). */
  width: number;
  height: number;
  scale: number;
  /** Version the PNG shows. */
  renderedVersionId: string;
  /** The stored PNG was reused (the version did not change). */
  cached: boolean;
  /** Requests the render refused (external URLs: it runs with no network); null when cached. */
  blockedRequests: number | null;
}

/** POST /api/prototypes/:id/send-to-session */
export const prototypeSendSchema = z
  .object({
    /** Default: the session the prototype is linked to. */
    sessionId: z.string().max(64).optional(),
    target: z.enum(['newStep', 'replaceStepImage']),
    /** `replaceStepImage`: the step whose image is replaced (its annotations are dropped). */
    stepId: z.string().max(64).optional(),
    /** `newStep`: insert after this step (default: at the end). */
    afterStepId: z.string().max(64).optional(),
    /** `newStep`: step title (default "Protótipo: <name>"). */
    title: z.string().trim().max(300).optional(),
    /** Show the image in the CT document (default true; replacing keeps the current choice). */
    include: z.boolean().optional(),
    scale: z
      .number()
      .int()
      .refine((n) => n === 1 || n === 2)
      .optional(),
  })
  .refine((v) => v.target !== 'replaceStepImage' || !!v.stepId, {
    message: 'Informe o passo cuja imagem será substituída.',
    path: ['stepId'],
  });
export type PrototypeSendInput = z.infer<typeof prototypeSendSchema>;

export interface PrototypeSendResultDto {
  sessionId: string;
  /** The new `capture` step, or the step whose image was replaced. */
  stepId: string;
  target: PrototypeSendInput['target'];
  render: PrototypeRenderDto;
  sentTo: PrototypeSentTo[];
}

/**
 * HTTP contract (all behind the session guard):
 * - GET    /api/prototypes?sessionId=&kind=      → PrototypeDto[] (newest first; `kind` =
 *     prototype (default) | template | all)
 * - POST   /api/prototypes/import               → PrototypeCaptureResultDto (201; a mapper's screen,
 *     `prototypeImportSchema`, treated like an in-app capture; 400 bad/unsupported formatVersion,
 *     413 over PROTOTYPE_LIMITS.maxSnapshotBytes)
 * - POST   /api/prototypes                       → PrototypeDetailDto (`fromTemplateId` copies a
 *     template's current version: a user template or a `builtin:` one)
 * - GET    /api/prototypes/templates             → PrototypeTemplateDto[] (built-ins, then the
 *     user's templates)
 * - GET    /api/prototypes/templates/:templateId/thumbnail → PNG preview of a built-in template
 * - POST   /api/prototypes/:id/save-as-template  → PrototypeDetailDto (a new template, a copy)
 * - GET    /api/prototypes/:id                   → PrototypeDetailDto (current version)
 * - PUT    /api/prototypes/:id                   → PrototypeDetailDto
 * - DELETE /api/prototypes/:id                   → 204
 * - GET    /api/prototypes/:id/versions/:vid     → { html, css, width, height, scene? }
 * - GET    /api/prototypes/:id/assets/:asset     → image/png (an asset of the "Modo Livre" scene)
 * - POST   /api/prototypes/:id/assets            → SceneAssetDto ({ png: base64 })
 * - POST   /api/prototypes/:id/assets/from-block → SceneAssetDto ({ html, css } rendered to a PNG)
 * - POST   /api/prototypes/:id/scene/from-html   → SceneFromHtmlDto (decomposes the current version)
 * - POST   /api/prototypes/:id/versions/:vid/restore → PrototypeDetailDto
 * - POST   /api/prototypes/:id/render?scale=&force= → PrototypeRenderDto (PNG of the current
 *     version at exactly width×height ×scale, JS off, no network; 503 without Chromium)
 * - POST   /api/prototypes/:id/send-to-session   → PrototypeSendResultDto (renders if needed, then
 *     adds a `capture` step with the PNG or replaces a step's image; 409 while the session
 *     records/replays or when there is no session)
 * - GET    /api/prototypes/blocks                → PrototypeBlockDto[]
 * - POST   /api/prototypes/blocks                → PrototypeBlockDto
 * - PUT    /api/prototypes/blocks/:blockId       → PrototypeBlockDto (rename / category)
 * - DELETE /api/prototypes/blocks/:blockId       → 204
 * - POST   /api/tests/sessions/:id/record/prototype → PrototypeCaptureResultDto ("Só prints" mode
 *     only: 409 `prototype_capture_mode_only` while recording steps)
 */
