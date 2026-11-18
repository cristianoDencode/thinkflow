import { getDocumentProxy } from 'unpdf';
import { ExtractionError, LIBRARY_LIMITS, type ExtractedSection } from '../../domain/library';
import { recognizeWithFallback, type OcrSelection } from './ocr-selection';
import { isCanvasAvailable, PDF_OCR_UNAVAILABLE, renderPdfPage } from './pdf-page-renderer';
import type { PdfPageRenderer } from './pdf-page-renderer';
import type { ExtractionMethod } from '../../domain/library';

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A page with fewer characters than this has no usable text layer. */
const SCANNED_PAGE_CHARS = 20;

export interface PdfOcrOptions {
  /** Present when OCR is enabled: scanned pages are rendered and recognized. */
  selection: OcrSelection;
  /** Test seam. */
  renderer?: PdfPageRenderer;
  /** Test seam: defaults to probing `@napi-rs/canvas`. */
  canvasAvailable?: () => Promise<boolean>;
}

export interface PdfExtraction {
  sections: ExtractedSection[];
  pageCount: number;
  method: ExtractionMethod;
  warnings: string[];
}

/**
 * One section per page. Pages are processed one at a time, yielding to the event loop in between.
 * When most pages have no text layer and OCR is enabled, up to `maxOcrPdfPages` pages are rendered
 * to PNG and recognized (L5b).
 */
export async function extractPdf(
  bytes: Uint8Array,
  signal?: AbortSignal,
  ocr?: PdfOcrOptions,
): Promise<PdfExtraction> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js may take ownership of the buffer, so hand it a copy.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    if (err instanceof Error && err.name === 'PasswordException')
      throw new ExtractionError('PDF protegido por senha');
    throw new ExtractionError('PDF inválido ou corrompido');
  }
  try {
    const pageTexts: string[] = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      signal?.throwIfAborted();
      const content = await (await pdf.getPage(page)).getTextContent();
      pageTexts.push(
        content.items
          .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
          .join(''),
      );
      await yieldToEventLoop();
    }

    const empty = pageTexts.filter((t) => t.trim().length < SCANNED_PAGE_CHARS).length;
    const scanned = pdf.numPages > 0 && empty * 2 > pdf.numPages;
    const warnings: string[] = [];
    let method: ExtractionMethod = 'text';
    if (scanned && ocr) {
      const done = await ocrScannedPages(pdf, pageTexts, ocr, warnings, signal);
      method = done.method ?? 'text';
    }

    const sections: ExtractedSection[] = [];
    pageTexts.forEach((text, i) => {
      if (text.trim()) sections.push({ text, page: i + 1 });
    });
    return { sections, pageCount: pdf.numPages, method, warnings };
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

/** Replaces the text of scanned pages (in place) with their OCR text. */
async function ocrScannedPages(
  pdf: unknown,
  pageTexts: string[],
  ocr: PdfOcrOptions,
  warnings: string[],
  signal?: AbortSignal,
): Promise<{ method: ExtractionMethod | null }> {
  // With some text already extracted, a missing renderer only costs the scanned pages.
  const unavailable = (): { method: null } => {
    if (pageTexts.some((t) => t.trim())) {
      warnings.push(PDF_OCR_UNAVAILABLE);
      return { method: null };
    }
    throw new ExtractionError(PDF_OCR_UNAVAILABLE);
  };
  if (!(await (ocr.canvasAvailable ?? isCanvasAvailable)())) return unavailable();
  const render = ocr.renderer ?? renderPdfPage;
  const targets = pageTexts
    .map((text, i) => ({ text, page: i + 1 }))
    .filter((p) => p.text.trim().length < SCANNED_PAGE_CHARS);
  const capped = targets.slice(0, LIBRARY_LIMITS.maxOcrPdfPages);
  if (targets.length > capped.length)
    warnings.push(
      `OCR limitado às primeiras ${LIBRARY_LIMITS.maxOcrPdfPages} páginas digitalizadas de ${targets.length}`,
    );

  const methods = new Set<ExtractionMethod>();
  let renderFailures = 0;
  for (const { page } of capped) {
    signal?.throwIfAborted();
    let png: Uint8Array;
    try {
      png = await render(pdf, page);
    } catch (err) {
      signal?.throwIfAborted();
      renderFailures++;
      warnings.push(
        `Não foi possível renderizar a página ${page}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const outcome = await recognizeWithFallback(ocr.selection, png, 'image/png', signal);
    if (outcome.text.trim()) {
      pageTexts[page - 1] = outcome.text;
      methods.add(outcome.method);
    }
    await yieldToEventLoop();
  }
  if (renderFailures === capped.length && capped.length > 0) return unavailable();
  // mixed engines (vision fell back to local on some pages) are reported as local OCR
  const method = methods.size === 0 ? null : methods.size === 1 ? [...methods][0]! : 'ocr-local';
  return { method };
}
