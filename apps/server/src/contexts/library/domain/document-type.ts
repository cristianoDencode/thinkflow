import type { DocumentKind } from './library';

export const UNSUPPORTED_TYPE_MESSAGE =
  'Tipo não suportado. Envie PDF, DOCX, Markdown, TXT ou imagens (PNG, JPG, WEBP).';
export const LEGACY_DOC_MESSAGE = 'Arquivos .doc antigos não são suportados — salve como .docx';

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((b, i) => bytes[offset + i] === b);
}

function isValidUtf8Text(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Decides the kind by magic bytes first and by extension second; null when unsupported. */
export function detectDocumentKind(
  bytes: Uint8Array,
  name: string,
  declaredMime = '',
): DocumentKind | null {
  const ext = extensionOf(name);
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return ext === 'docx' ? 'docx' : null; // PK..
  if (
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    startsWith(bytes, [0xff, 0xd8, 0xff]) || // JPEG
    (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) // RIFF....WEBP
  )
    return 'image';
  if (ext === 'md' || ext === 'markdown') return isValidUtf8Text(bytes) ? 'markdown' : null;
  if (ext === 'txt' || declaredMime.toLowerCase().startsWith('text/plain'))
    return isValidUtf8Text(bytes) ? 'text' : null;
  return null;
}

/** pt-BR reason for a rejected type (more specific for legacy `.doc`). */
export function unsupportedTypeReason(name: string): string {
  return extensionOf(name) === 'doc' ? LEGACY_DOC_MESSAGE : UNSUPPORTED_TYPE_MESSAGE;
}

export function extensionForKind(kind: DocumentKind, bytes?: Uint8Array): string {
  switch (kind) {
    case 'pdf':
      return 'pdf';
    case 'docx':
      return 'docx';
    case 'markdown':
      return 'md';
    case 'text':
      return 'txt';
    case 'image':
      return mimeForKind(kind, bytes).slice('image/'.length).replace('jpeg', 'jpg');
  }
}

/** MIME type for storing/serving; images are sniffed from the bytes. */
export function mimeForKind(kind: DocumentKind, bytes?: Uint8Array): string {
  switch (kind) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'markdown':
      return 'text/markdown';
    case 'text':
      return 'text/plain';
    case 'image':
      if (bytes && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
      if (bytes && startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
      return 'image/webp';
  }
}
