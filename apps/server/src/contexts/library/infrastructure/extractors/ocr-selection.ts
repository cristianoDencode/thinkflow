import type { ExtractionMethod } from '../../domain/library';
import type { OcrEngine } from '../../domain/ports';

/** The OCR engine to use now plus an optional fallback (vision falls back to local OCR). */
export interface OcrSelection {
  primary: OcrEngine;
  fallback?: OcrEngine | null;
  onWarning?: (message: string) => void;
}

export interface OcrOutcome {
  text: string;
  method: Extract<ExtractionMethod, 'ocr-local' | 'ocr-vision'>;
}

/** Runs the primary engine; on failure (not on abort) runs the fallback and warns. */
export async function recognizeWithFallback(
  selection: OcrSelection,
  image: Uint8Array,
  mime: string,
  signal?: AbortSignal,
): Promise<OcrOutcome> {
  const { primary, fallback } = selection;
  try {
    return { text: await primary.recognize(image, mime, signal), method: primary.method };
  } catch (err) {
    signal?.throwIfAborted();
    if (!fallback || fallback === primary) throw err;
    selection.onWarning?.(
      `OCR por IA falhou (${err instanceof Error ? err.message : String(err)}); usando OCR local`,
    );
    return { text: await fallback.recognize(image, mime, signal), method: fallback.method };
  }
}
