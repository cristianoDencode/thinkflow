import fs from 'node:fs/promises';
import type { Download, Page } from 'playwright-core';
import {
  DOWNLOAD_DRAIN_MS,
  safeDownloadUrl,
  type CapturedDownload,
  type DownloadFile,
} from '../../domain/download';

/** pt-BR reason for a download the browser did not finish. */
function failureReason(failure: string | null | undefined): string {
  if (!failure || failure === 'canceled') return 'O download foi cancelado antes de terminar.';
  return `O download falhou (${failure.split('\n')[0]!.slice(0, 120)}).`;
}

/**
 * Takes the file out of Playwright's temporary folder (deleted when the context closes) as soon as
 * the browser finishes it. Files over `maxBytes` are measured but never read.
 */
async function readDownload(download: Download, maxBytes: number): Promise<DownloadFile> {
  try {
    const failure = await download.failure(); // waits for the download to finish
    if (failure) return { status: 'failed', reason: failureReason(failure) };
    const path = await download.path();
    const { size } = await fs.stat(path);
    if (size > maxBytes) {
      await download.delete().catch(() => undefined);
      return { status: 'skipped', size };
    }
    const bytes = new Uint8Array(await fs.readFile(path));
    await download.delete().catch(() => undefined);
    return { status: 'ready', size: bytes.byteLength, bytes };
  } catch {
    return { status: 'failed', reason: 'Não foi possível ler o arquivo baixado.' };
  }
}

export function captureDownload(download: Download, maxBytes: number): CapturedDownload {
  return {
    at: Date.now(),
    url: safeDownloadUrl(download.url()),
    fileName: download.suggestedFilename(),
    file: readDownload(download, maxBytes),
  };
}

/**
 * Reports every download of every page of a browser context (tabs and popups), and lets the owner
 * wait, for a bounded time, for the files still being written before the browser closes.
 */
export class DownloadWatcher {
  private readonly attached = new WeakSet<Page>();
  private readonly files = new Set<Promise<DownloadFile>>();

  constructor(private readonly maxBytes: number) {}

  /** Call for every page as soon as it exists (before it can start a download). */
  attach(page: Page, onDownload: (capture: CapturedDownload, download: Download) => void): void {
    if (this.attached.has(page)) return;
    this.attached.add(page);
    page.on('download', (download) => {
      const capture = captureDownload(download, this.maxBytes);
      const file = capture.file;
      this.files.add(file);
      void file.finally(() => this.files.delete(file));
      onDownload(capture, download);
    });
  }

  /** Waits for downloads in flight, at most `ms`. */
  async drain(ms = DOWNLOAD_DRAIN_MS): Promise<void> {
    if (this.files.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.files]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
