import type { TestDownloadSource, TestDownloadStatus } from '@thinkflow/shared';

/** A file the browser downloaded while recording or replaying (persisted in `test_downloads`). */
export interface TestDownload {
  id: string;
  sessionId: string;
  /** The step that triggered it; null = no recorded step close enough. */
  stepId: string | null;
  runId: string | null;
  source: TestDownloadSource;
  /** Sanitized `suggestedFilename`. */
  fileName: string;
  size: number;
  contentType: string;
  /** Origin + path only: query strings often carry tokens. */
  url: string;
  status: TestDownloadStatus;
  /** pt-BR, for `failed` and `skipped`. */
  reason: string | null;
  /** Object key (in the `tests/` namespace); null unless `saved`. */
  objectKey: string | null;
  createdAt: number;
}

export interface DownloadFilter {
  source?: TestDownloadSource;
  runId?: string;
}

/** What the browser adapter hands over when the file is complete (or why it never will be). */
export type DownloadFile =
  | { status: 'ready'; size: number; bytes: Uint8Array }
  | { status: 'skipped'; size: number }
  | { status: 'failed'; reason: string };

/** A download that started in the browser; `file` settles when it finished (never rejects). */
export interface CapturedDownload {
  /** Epoch ms when the download started. */
  at: number;
  /** Already reduced to origin + path. */
  url: string;
  /** As suggested by the page (not sanitized yet). */
  fileName: string;
  file: Promise<DownloadFile>;
}

/** A step is credited with a download that started at most this long after it was recorded. */
export const DOWNLOAD_LINK_WINDOW_MS = 10_000;

/** How long closing the browser (and the recording) waits for downloads still in flight. */
export const DOWNLOAD_DRAIN_MS = 20_000;

/** A recorded step, remembered to link the downloads that follow it. */
export interface StepMark<T = unknown> {
  pageId: string | null;
  at: number;
  step: T;
}

/**
 * Steps that may have triggered a download on `pageId` that started at `at`, best first (the most
 * recent). Only the page's own steps count; a page without any step of its own (a popup opened by
 * a click) falls back to the steps of the other pages.
 */
export function linkCandidates<T>(
  marks: readonly StepMark<T>[],
  pageId: string | null,
  at: number,
  windowMs = DOWNLOAD_LINK_WINDOW_MS,
): StepMark<T>[] {
  // a little slack for the clock reading of the click and of the download being taken apart
  const recent = (m: StepMark<T>) => at - m.at >= -2_000 && at - m.at <= windowMs;
  const newestFirst = (list: StepMark<T>[]) => list.filter(recent).sort((a, b) => b.at - a.at);
  const own = marks.filter((m) => m.pageId === null || m.pageId === pageId);
  if (own.some((m) => m.pageId === pageId) || pageId === null) return newestFirst(own);
  return newestFirst([...marks]);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A name that is safe to show, to put in a header and to save on any filesystem. */
export function sanitizeFileName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  let name = base.length === 0 ? 'download' : base;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name.length > 150) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 150 - ext.length) + ext;
  }
  return name;
}

/**
 * The file name inside the object key: the storage accepts lowercase ASCII, digits and `._-`
 * only. The real name lives in the database.
 */
export function storageFileName(fileName: string): string {
  const ascii = fileName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/\.{2,}/g, '.');
  const name = ascii.length === 0 ? 'download' : ascii;
  if (name.length <= 100) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return name.slice(0, 100 - ext.length) + ext;
}

const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  zip: 'application/zip',
  gz: 'application/gzip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  rtf: 'application/rtf',
  ofx: 'application/x-ofx',
};

const MAGIC: [number[], string][] = [
  [[0x25, 0x50, 0x44, 0x46], 'application/pdf'],
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x50, 0x4b, 0x03, 0x04], 'application/zip'],
];

/** From the extension; unknown extensions are sniffed from the first bytes (cheap). */
export function contentTypeFor(fileName: string, bytes?: Uint8Array): string {
  const dot = fileName.lastIndexOf('.');
  const byName = dot >= 0 ? EXTENSION_TYPES[fileName.slice(dot + 1).toLowerCase()] : undefined;
  if (byName) return byName;
  if (bytes) {
    for (const [magic, type] of MAGIC) if (magic.every((b, i) => bytes[i] === b)) return type;
  }
  return 'application/octet-stream';
}

/** Types a browser could render or run: served as opaque bytes (they are always attachments too). */
const ACTIVE_TYPES = new Set(['text/html', 'image/svg+xml', 'application/xml']);

export const servedContentType = (type: string): string =>
  ACTIVE_TYPES.has(type) ? 'application/octet-stream' : type;

/** `Content-Disposition: attachment` with an ASCII fallback and the real name (RFC 5987). */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(
    fileName,
  ).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** Origin and path only: the query string and fragment often hold tokens. */
export function safeDownloadUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return (url.origin + url.pathname).slice(0, 2000);
    }
    if (url.protocol === 'blob:') {
      const inner = new URL(url.pathname);
      return `blob:${inner.origin}`.slice(0, 2000);
    }
    return `${url.protocol}`;
  } catch {
    return '';
  }
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
