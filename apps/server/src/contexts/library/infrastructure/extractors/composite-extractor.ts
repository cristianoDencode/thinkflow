import { ExtractionError } from '../../domain/library';
import type { OcrEngine, TextExtractor } from '../../domain/ports';
import { extractDocx } from './docx-extractor';
import { recognizeWithFallback, type OcrSelection } from './ocr-selection';
import { extractPdf, type PdfOcrOptions } from './pdf-extractor';
import { extractPlainText } from './plain-text-extractor';

export const OCR_OFF_MESSAGE = 'OCR desativado em Biblioteca → Configurações';

export interface CompositeExtractorDeps {
  /** Resolves the OCR engine to use right now; null when OCR is off. */
  ocr?: () => OcrEngine | null;
  /** Used when the engine above fails (vision falls back to local OCR). */
  ocrFallback?: () => OcrEngine | null;
  /** Non-fatal problems (fallbacks, truncated OCR) for the server log. */
  onWarning?: (message: string) => void;
  /** Test seams for scanned-PDF rendering. */
  pdfOcr?: Pick<PdfOcrOptions, 'renderer' | 'canvasAvailable'>;
}

/** Dispatches by document kind. Images (and scanned PDF pages) go through the OCR engine. */
export class CompositeExtractor implements TextExtractor {
  constructor(private readonly deps: CompositeExtractorDeps = {}) {}

  async extract(
    input: Parameters<TextExtractor['extract']>[0],
    opts: Parameters<TextExtractor['extract']>[1],
  ): ReturnType<TextExtractor['extract']> {
    const { bytes, kind } = input;
    switch (kind) {
      case 'markdown':
      case 'text':
        return {
          sections: extractPlainText(bytes),
          method: 'text',
          pageCount: null,
          warnings: [],
        };
      case 'pdf': {
        const selection = this.selection();
        const out = await extractPdf(
          bytes,
          opts.signal,
          selection ? { selection, ...this.deps.pdfOcr } : undefined,
        );
        out.warnings.forEach((w) => this.deps.onWarning?.(`${input.name}: ${w}`));
        return out;
      }
      case 'docx': {
        const { sections, warnings } = await extractDocx(bytes, opts.signal);
        return { sections, method: 'text', pageCount: null, warnings };
      }
      case 'image': {
        const selection = this.selection();
        if (!selection) throw new ExtractionError(OCR_OFF_MESSAGE);
        const mime = input.mimeType ?? 'image/png';
        const { text, method } = await recognizeWithFallback(selection, bytes, mime, opts.signal);
        return {
          sections: text.trim() ? [{ text }] : [],
          method,
          pageCount: null,
          warnings: [],
        };
      }
    }
  }

  private selection(): OcrSelection | null {
    const primary = this.deps.ocr?.() ?? null;
    if (!primary) return null;
    return {
      primary,
      fallback: this.deps.ocrFallback?.() ?? null,
      onWarning: this.deps.onWarning,
    };
  }
}
