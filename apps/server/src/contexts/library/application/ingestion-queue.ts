import { chunkSections, normalizeText } from '../domain/chunker';
import {
  checkTextWithinLimits,
  ExtractionError,
  type ExtractedSection,
  type LibraryDocument,
} from '../domain/library';
import type { LibraryEngine } from '../domain/engine';
import type { LibraryEngineKind } from '../domain/library';
import type {
  ChunkIndex,
  DocumentFileStore,
  LibraryRepository,
  TextExtractor,
} from '../domain/ports';
import type { Clock } from '../../../shared/kernel/clock';
import { Lane } from '../../../shared/kernel/lane';
import { ObjectStoreUnavailableError } from '../../../shared/kernel/object-store';

const EXTRACTION_TIMEOUT_MS = 180_000;
const EMPTY_TEXT_MESSAGE =
  'Nenhum texto encontrado (o PDF pode ser digitalizado — ative o OCR em Biblioteca → Configurações)';
const EMPTY_IMAGE_MESSAGE = 'Nenhum texto reconhecido na imagem';

export interface IngestionQueueDeps {
  repo: LibraryRepository;
  index: ChunkIndex;
  files: DocumentFileStore;
  extractor: TextExtractor;
  clock: Clock;
  /** Remote engines (NotebookLM): their `onDocumentIndexed` runs in the separate remote lane. */
  engines?: Partial<Record<LibraryEngineKind, LibraryEngine>>;
  /** Receives unexpected failures (the user only sees a generic message). */
  onError?: (err: unknown, doc: LibraryDocument) => void;
}

/**
 * In-process queues that turn uploaded files into indexed chunks, one document at a time, so a big
 * PDF never competes with another for CPU. A second lane (concurrency 1) syncs documents with
 * remote engines (NotebookLM) so slow remote calls never block local indexing.
 */
export class IngestionQueue {
  private stopped = false;
  private readonly stopController = new AbortController();
  private readonly local = new Lane<string>((id) => this.process(id));
  private readonly remote = new Lane<string>((id) => this.processRemote(id));

  constructor(private readonly deps: IngestionQueueDeps) {}

  enqueue(docId: string): void {
    this.local.enqueue(docId);
  }

  enqueueRemote(docId: string): void {
    this.remote.enqueue(docId);
  }

  /** Resolves when nothing is queued or running in either lane (tests and shutdown). */
  async whenIdle(): Promise<void> {
    while (!this.local.isIdle() || !this.remote.isIdle()) {
      await Promise.all([this.local.whenIdle(), this.remote.whenIdle()]);
    }
  }

  /**
   * At boot: documents left in `processing` by a previous run are processed again, and documents
   * whose NotebookLM sync was interrupted (pending/syncing) are synced again.
   */
  async resumePending(): Promise<void> {
    const { repo } = this.deps;
    const pending = await repo.documentsWithStatus('processing');
    for (const doc of pending) this.enqueue(doc.id);
    if (!this.deps.engines?.notebooklm) return;
    for (const status of ['pending', 'syncing'] as const) {
      for (const doc of await repo.documentsWithRemoteStatus(status)) {
        if (doc.status !== 'processing') this.enqueueRemote(doc.id);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopController.abort();
    this.local.stop();
    this.remote.stop();
  }

  private async process(docId: string): Promise<void> {
    const { repo } = this.deps;
    const doc = await repo.findDocument(docId);
    if (!doc) return;
    try {
      await this.ingest(doc);
    } catch (err) {
      if (this.stopped) return; // leave it in `processing`: resumePending retries on next boot
      const message =
        err instanceof ExtractionError || err instanceof ObjectStoreUnavailableError
          ? err.message
          : isAbortError(err)
            ? 'Tempo limite excedido ao extrair o texto do documento'
            : 'Falha ao processar o documento';
      if (!(err instanceof ExtractionError)) this.deps.onError?.(err, doc);
      await this.fail(doc, message);
    }
    await this.scheduleRemote(docId);
  }

  /**
   * A document that has to reach a remote engine goes to the remote lane once local processing is
   * over (also when local extraction failed: NotebookLM reads the original file itself).
   */
  private async scheduleRemote(docId: string): Promise<void> {
    if (this.stopped || !this.deps.engines) return;
    const doc = await this.deps.repo.findDocument(docId).catch(() => null);
    if (doc?.remoteStatus === 'pending') this.enqueueRemote(docId);
  }

  private async processRemote(docId: string): Promise<void> {
    const { repo, engines } = this.deps;
    const doc = await repo.findDocument(docId);
    if (!doc || !doc.remoteStatus || doc.status === 'processing') return; // processing: enqueued later
    const library = await repo.findById(doc.libraryId);
    const engine = library ? engines?.[library.engine] : undefined;
    if (!library || !engine?.onDocumentIndexed) return;
    try {
      await engine.onDocumentIndexed(library, doc);
    } catch (err) {
      if (this.stopped) return;
      this.deps.onError?.(err, doc);
      await repo
        .updateDocument(doc.id, {
          remoteStatus: 'error',
          remoteError: 'Falha ao sincronizar com o NotebookLM',
          updatedAt: this.deps.clock.now(),
        })
        .catch(() => undefined);
    }
  }

  private async fail(doc: LibraryDocument, message: string): Promise<void> {
    const { repo, index, clock } = this.deps;
    try {
      await index.replace(doc.id, doc.libraryId, []);
      await repo.updateDocument(doc.id, {
        status: 'error',
        error: message,
        chunkCount: 0,
        charCount: 0,
        updatedAt: clock.now(),
      });
    } catch {
      // the document was deleted while it was being processed
    }
  }

  private async ingest(doc: LibraryDocument): Promise<void> {
    const { repo, index, files, extractor, clock } = this.deps;
    const bytes = await files.read(doc.storageKey);
    const signal = AbortSignal.any([
      this.stopController.signal,
      AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
    ]);
    const extracted = await extractor.extract(
      { bytes, kind: doc.kind, name: doc.name, mimeType: doc.mimeType },
      { signal },
    );

    const sections: ExtractedSection[] = [];
    let charCount = 0;
    for (const section of extracted.sections) {
      const text = normalizeText(section.text);
      if (!text) continue;
      charCount += text.length;
      sections.push({ ...section, text });
    }
    if (charCount === 0)
      throw new ExtractionError(doc.kind === 'image' ? EMPTY_IMAGE_MESSAGE : EMPTY_TEXT_MESSAGE);

    const stats = await repo.stats(doc.libraryId);
    const limitReason = checkTextWithinLimits({
      documentChars: charCount,
      libraryChars: Math.max(stats.totalChars - doc.charCount, 0),
    });
    if (limitReason) throw new ExtractionError(limitReason);

    const chunks = chunkSections(sections);
    if (!(await repo.findDocument(doc.id))) return; // deleted meanwhile
    await index.replace(doc.id, doc.libraryId, chunks);
    await repo.updateDocument(doc.id, {
      status: 'ready',
      error: null,
      extraction: extracted.method,
      pageCount: extracted.pageCount,
      charCount,
      chunkCount: chunks.length,
      updatedAt: clock.now(),
    });
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}
