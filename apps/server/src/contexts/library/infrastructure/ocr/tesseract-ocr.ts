import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { createWorker as createWorkerFromModule } from 'tesseract.js';
import { ExtractionError } from '../../domain/library';
import type { LibraryUsageRecorder, OcrEngine } from '../../domain/ports';

/** Max time for one image; a worker stuck on a pathological image is terminated and rebuilt. */
const RECOGNIZE_TIMEOUT_MS = 120_000;
/** Offline data packages ship the small "best, integer" LSTM models in this folder. */
const DATA_PACKAGE_DIR = '4.0.0_best_int';

export interface TesseractWorkerLike {
  recognize(image: Buffer): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}

/** Creates a worker for `langs` that reads/writes language data under `tessdataDir`. */
export type TesseractWorkerFactory = (
  langs: string,
  tessdataDir: string,
) => Promise<TesseractWorkerLike>;

export interface TesseractOcrDeps {
  /** Folder for the uncompressed `<lang>.traineddata` files (DATA_DIR/tessdata). */
  tessdataDir: string;
  /** Languages joined with `+`, read on every call so settings changes apply. */
  languages: () => string;
  usage?: LibraryUsageRecorder;
  /** Informational messages (first-use downloads, worker restarts). */
  log?: (message: string) => void;
  /** Test seam; defaults to `tesseract.js` (loaded lazily). */
  createWorker?: TesseractWorkerFactory;
}

/**
 * Local OCR (private, offline). One tesseract.js worker, created on first use, reused for every
 * image and processed strictly one at a time (it holds 100-250 MB of RAM while it exists).
 */
export class TesseractOcr implements OcrEngine {
  readonly method = 'ocr-local' as const;
  private worker: TesseractWorkerLike | null = null;
  private workerLangs = '';
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly deps: TesseractOcrDeps) {}

  recognize(image: Uint8Array, _mime: string, signal?: AbortSignal): Promise<string> {
    const run = () => this.recognizeNow(image, signal);
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Frees the worker (app shutdown). Later calls are rejected. */
  async terminate(): Promise<void> {
    this.closed = true;
    await this.tail.catch(() => undefined);
    await this.dropWorker();
  }

  private async recognizeNow(image: Uint8Array, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.closed)
      throw new ExtractionError('OCR local indisponível: o servidor está encerrando');
    const langs = this.deps.languages();
    let text = '';
    let success = false;
    try {
      const worker = await this.ensureWorker(langs);
      const timeout = AbortSignal.timeout(RECOGNIZE_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const job = worker.recognize(Buffer.from(image));
      job.catch(() => undefined); // a terminated worker may reject late
      try {
        text = await raceAbort(
          job.then((r) => r.data.text),
          combined,
        );
      } catch (err) {
        // The WASM job cannot be cancelled: drop the worker so the next image starts clean.
        await this.dropWorker();
        if (timeout.aborted && !signal?.aborted)
          throw new ExtractionError('O OCR demorou demais para reconhecer a imagem');
        throw err;
      }
      success = true;
      return text;
    } finally {
      this.deps.usage?.record({
        source: 'library-ocr',
        providerId: 'tesseract',
        model: langs,
        success,
        inputTokens: 0,
        outputTokens: Math.ceil(text.length / 4),
      });
    }
  }

  private async ensureWorker(langs: string): Promise<TesseractWorkerLike> {
    if (this.worker && this.workerLangs === langs) return this.worker;
    await this.dropWorker();
    await fs.mkdir(this.deps.tessdataDir, { recursive: true });
    const packaged = await installPackagedLanguages(langs, this.deps.tessdataDir);
    const missing = langs.split('+').filter((l) => !packaged.has(l));
    if (missing.length > 0)
      this.deps.log?.(
        `OCR: baixando dados de idioma (${missing.join(', ')}) para ${this.deps.tessdataDir}; só ocorre no primeiro uso`,
      );
    try {
      this.worker = await (this.deps.createWorker ?? defaultCreateWorker)(
        langs,
        this.deps.tessdataDir,
      );
    } catch (err) {
      this.deps.log?.(`OCR: falha ao iniciar o worker: ${errorText(err)}`);
      throw new ExtractionError(
        missing.length > 0
          ? `Não foi possível carregar os idiomas do OCR (${missing.join(', ')}). O primeiro uso precisa de internet para baixar os dados de idioma.`
          : 'Não foi possível iniciar o OCR local',
      );
    }
    this.workerLangs = langs;
    return this.worker;
  }

  private async dropWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.workerLangs = '';
    if (worker) await worker.terminate().catch(() => undefined);
  }
}

/**
 * Copies the offline traineddata that ships in `@tesseract.js-data/<lang>` to `tessdataDir`
 * (tesseract.js reads `<cachePath>/<lang>.traineddata` before trying the network).
 * Returns the languages that are available locally; the others are downloaded by tesseract.js.
 */
export async function installPackagedLanguages(
  langs: string,
  tessdataDir: string,
): Promise<Set<string>> {
  const available = new Set<string>();
  const require = createRequire(import.meta.url);
  for (const lang of new Set(langs.split('+'))) {
    const target = path.join(tessdataDir, `${lang}.traineddata`);
    if (await exists(target)) {
      available.add(lang);
      continue;
    }
    try {
      const pkgJson = require.resolve(`@tesseract.js-data/${lang}/package.json`);
      const gz = await fs.readFile(
        path.join(path.dirname(pkgJson), DATA_PACKAGE_DIR, `${lang}.traineddata.gz`),
      );
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(tmp, gunzipSync(gz));
      await fs.rename(tmp, target);
      available.add(lang);
    } catch {
      // not packaged (or unreadable): tesseract.js downloads it and caches it in tessdataDir
    }
  }
  return available;
}

type CreateWorkerFn = typeof createWorkerFromModule;

const defaultCreateWorker: TesseractWorkerFactory = async (langs, tessdataDir) => {
  const mod = (await import('tesseract.js')) as unknown as {
    createWorker?: CreateWorkerFn;
    default?: { createWorker: CreateWorkerFn };
  };
  const createWorker = mod.createWorker ?? mod.default!.createWorker;
  // 1 = LSTM only (the packaged models). `cachePath` is both read and written.
  return createWorker(langs, 1, { cachePath: tessdataDir, errorHandler: () => undefined });
};

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
