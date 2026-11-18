import { renderPageAsImage } from 'unpdf';

export const PDF_OCR_UNAVAILABLE = 'OCR de PDF digitalizado indisponível neste servidor';

/** Renders one PDF page (1-based) to PNG bytes. `pdf` is the pdf.js document proxy. */
export type PdfPageRenderer = (pdf: unknown, page: number) => Promise<Uint8Array>;

let canvasAvailable: Promise<boolean> | null = null;

/** `@napi-rs/canvas` is an optional dependency (prebuilt binary); probe it once. */
export function isCanvasAvailable(): Promise<boolean> {
  canvasAvailable ??= import('@napi-rs/canvas').then(
    () => true,
    () => false,
  );
  return canvasAvailable;
}

/** Default renderer: pdf.js + `@napi-rs/canvas`, 2x scale for legible OCR. */
export const renderPdfPage: PdfPageRenderer = async (pdf, page) => {
  const png = await renderPageAsImage(pdf as Parameters<typeof renderPageAsImage>[0], page, {
    canvasImport: () => import('@napi-rs/canvas'),
    scale: 2,
  });
  return typeof png === 'string' ? new TextEncoder().encode(png) : png;
};
