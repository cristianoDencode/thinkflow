/**
 * Library domain model: document libraries the chat can consult.
 * Pure types and guards; no I/O.
 */
import { LIBRARY_LIMITS, maxDocumentsFor } from '@thinkflow/shared';
import type {
  LibraryDocumentKind,
  LibraryDocumentStatus,
  LibraryEngine,
  LibraryExtractionMethod,
  LibraryRemoteStatus,
} from '@thinkflow/shared';
import { DomainError } from '../../../shared/kernel/errors';

export { LIBRARY_LIMITS, maxDocumentsFor };

export type LibraryEngineKind = LibraryEngine;
export type DocumentKind = LibraryDocumentKind;
export type DocumentStatus = LibraryDocumentStatus;
export type ExtractionMethod = LibraryExtractionMethod;
export type RemoteStatus = LibraryRemoteStatus;

export interface Library {
  id: string;
  name: string;
  description: string;
  engine: LibraryEngineKind;
  remoteNotebookId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LibraryDocument {
  id: string;
  libraryId: string;
  name: string;
  mimeType: string;
  kind: DocumentKind;
  sizeBytes: number;
  sha256: string;
  status: DocumentStatus;
  error: string | null;
  extraction: ExtractionMethod | null;
  pageCount: number | null;
  charCount: number;
  chunkCount: number;
  storageKey: string;
  remoteSourceId: string | null;
  remoteStatus: RemoteStatus | null;
  remoteError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LibraryStats {
  documentCount: number;
  readyCount: number;
  processingCount: number;
  errorCount: number;
  totalChars: number;
}

/** One piece of text ready to be indexed. */
export interface ChunkDraft {
  ordinal: number;
  text: string;
  tokenEstimate: number;
  pageFrom: number | null;
  pageTo: number | null;
  heading: string | null;
}

/** A stored chunk. */
export interface ChunkRow extends ChunkDraft {
  id: number;
  documentId: string;
  libraryId: string;
}

/** Text produced by an extractor: a PDF page, a DOCX/Markdown body, an OCR result... */
export interface ExtractedSection {
  text: string;
  page?: number;
  heading?: string;
}

/** Same unit as `estimateTokens` (≈ 4 chars per token). */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Strips path parts and control characters from a user-supplied file name. */
export function sanitizeDisplayName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const name = cleaned === '.' || cleaned === '..' ? '' : cleaned;
  if (!name) return 'documento';
  if (name.length <= 200) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return `${name.slice(0, 200 - ext.length)}${ext}`;
}

/** Raised by extractors with a pt-BR message that is safe to show to the user. */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export function maxBytesFor(kind: DocumentKind): number {
  return kind === 'image' ? LIBRARY_LIMITS.maxImageBytes : LIBRARY_LIMITS.maxFileBytes;
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Returns the pt-BR reason a new document cannot be added, or null when it can. */
export function checkCanAddDocument(input: {
  /** Documents already in the library plus those accepted earlier in the same batch. */
  existingCount: number;
  kind: DocumentKind;
  sizeBytes: number;
  /** `maxDocumentsFor(engine, account source limit)`. */
  maxDocuments: number;
  engine?: LibraryEngineKind;
}): string | null {
  if (input.sizeBytes <= 0) return 'Arquivo vazio';
  const max = maxBytesFor(input.kind);
  if (input.sizeBytes > max) return `Arquivo maior que ${mb(max)}`;
  if (input.existingCount >= input.maxDocuments)
    return input.engine === 'notebooklm'
      ? `A conta do NotebookLM permite no máximo ${input.maxDocuments} fontes por notebook`
      : `A biblioteca já tem o máximo de ${input.maxDocuments} documentos`;
  return null;
}

export function assertCanAddDocument(input: Parameters<typeof checkCanAddDocument>[0]): void {
  const reason = checkCanAddDocument(input);
  if (reason) throw new DomainError(reason, 'document_rejected', 400);
}

/** Returns the pt-BR reason extracted text cannot be indexed, or null when it fits the limits. */
export function checkTextWithinLimits(input: {
  documentChars: number;
  /** Characters already indexed in the library, excluding this document. */
  libraryChars: number;
}): string | null {
  if (input.documentChars > LIBRARY_LIMITS.maxDocumentChars)
    return 'Texto extraído excede o limite (1,5 mi caracteres)';
  if (input.libraryChars + input.documentChars > LIBRARY_LIMITS.maxLibraryChars)
    return `A biblioteca excede o limite de ${LIBRARY_LIMITS.maxLibraryChars / 1_000_000} mi caracteres de texto`;
  return null;
}
