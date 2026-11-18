import type { ExtractedSection } from '../../domain/library';

/** Markdown and TXT: decoded as-is (the chunker uses Markdown headings). The BOM is stripped. */
export function extractPlainText(bytes: Uint8Array): ExtractedSection[] {
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
  return text.trim() ? [{ text }] : [];
}
