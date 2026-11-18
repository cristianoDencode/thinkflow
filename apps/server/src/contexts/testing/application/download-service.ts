import {
  TEST_LIMITS,
  downloadListQuerySchema,
  type TestDownloadDto,
  type TestDownloadSource,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { DomainError, NotFoundError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import {
  ObjectStoreUnavailableError,
  ObjectTooLargeError,
  type ObjectStream,
} from '../../../shared/kernel/object-store';
import {
  contentTypeFor,
  sanitizeFileName,
  sizeLabel,
  storageFileName,
  type CapturedDownload,
  type DownloadFile,
  type TestDownload,
} from '../domain/download';
import type { TestImageStore, TestSessionRepository } from '../domain/ports';
import { testKeys } from '../domain/session';

export interface DownloadServiceDeps {
  repo: TestSessionRepository;
  images: TestImageStore;
  clock: Clock;
  ids: IdGenerator;
  onError?: (err: unknown) => void;
}

export interface DownloadInput {
  sessionId: string;
  /** The step that triggered the download (null = none). */
  stepId: string | null;
  runId: string | null;
  source: TestDownloadSource;
  capture: CapturedDownload;
}

export const downloadUrl = (sessionId: string, downloadId: string): string =>
  `/api/tests/sessions/${encodeURIComponent(sessionId)}/downloads/${encodeURIComponent(downloadId)}/file`;

export function toDownloadDto(
  d: TestDownload,
  numbers: ReadonlyMap<string, number> = new Map(),
): TestDownloadDto {
  return {
    id: d.id,
    sessionId: d.sessionId,
    stepId: d.stepId,
    runId: d.runId,
    runSeq: d.runId ? (numbers.get(d.runId) ?? null) : null,
    source: d.source,
    fileName: d.fileName,
    size: d.size,
    contentType: d.contentType,
    url: d.url,
    status: d.status,
    reason: d.reason,
    createdAt: d.createdAt,
    fileUrl: d.status === 'saved' ? downloadUrl(d.sessionId, d.id) : null,
  };
}

/**
 * Files downloaded in the recorded or replayed browser: kept in the object storage as a history of
 * the test (never part of the document), each linked to the step (and run) that triggered it.
 */
export class DownloadService {
  /** Saves run one at a time, so the per-session limit is checked against the real count. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DownloadServiceDeps) {}

  /**
   * Waits for the browser to finish the file and stores it. Failures, canceled downloads and files
   * over the size limit are recorded too (without the file). Throws only when the session already
   * has the maximum number of downloads or the database fails.
   */
  async record(input: DownloadInput): Promise<TestDownload> {
    const startedAt = this.deps.clock.now();
    const file = await input.capture.file; // a slow download never holds back the others
    const result = this.tail.then(() => this.save(input, file, startedAt));
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async save(
    input: DownloadInput,
    file: DownloadFile,
    createdAt: number,
  ): Promise<TestDownload> {
    const { repo, images, ids } = this.deps;
    const { capture } = input;
    if ((await repo.countDownloads(input.sessionId)) >= TEST_LIMITS.maxDownloadsPerSession) {
      throw new DomainError(
        `Limite de ${TEST_LIMITS.maxDownloadsPerSession} downloads por sessão atingido: exclua arquivos antigos na aba Downloads.`,
        'too_many_downloads',
        400,
      );
    }
    const id = ids.next();
    const fileName = sanitizeFileName(capture.fileName);
    const base: TestDownload = {
      id,
      sessionId: input.sessionId,
      stepId: input.stepId,
      runId: input.runId,
      source: input.source,
      fileName,
      size: 0,
      contentType: contentTypeFor(fileName),
      url: capture.url,
      status: 'failed',
      reason: null,
      objectKey: null,
      createdAt,
    };
    let download: TestDownload;
    if (file.status === 'failed') {
      download = { ...base, reason: file.reason };
    } else if (file.status === 'skipped' || file.size > TEST_LIMITS.maxDownloadBytes) {
      download = {
        ...base,
        size: file.status === 'skipped' ? file.size : file.bytes.byteLength,
        status: 'skipped',
        reason: `Arquivo maior que ${sizeLabel(TEST_LIMITS.maxDownloadBytes)}: não foi salvo.`,
      };
    } else {
      const objectKey = testKeys.download(input.sessionId, id, storageFileName(fileName));
      const contentType = contentTypeFor(fileName, file.bytes);
      try {
        await images.put(objectKey, file.bytes, contentType, {
          maxBytes: TEST_LIMITS.maxDownloadBytes,
        });
        download = {
          ...base,
          size: file.bytes.byteLength,
          contentType,
          status: 'saved',
          objectKey,
        };
      } catch (err) {
        const reason =
          err instanceof ObjectStoreUnavailableError
            ? 'Armazenamento de documentos indisponível: o arquivo não foi salvo.'
            : err instanceof ObjectTooLargeError
              ? 'Arquivo maior que o limite do armazenamento: não foi salvo.'
              : 'Não foi possível salvar o arquivo no armazenamento.';
        if (!(err instanceof ObjectStoreUnavailableError)) this.deps.onError?.(err);
        download = { ...base, size: file.bytes.byteLength, reason };
      }
    }
    await repo.saveDownload(download);
    return download;
  }

  private async require(sessionId: string): Promise<void> {
    if (!(await this.deps.repo.find(sessionId))) throw new NotFoundError('Sessão de teste');
  }

  private async find(sessionId: string, downloadId: string): Promise<TestDownload> {
    const download = await this.deps.repo.findDownload(downloadId);
    if (!download || download.sessionId !== sessionId) throw new NotFoundError('Download');
    return download;
  }

  /** Newest first; `query` = `?source=` and `?runId=`. */
  async list(sessionId: string, query: unknown = {}): Promise<TestDownloadDto[]> {
    const filter = downloadListQuerySchema.parse(query ?? {});
    await this.require(sessionId);
    const [items, numbers] = await Promise.all([
      this.deps.repo.downloads(sessionId, filter),
      this.deps.repo.runNumbers(sessionId),
    ]);
    return items.map((d) => toDownloadDto(d, numbers));
  }

  /** The stored file as a stream (the caller consumes it or calls `abort()`). */
  async open(
    sessionId: string,
    downloadId: string,
  ): Promise<{ download: TestDownload; stream: ObjectStream }> {
    await this.require(sessionId);
    const download = await this.find(sessionId, downloadId);
    if (download.status !== 'saved' || !download.objectKey) {
      throw new DomainError('Este download não tem arquivo salvo.', 'download_not_saved', 404);
    }
    const stream = await this.deps.images.stream(download.objectKey);
    if (!stream) throw new NotFoundError('Arquivo');
    return { download, stream };
  }

  /** Deletes the file and the row. With the storage down the row stays, so the user can retry. */
  async delete(sessionId: string, downloadId: string): Promise<void> {
    await this.require(sessionId);
    const download = await this.find(sessionId, downloadId);
    if (download.objectKey) await this.deps.images.delete(download.objectKey);
    await this.deps.repo.deleteDownload(download.id);
  }
}
