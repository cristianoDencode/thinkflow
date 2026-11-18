import { createHash } from 'node:crypto';
import {
  LIBRARY_LIMITS,
  libraryInputSchema,
  maxDocumentsFor,
  libraryUpdateSchema,
  type LibraryDetailDto,
  type LibraryDocumentDto,
  type LibraryDocumentTextDto,
  type LibraryDto,
  type LibrarySearchResultDto,
  type LibraryUploadResultDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { ConflictError, DomainError, NotFoundError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import {
  ObjectStoreUnavailableError,
  ObjectTooLargeError,
} from '../../../shared/kernel/object-store';
import {
  detectDocumentKind,
  extensionForKind,
  mimeForKind,
  unsupportedTypeReason,
} from '../domain/document-type';
import type { LibraryEngine } from '../domain/engine';
import {
  checkCanAddDocument,
  sanitizeDisplayName,
  type Library,
  type LibraryDocument,
  type LibraryEngineKind,
  type LibraryStats,
} from '../domain/library';
import type { ChunkIndex, DocumentFileStore, LibraryRepository } from '../domain/ports';
import { joinAdjacent } from '../domain/retrieval';
import { LIBRARY_TOOL_MAX_CHARS } from '../domain/tool-format';
import type { IngestionQueue } from './ingestion-queue';
import { buildLibraryChatTools, type LibraryChatTools } from './library-toolset';

export interface LibraryServiceDeps {
  repo: LibraryRepository;
  index: ChunkIndex;
  files: DocumentFileStore;
  ingestion: Pick<IngestionQueue, 'enqueue' | 'enqueueRemote'>;
  /** `local` is mandatory; `notebooklm` is registered by the composition root. */
  engines: { local: LibraryEngine } & Partial<Record<LibraryEngineKind, LibraryEngine>>;
  /** NotebookLM libraries need the integration switched on with a Google session. */
  notebookLm?: { isConfigured(): boolean; sourceLimit?(): number };
  clock: Clock;
  ids: IdGenerator;
  onError?: (err: unknown) => void;
}

export interface UploadedFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export const toDocumentDto = (d: LibraryDocument): LibraryDocumentDto => ({
  id: d.id,
  libraryId: d.libraryId,
  name: d.name,
  mimeType: d.mimeType,
  kind: d.kind,
  sizeBytes: d.sizeBytes,
  status: d.status,
  error: d.error,
  extraction: d.extraction,
  pageCount: d.pageCount,
  charCount: d.charCount,
  chunkCount: d.chunkCount,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  remote: d.remoteStatus ? { status: d.remoteStatus, error: d.remoteError } : null,
});

const toLibraryDto = (lib: Library, stats: LibraryStats, maxDocuments: number): LibraryDto => ({
  id: lib.id,
  name: lib.name,
  description: lib.description,
  engine: lib.engine,
  documentCount: stats.documentCount,
  maxDocuments,
  readyCount: stats.readyCount,
  processingCount: stats.processingCount,
  errorCount: stats.errorCount,
  totalChars: stats.totalChars,
  createdAt: lib.createdAt,
  updatedAt: lib.updatedAt,
  remoteNotebookId: lib.remoteNotebookId,
});

export class LibraryService {
  /** Serializes uploads so the document-count limit cannot be raced. */
  private uploadLock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LibraryServiceDeps) {}

  private engineFor(kind: LibraryEngineKind): LibraryEngine {
    return this.deps.engines[kind] ?? this.deps.engines.local;
  }

  /** Documents a library may hold: fixed for local ones, the account's source limit for NotebookLM. */
  private maxDocuments(library: Pick<Library, 'engine'>): number {
    return maxDocumentsFor(library.engine, this.deps.notebookLm?.sourceLimit?.());
  }

  private async require(id: string): Promise<Library> {
    const library = await this.deps.repo.findById(id);
    if (!library) throw new NotFoundError('Biblioteca');
    return library;
  }

  private async requireDocument(libraryId: string, docId: string): Promise<LibraryDocument> {
    const doc = await this.deps.repo.findDocument(docId);
    if (!doc || doc.libraryId !== libraryId) throw new NotFoundError('Documento');
    return doc;
  }

  private async touch(library: Library): Promise<void> {
    await this.deps.repo.save({ ...library, updatedAt: this.deps.clock.now() });
  }

  async list(): Promise<LibraryDto[]> {
    const { repo } = this.deps;
    const all = await repo.list();
    return Promise.all(
      all.map(async (lib) => toLibraryDto(lib, await repo.stats(lib.id), this.maxDocuments(lib))),
    );
  }

  async get(id: string): Promise<LibraryDetailDto> {
    const library = await this.require(id);
    const [stats, docs] = await Promise.all([
      this.deps.repo.stats(id),
      this.deps.repo.documents(id),
    ]);
    return {
      ...toLibraryDto(library, stats, this.maxDocuments(library)),
      documents: docs.map(toDocumentDto),
    };
  }

  async create(input: unknown): Promise<LibraryDto> {
    const data = libraryInputSchema.parse(input);
    const { repo, clock, ids } = this.deps;
    if (await repo.findByName(data.name))
      throw new ConflictError(`Já existe uma biblioteca "${data.name}"`);
    if ((await repo.list()).length >= LIBRARY_LIMITS.maxLibraries)
      throw new DomainError(
        `Limite de ${LIBRARY_LIMITS.maxLibraries} bibliotecas atingido`,
        'library_limit',
        400,
      );
    if (data.engine === 'notebooklm') {
      if (!this.deps.engines.notebooklm || !this.deps.notebookLm?.isConfigured())
        throw new DomainError(
          'Configure o NotebookLM na aba "NotebookLM (experimental)" antes',
          'notebooklm_not_configured',
          400,
        );
      if (!data.acceptRemoteUpload)
        throw new DomainError(
          'Confirme que os documentos serão enviados ao NotebookLM',
          'remote_upload_not_accepted',
          400,
        );
    }
    const now = clock.now();
    let library: Library = {
      id: ids.next(),
      name: data.name,
      description: data.description,
      engine: data.engine,
      remoteNotebookId: null,
      createdAt: now,
      updatedAt: now,
    };
    const remote = await this.engineFor(data.engine).onLibraryCreated?.(library);
    if (remote) library = { ...library, ...remote };
    await repo.save(library);
    return toLibraryDto(library, await repo.stats(library.id), this.maxDocuments(library));
  }

  async update(id: string, input: unknown): Promise<LibraryDto> {
    const patch = libraryUpdateSchema.parse(input);
    const library = await this.require(id);
    if (patch.name !== undefined && patch.name !== library.name) {
      const clash = await this.deps.repo.findByName(patch.name);
      if (clash && clash.id !== id)
        throw new ConflictError(`Já existe uma biblioteca "${patch.name}"`);
    }
    const updated: Library = {
      ...library,
      name: patch.name ?? library.name,
      description: patch.description ?? library.description,
      updatedAt: this.deps.clock.now(),
    };
    await this.deps.repo.save(updated);
    return toLibraryDto(updated, await this.deps.repo.stats(id), this.maxDocuments(updated));
  }

  async delete(id: string): Promise<void> {
    const library = await this.require(id);
    try {
      await this.engineFor(library.engine).onLibraryDeleted?.(library);
    } catch (err) {
      this.deps.onError?.(err);
    }
    await this.deps.files.deleteLibrary(id);
    await this.deps.repo.delete(id); // cascades to documents, chunks and the FTS index
  }

  addDocuments(libraryId: string, files: UploadedFile[]): Promise<LibraryUploadResultDto> {
    const run = this.uploadLock.then(() => this.doAddDocuments(libraryId, files));
    this.uploadLock = run.catch(() => undefined);
    return run;
  }

  private async doAddDocuments(
    libraryId: string,
    files: UploadedFile[],
  ): Promise<LibraryUploadResultDto> {
    const { repo, clock, ids } = this.deps;
    const library = await this.require(libraryId);
    if (files.length === 0) throw new DomainError('Nenhum arquivo enviado', 'no_files', 400);
    if (files.length > LIBRARY_LIMITS.maxFilesPerUpload)
      throw new DomainError(
        `Envie no máximo ${LIBRARY_LIMITS.maxFilesPerUpload} arquivos por vez`,
        'too_many_files',
        400,
      );

    // with the storage down nothing is accepted (503, pt-BR): the user retries later
    await this.deps.files.assertWritable();

    const result: LibraryUploadResultDto = { accepted: [], rejected: [] };
    const existing = await repo.documents(libraryId);
    const maxDocuments = this.maxDocuments(library);
    const hashesInBatch = new Map<string, string>();
    let count = existing.length;

    let storageDown: string | null = null;
    for (const file of files) {
      const name = sanitizeDisplayName(file.name);
      const reject = (reason: string) => result.rejected.push({ name, reason });
      if (storageDown) {
        reject(storageDown);
        continue;
      }
      const kind = detectDocumentKind(file.bytes, name, file.mimeType);
      if (!kind) {
        reject(unsupportedTypeReason(name));
        continue;
      }
      const sizeReason = checkCanAddDocument({
        existingCount: count,
        kind,
        sizeBytes: file.bytes.byteLength,
        maxDocuments,
        engine: library.engine,
      });
      if (sizeReason) {
        reject(sizeReason);
        continue;
      }
      const sha256 = createHash('sha256').update(file.bytes).digest('hex');
      const duplicate =
        hashesInBatch.get(sha256) ?? (await repo.findByHash(libraryId, sha256))?.name;
      if (duplicate) {
        reject(`Documento já existe nesta biblioteca (${duplicate})`);
        continue;
      }

      const id = ids.next();
      const now = clock.now();
      let storageKey: string;
      try {
        storageKey = await this.deps.files.put(
          libraryId,
          id,
          extensionForKind(kind, file.bytes),
          file.bytes,
          { contentType: mimeForKind(kind, file.bytes), sha256 },
        );
      } catch (err) {
        // the files already stored in this batch are kept (and indexed); the rest is rejected
        if (err instanceof ObjectStoreUnavailableError) storageDown = err.message;
        else if (!(err instanceof ObjectTooLargeError)) throw err;
        reject(err.message);
        continue;
      }
      const doc: LibraryDocument = {
        id,
        libraryId,
        name,
        mimeType: mimeForKind(kind, file.bytes),
        kind,
        sizeBytes: file.bytes.byteLength,
        sha256,
        status: 'processing',
        error: null,
        extraction: null,
        pageCount: null,
        charCount: 0,
        chunkCount: 0,
        storageKey,
        remoteSourceId: null,
        remoteStatus: library.engine === 'notebooklm' ? 'pending' : null,
        remoteError: null,
        createdAt: now,
        updatedAt: now,
      };
      await repo.saveDocument(doc);
      hashesInBatch.set(sha256, name);
      count += 1;
      result.accepted.push(toDocumentDto(doc));
    }

    if (result.accepted.length > 0) {
      await this.touch(library);
      for (const doc of result.accepted) this.deps.ingestion.enqueue(doc.id);
    }
    return result;
  }

  async deleteDocument(libraryId: string, docId: string): Promise<void> {
    const library = await this.require(libraryId);
    const doc = await this.requireDocument(libraryId, docId);
    try {
      await this.engineFor(library.engine).onDocumentDeleted?.(library, doc);
    } catch (err) {
      this.deps.onError?.(err);
    }
    await this.deps.repo.deleteDocument(docId); // cascades to chunks and FTS
    await this.deps.files.delete(doc.storageKey).catch((err: unknown) => this.deps.onError?.(err));
    await this.touch(library);
  }

  async reindex(libraryId: string, docId: string): Promise<LibraryDocumentDto> {
    await this.require(libraryId);
    const doc = await this.requireDocument(libraryId, docId);
    const now = this.deps.clock.now();
    await this.deps.repo.updateDocument(docId, {
      status: 'processing',
      error: null,
      updatedAt: now,
    });
    this.deps.ingestion.enqueue(docId);
    return toDocumentDto({ ...doc, status: 'processing', error: null, updatedAt: now });
  }

  /** NotebookLM only: uploads the document to the notebook again (after a sync error, say). */
  async resync(libraryId: string, docId: string): Promise<LibraryDocumentDto> {
    const library = await this.require(libraryId);
    if (library.engine !== 'notebooklm')
      throw new DomainError(
        'Esta biblioteca não usa o NotebookLM',
        'not_a_notebooklm_library',
        400,
      );
    const doc = await this.requireDocument(libraryId, docId);
    const now = this.deps.clock.now();
    await this.deps.repo.updateDocument(docId, {
      remoteStatus: 'pending',
      remoteError: null,
      updatedAt: now,
    });
    // while the local indexing is still running, its completion hands the document to the remote lane
    if (doc.status !== 'processing') this.deps.ingestion.enqueueRemote(docId);
    return toDocumentDto({ ...doc, remoteStatus: 'pending', remoteError: null, updatedAt: now });
  }

  async documentText(
    libraryId: string,
    docId: string,
    offset: number,
    limit: number,
  ): Promise<LibraryDocumentTextDto> {
    await this.require(libraryId);
    await this.requireDocument(libraryId, docId);
    let full = '';
    for (const chunk of await this.deps.index.documentChunks(docId))
      full = full ? joinAdjacent(full, chunk.text) : chunk.text;
    return {
      text: full.slice(offset, offset + limit),
      offset,
      limit,
      total: full.length,
      hasMore: offset + limit < full.length,
    };
  }

  /** What the "Testar busca" UI shows: exactly the output the AI would receive. */
  async search(libraryId: string, query: string, k: number): Promise<LibrarySearchResultDto> {
    const library = await this.require(libraryId);
    const result = await this.engineFor(library.engine).search(library, query, {
      k,
      maxChars: LIBRARY_TOOL_MAX_CHARS,
    });
    return {
      engine: library.engine,
      hits: result.hits ?? [],
      toolOutput: result.text,
      isError: result.isError,
    };
  }

  /** Chat tool for one turn; null when the library no longer exists. */
  async chatTools(
    libraryId: string,
    opts: {
      maxOutputChars: number;
      /** Per-instance limits (default: the chat's per-turn limits). */
      maxCalls?: number;
      maxTotalChars?: number;
      /** Tighter call limit applied only when the library is answered by NotebookLM (daily quota). */
      remoteMaxCalls?: number;
    },
  ): Promise<LibraryChatTools | null> {
    const library = await this.deps.repo.findById(libraryId);
    if (!library) return null;
    const maxCalls =
      library.engine === 'notebooklm' && opts.remoteMaxCalls !== undefined
        ? Math.min(opts.maxCalls ?? opts.remoteMaxCalls, opts.remoteMaxCalls)
        : opts.maxCalls;
    return buildLibraryChatTools({
      library,
      documents: await this.deps.repo.documents(libraryId),
      engine: this.engineFor(library.engine),
      maxOutputChars: opts.maxOutputChars,
      ...(maxCalls !== undefined ? { maxCalls } : {}),
      ...(opts.maxTotalChars !== undefined ? { maxTotalChars: opts.maxTotalChars } : {}),
    });
  }
}
