import type { TemplateKind, TemplateLayout } from '@thinkflow/shared';
import type { ObjectStream } from '../../../shared/kernel/object-store';

export type DiagramRenderResult =
  { ok: true; svg: string } | { ok: false; error: string; unavailable?: boolean };

/** Renders (and thereby validates) one Mermaid diagram. */
export interface DiagramRenderer {
  status(): Promise<RendererStatus>;
  render(code: string, signal?: AbortSignal): Promise<DiagramRenderResult>;
}

export interface RendererStatus {
  available: boolean;
  /** pt-BR explanation when unavailable. */
  reason: string | null;
  executablePath: string | null;
}

export interface PdfOptions {
  headerTemplate: string;
  footerTemplate: string;
  pageSize: TemplateLayout['pageSize'];
}

export interface PdfRenderer {
  status(): Promise<RendererStatus>;
  pdf(html: string, options: PdfOptions, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface RenderMarkdownOptions {
  /** Sanitized SVG by `hashDiagram(code)`; blocks without one become an escaped code block. */
  svgByHash?: Record<string, string>;
  /** Text of an `h2` -> id, so the table of contents links work. */
  headingIds?: Record<string, string>;
}

export interface MarkdownToHtml {
  /** Markdown -> sanitized HTML fragment (raw HTML in the Markdown is never honoured). */
  render(markdown: string, options?: RenderMarkdownOptions): string;
  /** Fragment written by a model for a prototype screen -> fragment limited to the component kit. */
  sanitizePrototype(html: string): string;
}

export type ReportArtifactKind = 'html' | 'pdf' | 'md';

/** One stored document of a report: `version` is `artifactVersion(html)` (see artifact-keys). */
export interface ReportArtifactRef {
  reportId: string;
  version: string;
  artifact: ReportArtifactKind;
}

export interface ReportArtifactMeta {
  kind: TemplateKind;
  templateId: string | null;
}

/**
 * Generated documents of the reports (HTML, PDF and a Markdown copy) in the object storage.
 * Every method may throw `ObjectStoreUnavailableError` while the storage is down; a missing
 * object is `null`/`false`, never an error.
 */
export interface ReportArtifactStore {
  /** Full object key (with the configured prefix). */
  key(ref: ReportArtifactRef): string;
  put(
    ref: ReportArtifactRef,
    bytes: Uint8Array,
    meta: ReportArtifactMeta,
    signal?: AbortSignal,
  ): Promise<void>;
  read(ref: ReportArtifactRef): Promise<Uint8Array | null>;
  /** The caller must consume the body or call `abort()`. */
  stream(ref: ReportArtifactRef): Promise<ObjectStream | null>;
  /** Size in bytes, or `null` when the object does not exist. */
  head(ref: ReportArtifactRef, signal?: AbortSignal): Promise<{ size: number } | null>;
  exists(ref: ReportArtifactRef): Promise<boolean>;
  /** Removes every version of the report. */
  deleteReport(reportId: string): Promise<void>;
  /** Removes one version (all its artifacts). */
  deleteVersion(reportId: string, version: string): Promise<void>;
  /** Removes every version except `keep`. */
  deleteOtherVersions(reportId: string, keep: string): Promise<void>;
  /** For the janitor: every stored (reportId, version) with the newest `lastModified` of its objects. */
  inventory(): AsyncIterable<{ reportId: string; version: string; lastModified: number }>;
}

/** Read-only access to the pre-object-store PDF cache (`DATA_DIR/reports/<id>.pdf`), used by the backfill. */
export interface LegacyPdfSource {
  read(reportId: string): Promise<Uint8Array | null>;
  delete(reportId: string): Promise<void>;
}

export type LibraryIngestResult = { documentId: string; name: string } | { rejected: string };

/** Port: "Adicionar à Biblioteca" turns the report's Markdown into a library document. */
export interface LibraryIngestPort {
  addMarkdown(libraryId: string, name: string, text: string): Promise<LibraryIngestResult>;
}
