import { DEFAULT_CT_LAYOUT, type CtLayout } from '@thinkflow/shared';
import type { PdfOptions, PdfRenderer } from '../../../reports/domain/render-ports';
import { CtImageMissingError, ctMissingImageKeys, type CtDocument } from '../../domain/ct-document';
import { ctLogoOf } from './ct-logo';
import { CT_FONT_SIZES, ctFontStack, ctPalette } from './ct-style';
import { ctImageDataUri, escapeHtml, renderCtHtml } from './render-ct-html';

/*
 * PDF of the "Caso de Teste CT" through the existing Chromium `PdfRenderer` (reports context),
 * so there is a single browser manager. `ChromiumPdfRenderer.pdf` prints with fixed margins
 * (18 mm top, 16 mm sides/bottom), JavaScript off and no network: the body therefore carries
 * its images as data URIs and a small side padding brings the content to the template's 17 cm,
 * while the logo / texts / "Página X de Y" go into Chromium's header and footer templates.
 */

/** Side margin of the template (20 mm); the renderer's own margin is 16 mm. */
const SIDE = '20mm';

/**
 * Chromium header / footer templates (inline styles only; `pageNumber` / `totalPages` classes).
 * Each is empty when the model turns it off (an empty template also removes Chromium's default).
 */
export function ctPdfTemplates(
  layout: CtLayout = DEFAULT_CT_LAYOUT,
): Pick<PdfOptions, 'headerTemplate' | 'footerTemplate'> {
  const c = ctPalette(layout);
  const base = `-webkit-print-color-adjust:exact;font-family:${ctFontStack(layout.fontFamily)};width:100%;margin:0;padding:0 ${SIDE}`;
  const logo = ctLogoOf(layout);
  const text = layout.headerText ? `<span>${escapeHtml(layout.headerText)}</span>` : '';
  const img = logo
    ? `<img src="${escapeHtml(logo.dataUri)}" style="height:20.52pt;width:auto;max-width:180px" alt="">`
    : '';
  const headerTemplate =
    layout.showHeader && (text || img)
      ? [
          `<div style="${base};font-size:${CT_FONT_SIZES.header}pt;color:#${c.gray}">`,
          `<div style="display:flex;${layout.logoPosition === 'left' ? 'flex-direction:row-reverse;' : ''}justify-content:${text ? 'space-between' : layout.logoPosition === 'left' ? 'flex-start' : 'flex-end'};align-items:flex-end;gap:12pt;margin-top:6pt;padding-bottom:4.2pt;border-bottom:1px solid #${c.rule}">`,
          text,
          img,
          '</div>',
          '</div>',
        ].join('')
      : '<span></span>';
  const footerLine = [
    layout.footerText
      ? `${escapeHtml(layout.footerText)}&nbsp;&nbsp;&nbsp;·&nbsp;&nbsp;&nbsp;`
      : '',
    'Página <span class="pageNumber"></span> de <span class="totalPages"></span>',
  ].join('');
  const footerTemplate = layout.showFooter
    ? [
        `<div style="${base};font-size:${CT_FONT_SIZES.footer}pt;color:#${c.gray};text-align:center">`,
        `<div style="border-top:1px solid #${c.rule};padding-top:3pt;margin-bottom:18pt">`,
        footerLine,
        '</div>',
        '</div>',
      ].join('')
    : '<span></span>';
  return { headerTemplate, footerTemplate };
}

/** The print HTML: images inlined as data URIs (throws `CtImageMissingError` / `CtImageFormatError`). */
export function ctPrintHtml(
  doc: CtDocument,
  images: Map<string, Uint8Array>,
  layout: CtLayout = DEFAULT_CT_LAYOUT,
): string {
  const missing = ctMissingImageKeys(doc, (key) => images.has(key));
  if (missing.length > 0) throw new CtImageMissingError(missing);
  const cache = new Map<string, string>();
  return renderCtHtml(
    doc,
    (key) => {
      let uri = cache.get(key);
      if (uri === undefined) {
        uri = ctImageDataUri(images.get(key)!, key);
        cache.set(key, uri);
      }
      return uri;
    },
    { forPdf: true, layout },
  );
}

/** Prints the document to PDF with an injected `PdfRenderer` (e.g. `ChromiumPdfRenderer`). */
export async function renderCtPdf(
  renderer: Pick<PdfRenderer, 'pdf'>,
  doc: CtDocument,
  images: Map<string, Uint8Array>,
  layout: CtLayout = DEFAULT_CT_LAYOUT,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return renderer.pdf(
    ctPrintHtml(doc, images, layout),
    { ...ctPdfTemplates(layout), pageSize: 'A4' },
    signal,
  );
}
