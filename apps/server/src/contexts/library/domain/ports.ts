import type { LibrarySettings, NotebookLmPlan } from '@thinkflow/shared';
import type {
  ChunkDraft,
  ChunkRow,
  DocumentKind,
  ExtractedSection,
  ExtractionMethod,
  Library,
  LibraryDocument,
  LibraryStats,
  DocumentStatus,
  RemoteStatus,
} from './library';
import type { RawHit } from './retrieval';

export interface LibraryRepository {
  list(): Promise<Library[]>;
  findById(id: string): Promise<Library | null>;
  findByName(name: string): Promise<Library | null>;
  save(library: Library): Promise<void>;
  delete(id: string): Promise<void>;
  documents(libraryId: string): Promise<LibraryDocument[]>;
  findDocument(id: string): Promise<LibraryDocument | null>;
  findByHash(libraryId: string, sha256: string): Promise<LibraryDocument | null>;
  saveDocument(doc: LibraryDocument): Promise<void>;
  updateDocument(id: string, patch: Partial<LibraryDocument>): Promise<void>;
  deleteDocument(id: string): Promise<void>;
  documentsWithStatus(status: DocumentStatus): Promise<LibraryDocument[]>;
  documentsWithRemoteStatus(status: RemoteStatus): Promise<LibraryDocument[]>;
  stats(libraryId: string): Promise<LibraryStats>;
}

export interface ChunkIndex {
  /** Replaces all chunks of a document atomically. */
  replace(documentId: string, libraryId: string, chunks: ChunkDraft[]): Promise<void>;
  /** `ftsQuery` comes from `buildFtsQuery`; a malformed query yields []. Ordered by score (best first). */
  search(libraryId: string, ftsQuery: string, limit: number): Promise<RawHit[]>;
  neighbors(documentId: string, ordinals: number[]): Promise<ChunkRow[]>;
  /** All chunks of a document in reading order. */
  documentChunks(documentId: string): Promise<ChunkRow[]>;
}

export interface DocumentFilePutOptions {
  contentType?: string;
  /** Hex digest already computed by the caller (stored as metadata). */
  sha256?: string;
}

/**
 * Original uploads, kept in the ObjectStore (`library/` namespace). Store errors are
 * `ObjectStoreUnavailableError` (503) and `ObjectTooLargeError` (413) from the shared kernel.
 */
export interface DocumentFileStore {
  /** Throws `ObjectStoreUnavailableError` while the storage is known to be down. */
  assertWritable(): Promise<void>;
  /** Returns the storage key (`<libraryId>/<docId>.<ext>`). */
  put(
    libraryId: string,
    docId: string,
    ext: string,
    bytes: Uint8Array,
    opts?: DocumentFilePutOptions,
  ): Promise<string>;
  read(storageKey: string): Promise<Uint8Array>;
  delete(storageKey: string): Promise<void>;
  deleteLibrary(libraryId: string): Promise<void>;
}

export interface TextExtractor {
  extract(
    input: { bytes: Uint8Array; kind: DocumentKind; name: string; mimeType?: string },
    opts: { signal?: AbortSignal },
  ): Promise<{
    sections: ExtractedSection[];
    method: ExtractionMethod;
    pageCount: number | null;
    warnings: string[];
  }>;
}

export interface OcrEngine {
  readonly method: 'ocr-local' | 'ocr-vision';
  recognize(image: Uint8Array, mime: string, signal?: AbortSignal): Promise<string>;
}

export interface LibraryUsageRecorder {
  record(e: {
    source: 'library-ocr' | 'library-notebooklm';
    providerId: string;
    model: string;
    success: boolean;
    inputTokens: number;
    outputTokens: number;
  }): void;
}

export interface LibrarySettingsSource {
  get(): LibrarySettings;
}

/* NotebookLM (experimental engine) */

export type NotebookLmErrorKind =
  | 'not_configured'
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'bad_response'
  | 'cli_missing'
  /** The notebook already holds as many sources as the account allows. */
  | 'source_limit';

export class NotebookLmError extends Error {
  constructor(
    public readonly kind: NotebookLmErrorKind,
    message: string,
    /** `source_limit` only: the limit the service reported, when it said one. */
    public readonly limit: number | null = null,
  ) {
    super(message);
    this.name = 'NotebookLmError';
  }
}

export interface NotebookLmGateway {
  /** Never throws: a failure is reported as `{ ok: false, message }`. */
  check(signal?: AbortSignal): Promise<{ ok: boolean; message: string; account?: string }>;
  /**
   * Re-exercises the stored Google session so Google rotates its short-lived cookies, and stores
   * the rotated credentials. Throws NotebookLmError when the session can no longer be renewed.
   */
  refreshCredentials(signal?: AbortSignal): Promise<void>;
  createNotebook(title: string, signal?: AbortSignal): Promise<{ id: string }>;
  deleteNotebook(id: string, signal?: AbortSignal): Promise<void>;
  addSource(
    notebookId: string,
    /** `fileName` is app-generated (`<docId>.<ext>`): the CLI infers the type from it. */
    file: { bytes: Uint8Array; fileName: string; title: string; mimeType: string },
    signal?: AbortSignal,
  ): Promise<{ sourceId: string }>;
  /** Throws NotebookLmError. */
  waitSourceReady(
    notebookId: string,
    sourceId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void>;
  deleteSource(notebookId: string, sourceId: string, signal?: AbortSignal): Promise<void>;
  ask(
    notebookId: string,
    question: string,
    opts: { sourceIds?: string[]; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{
    answer: string;
    references: { sourceId: string; citationNumber: number; citedText: string }[];
  }>;
}

/** Account limits read from the account itself (never guessed). */
export interface NotebookLmDetectedLimits {
  at: number;
  sourceLimit: number | null;
  notebookLimit: number | null;
  tier: number | null;
}

export type NotebookLmProbeResult =
  | {
      ok: true;
      limits: { sourceLimit: number | null; notebookLimit: number | null; tier: number | null };
    }
  /** `reason` is a pt-BR sentence safe to show in the settings screen. */
  | { ok: false; reason: string };

/** Reads the account limits (`notebook_limit`, `source_limit`, `tier`) with the CLI's own Python. */
export interface NotebookLmAccountProbe {
  /** Never throws. */
  detect(signal?: AbortSignal): Promise<NotebookLmProbeResult>;
}

export interface NotebookLmConfig {
  enabled: boolean;
  authJson: string | null;
  cliCommand: string;
  /** Plan chosen by the user; `auto` follows the detected limits. */
  plan: NotebookLmPlan;
  /** User-typed daily limit; null = the plan's chats per day. */
  dailyQueryLimit: number | null;
  detected: NotebookLmDetectedLimits | null;
  /** When the probe last ran (successful or not), to run it at most every 12 h. */
  detectionAttemptedAt: number | null;
  /** Why the last probe failed (pt-BR), or null. */
  detectionError: string | null;
  timeoutSec: number;
  fallbackToLocal: boolean;
  credentialsUpdatedAt: number | null;
  lastCheck: NotebookLmLastCheck | null;
}

export interface NotebookLmLastCheck {
  at: number;
  ok: boolean;
  message: string;
  account?: string | null;
}

export interface NotebookLmConfigStore {
  get(): NotebookLmConfig;
  set(patch: Partial<NotebookLmConfig>): void;
  /** Counts one query on `day` ('YYYY-MM-DD') and returns the new count. */
  countQuery(day: string): number;
  queriesOn(day: string): number;
}

/** What the in-app Google login produced. The plaintext file is already gone when this resolves. */
export type NotebookLmLoginOutcome =
  { ok: true; storageState: string } | { ok: false; cancelled: boolean; message: string };

export interface NotebookLmLoginHandle {
  result: Promise<NotebookLmLoginOutcome>;
  /** Kills the login (and the browser window). Idempotent. */
  cancel(): void;
}

/** Starts the interactive Google login (a browser window on the machine running the server). */
export interface NotebookLmLoginRunner {
  support(): { supported: boolean; message: string };
  start(opts: { cliCommand: string; timeoutSec: number }): NotebookLmLoginHandle;
}

/** The CLI's own login on the server machine, resolved server-side only (never from client input). */
export interface NotebookLmLocalProfile {
  /** The storage_state.json content, or null when the profile does not exist. */
  read(): Promise<string | null>;
  exists(): boolean;
}
