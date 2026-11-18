import type { PrototypeKind, PrototypeSentTo } from '@thinkflow/shared';
import type { Prototype, PrototypeBlock, PrototypeVersion } from './prototype';

export interface PrototypeRepository {
  count(): Promise<number>;
  /** Newest first; `sessionId` narrows to one session, `kind` to prototypes or templates. */
  list(filter?: { sessionId?: string; kind?: PrototypeKind }): Promise<Prototype[]>;
  find(id: string): Promise<Prototype | null>;
  /** Creates the prototype together with its first version. */
  insert(prototype: Prototype, firstVersion: PrototypeVersion): Promise<void>;
  /**
   * Adds a version, makes it the current one and applies `patch` to the prototype. When the
   * prototype ends up with more than `maxVersions`, the oldest versions other than the current one
   * are dropped; their ids are returned (the caller removes their stored files).
   */
  addVersion(
    prototypeId: string,
    version: PrototypeVersion,
    patch: Partial<Pick<Prototype, 'name' | 'sessionId' | 'stepId'>>,
    maxVersions: number,
  ): Promise<{ dropped: string[] }>;
  /**
   * Rewrites an existing version in place (editor auto-save): its size, bytes and timestamp, and
   * the prototype's size, `updatedAt` and `patch`. The stored PNG no longer shows this version
   * (`renderedVersionId` is cleared), so the next render draws the new content.
   */
  replaceVersion(
    prototypeId: string,
    versionId: string,
    version: Pick<PrototypeVersion, 'width' | 'height' | 'bytes' | 'createdAt'>,
    patch: Partial<Pick<Prototype, 'name' | 'sessionId' | 'stepId'>>,
  ): Promise<void>;
  /** Fields that do not create a version (rename, link). */
  update(
    id: string,
    patch: Partial<Pick<Prototype, 'name' | 'sessionId' | 'stepId' | 'thumbnailKey'>>,
    at: number,
  ): Promise<void>;
  /** The rendered PNG changed; does not touch `updatedAt` (it is not an edit). */
  setRender(
    id: string,
    render: {
      thumbnailKey: string;
      renderedVersionId: string;
      renderedAt: number;
      renderedScale: number;
    },
  ): Promise<void>;
  setSentTo(id: string, sentTo: PrototypeSentTo[]): Promise<void>;
  /** Newest first. */
  versions(prototypeId: string): Promise<PrototypeVersion[]>;
  findVersion(prototypeId: string, versionId: string): Promise<PrototypeVersion | null>;
  /** Cascades to the versions. */
  delete(id: string): Promise<void>;

  blocks(): Promise<PrototypeBlock[]>;
  countBlocks(): Promise<number>;
  findBlock(id: string): Promise<PrototypeBlock | null>;
  insertBlock(block: PrototypeBlock): Promise<void>;
  updateBlock(id: string, patch: Partial<Pick<PrototypeBlock, 'name' | 'category'>>): Promise<void>;
  deleteBlock(id: string): Promise<void>;
}

/** The HTML/CSS of each version (`prototypes/` namespace of the ObjectStore). */
export interface PrototypeFileStore {
  put(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    options?: { maxBytes?: number },
  ): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** Whether the key exists (without reading it). */
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Throws `ObjectStoreUnavailableError` while the storage is known to be down. */
  assertWritable(): Promise<void>;
}

/** Test sessions, as seen from here (only to validate a link). */
export interface SessionLookup {
  exists(sessionId: string): Promise<boolean>;
}

export type PrototypeRenderOutcome =
  | {
      ok: true;
      png: Uint8Array;
      /** Pixel size of the PNG. */
      width: number;
      height: number;
      /** Requests refused because the render has no network (external URLs). */
      blockedRequests: number;
    }
  | { ok: false; error: string; unavailable: boolean };

export type PrototypeFailure = { ok: false; error: string; unavailable: boolean };

/** One component cut out of the page, in CSS pixels (whole numbers) relative to the page. */
export interface DecomposedLayer {
  /** The `data-tf-layer` value. */
  n: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** PNG of that rectangle (`width`×`height` times the scale). */
  png: Uint8Array;
}

export type PrototypeDecomposeOutcome =
  | {
      ok: true;
      /** The page with every `[data-tf-layer]` element hidden (`visibility:hidden`). */
      background: Uint8Array;
      /** Only the visible ones, by `n`. */
      layers: DecomposedLayer[];
    }
  | PrototypeFailure;

export type PrototypeBlockOutcome =
  { ok: true; png: Uint8Array; width: number; height: number } | PrototypeFailure;

export type PrototypeFreeLayoutOutcome = { ok: true; html: string } | PrototypeFailure;

/** Renders a prototype to PNG (Chromium: JavaScript off, no network). */
export interface PrototypeRenderer {
  /**
   * Turns a page marked with `data-tf-layer` into a FREE LAYOUT: every layer root is copied (with
   * its computed styles inlined) into an absolutely positioned `<div data-tf-free="n">` at the end
   * of the body, and the original stays in place, hidden (`data-tf-free-src="n"`). Returns the
   * resulting `<body>` markup (layer marks removed). Unlike the other methods this runs OUR script
   * in the page (never the page's own: the markup is already sanitized and has no network).
   */
  freeLayout(input: {
    document: string;
    width: number;
    height: number;
  }): Promise<PrototypeFreeLayoutOutcome>;

  /**
   * Cuts a page marked with `data-tf-layer="1..layerCount"` into a background (those elements
   * hidden) and one image per element; the layout is the same in both. Elements that also carry
   * `data-tf-container="<depth>"` are containers: their image is the element WITHOUT the layers
   * inside it (those are hidden while it is captured).
   */
  decompose(input: {
    document: string;
    width: number;
    height: number;
    scale: 1 | 2;
    layerCount: number;
  }): Promise<PrototypeDecomposeOutcome>;
  /** Screenshot of the `[data-tf-block]` element of `document` (a palette block on a window background). */
  renderBlock(input: {
    document: string;
    width: number;
    height: number;
  }): Promise<PrototypeBlockOutcome>;

  render(input: {
    /** Full document, see `renderDocument`. */
    document: string;
    width: number;
    height: number;
    scale: 1 | 2;
  }): Promise<PrototypeRenderOutcome>;
}

/** Test sessions as the "send to document" use case needs them (implemented by `testing`). */
export interface DocumentStepSink {
  /**
   * Fails early (before rendering) when the session is missing (404), busy recording/replaying
   * (409) or lacks the given steps (404).
   */
  check(input: { sessionId: string; stepId?: string; afterStepId?: string }): Promise<void>;
  /**
   * Adds a `capture` step holding `png` after `afterStepId` (default: at the end). Throws a
   * DomainError: 404 session/step, 409 session busy, 400 step limit.
   */
  addCaptureStep(input: {
    sessionId: string;
    afterStepId?: string;
    title: string;
    include: boolean;
    png: Uint8Array;
    width: number;
    height: number;
  }): Promise<{ stepId: string }>;
  /** Replaces the image of a step (its annotations are dropped). */
  replaceStepImage(input: {
    sessionId: string;
    stepId: string;
    include?: boolean;
    png: Uint8Array;
    width: number;
    height: number;
  }): Promise<void>;
}
