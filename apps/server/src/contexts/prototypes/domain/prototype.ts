import {
  PROTOTYPE_LIMITS,
  type PrototypeBlockDto,
  type PrototypeKind,
  type PrototypeScene,
  type PrototypeSentTo,
  type PrototypeSnapshot,
  type PrototypeSource,
} from '@thinkflow/shared';
import { DomainError } from '../../../shared/kernel/errors';
import { annotateComponents, countComponents, type ComponentCounts } from './components';
import { sanitizeHtml, sanitizeStylesheet, sanitizeTree } from './html-sanitizer';
import { serializeNodes } from './html-tree';
import { scrubHtml, scrubTree } from './scrub';

/** A prototype as stored (the HTML/CSS of its versions live in the object store). */
export interface Prototype {
  id: string;
  name: string;
  kind: PrototypeKind;
  sessionId: string | null;
  sessionName: string | null;
  stepId: string | null;
  source: PrototypeSource;
  width: number;
  height: number;
  scrubbed: boolean;
  currentVersionId: string;
  versionCount: number;
  thumbnailKey: string | null;
  /** Version the stored PNG shows (null until rendered) and the device scale it used. */
  renderedVersionId: string | null;
  renderedAt: number | null;
  renderedScale: number;
  sentTo: PrototypeSentTo[];
  createdAt: number;
  updatedAt: number;
}

export interface PrototypeVersion {
  id: string;
  prototypeId: string;
  /** 1, 2, 3… (never reused). */
  seq: number;
  note: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: number;
}

export type PrototypeBlock = PrototypeBlockDto;

/** Blank canvas of a prototype created without a snapshot. */
export const BLANK_SNAPSHOT: PrototypeSnapshot = {
  html: '<body></body>',
  css: '',
  width: 1280,
  height: 720,
};

export const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)));

/** Sizes are kept inside the limits (a tiny frame becomes the minimum canvas, never an error). */
export function clampSize(width: number, height: number): { width: number; height: number } {
  return {
    width: clamp(width, PROTOTYPE_LIMITS.minSize, PROTOTYPE_LIMITS.maxWidth),
    height: clamp(height, PROTOTYPE_LIMITS.minSize, PROTOTYPE_LIMITS.maxHeight),
  };
}

export const snapshotBytes = (html: string, css: string): number =>
  Buffer.byteLength(html, 'utf8') + Buffer.byteLength(css, 'utf8');

export class PrototypeTooLargeError extends DomainError {
  constructor(limitBytes: number) {
    super(
      `O protótipo excede o tamanho máximo de ${Math.round(limitBytes / (1024 * 1024))} MB (HTML + CSS).`,
      'prototype_too_large',
      413,
    );
    this.name = 'PrototypeTooLargeError';
  }
}

/** Cleans a snapshot for storage: sanitized HTML/CSS (optionally scrubbed) within the size limit. */
export function prepareSnapshot(
  snapshot: PrototypeSnapshot,
  options: { scrub?: boolean } = {},
): PrototypeSnapshot {
  // refuse the raw payload before spending time parsing it
  if (snapshotBytes(snapshot.html, snapshot.css) > PROTOTYPE_LIMITS.maxSnapshotBytes) {
    throw new PrototypeTooLargeError(PROTOTYPE_LIMITS.maxSnapshotBytes);
  }
  let html = sanitizeHtml(snapshot.html);
  if (options.scrub) html = scrubHtml(html);
  const css = sanitizeStylesheet(snapshot.css);
  if (snapshotBytes(html, css) > PROTOTYPE_LIMITS.maxSnapshotBytes) {
    throw new PrototypeTooLargeError(PROTOTYPE_LIMITS.maxSnapshotBytes);
  }
  return {
    html,
    css,
    ...clampSize(snapshot.width, snapshot.height),
    ...(snapshot.scene ? { scene: checkedScene(snapshot.scene) } : {}),
  };
}

/** A scene is a few KB of JSON (its images are assets); this only guards against a runaway one. */
function checkedScene(scene: PrototypeScene): PrototypeScene {
  if (Buffer.byteLength(JSON.stringify(scene), 'utf8') > PROTOTYPE_LIMITS.maxSnapshotBytes) {
    throw new PrototypeTooLargeError(PROTOTYPE_LIMITS.maxSnapshotBytes);
  }
  return scene;
}

/**
 * A captured screen ready for storage: sanitized, scrubbed (values, grid cells and personal data)
 * unless `keepData`, and with the recognized e-Cidade components annotated (`data-ec`).
 */
export function prepareCapture(
  snapshot: PrototypeSnapshot,
  options: { scrub: boolean },
): { snapshot: PrototypeSnapshot; components: ComponentCounts } {
  if (snapshotBytes(snapshot.html, snapshot.css) > PROTOTYPE_LIMITS.maxSnapshotBytes) {
    throw new PrototypeTooLargeError(PROTOTYPE_LIMITS.maxSnapshotBytes);
  }
  const tree = sanitizeTree(snapshot.html);
  if (options.scrub) scrubTree(tree);
  const components = annotateComponents(tree);
  const html = serializeNodes(tree);
  const css = sanitizeStylesheet(snapshot.css);
  if (snapshotBytes(html, css) > PROTOTYPE_LIMITS.maxSnapshotBytes) {
    throw new PrototypeTooLargeError(PROTOTYPE_LIMITS.maxSnapshotBytes);
  }
  return { snapshot: { html, css, ...clampSize(snapshot.width, snapshot.height) }, components };
}

export { countComponents };

/** URL without query/hash; `null` when it is not an http(s) URL. */
export function urlWithoutQuery(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 2000);
  } catch {
    return null;
  }
}

/** The routine file of a URL: its last path segment when it ends in `.php`. */
export function routineFile(raw: string | null): string | null {
  if (!raw) return null;
  let pathname: string;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    pathname = raw.split(/[?#]/, 1)[0] ?? '';
  }
  const last = pathname.split('/').filter(Boolean).at(-1);
  if (!last) return null;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // keep the raw segment
  }
  return /\.php$/i.test(decoded) && decoded.length <= 300 ? decoded : null;
}

const clip = (value: string | null | undefined, max: number): string | null => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
};

/** `PrototypeSource` of a captured page. */
export function sourceOf(input: {
  url: string | null;
  title: string | null;
  menuPath: string | null;
}): PrototypeSource {
  const url = input.url ? urlWithoutQuery(input.url) : null;
  return {
    url,
    file: routineFile(input.url),
    menuPath: clip(input.menuPath, 1000),
    title: clip(input.title, 300),
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "dd/mm/aaaa hh:mm" in the server's time zone. */
export function formatCaptureDate(at: number): string {
  const d = new Date(at);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "<file or title> — <date>". */
export function captureName(source: PrototypeSource, at: number): string {
  const base = source.file ?? source.title ?? 'Tela capturada';
  return `${base.slice(0, 90)} — ${formatCaptureDate(at)}`.slice(0, 120);
}

/** Object-store keys, relative to the `prototypes/` namespace. */
export const versionKey = (prototypeId: string, versionId: string): string =>
  `${prototypeId}/${versionId}.json`;
export const thumbnailKey = (prototypeId: string): string => `${prototypeId}/thumbnail.png`;
/** A PNG of the "Modo Livre" scene of a prototype, named by the sha256 of its bytes. */
export const assetKey = (prototypeId: string, assetId: string): string =>
  `${prototypeId}/assets/${assetId}.png`;
export const prototypePrefix = (prototypeId: string): string => `${prototypeId}/`;

/** How many sends are remembered per prototype. */
export const MAX_SENT_TO = 50;

/** Records a send: one entry per step (a repeated send refreshes `at`), newest last, capped. */
export function withSentTo(list: PrototypeSentTo[], entry: PrototypeSentTo): PrototypeSentTo[] {
  const rest = list.filter((e) => !(e.sessionId === entry.sessionId && e.stepId === entry.stepId));
  return [...rest, entry].slice(-MAX_SENT_TO);
}

/** The page Chromium renders: the stored `<body …>` element plus its stylesheet. */
export const renderDocument = (html: string, css: string): string =>
  `<!doctype html><meta charset=utf-8><style>${css}</style>${html}`;
