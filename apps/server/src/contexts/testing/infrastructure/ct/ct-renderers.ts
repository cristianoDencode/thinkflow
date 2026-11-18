import type { PdfRenderer } from '../../../reports/domain/render-ports';
import type { CtRenderers } from '../../application/ct-document-service';
import { ctMissingImageKeys, CtImageMissingError } from '../../domain/ct-document';
import { ctFileStem } from './ct-style';
import { renderCtDocx } from './render-ct-docx';
import { ctImageDataUri, renderCtHtml } from './render-ct-html';
import { renderCtPdf } from './render-ct-pdf';

/** The CT renderers wired to the app's Chromium `PdfRenderer`. */
export function createCtRenderers(pdf: Pick<PdfRenderer, 'pdf'>): CtRenderers {
  return {
    docx: (doc, images, layout) => renderCtDocx(doc, images, layout),
    pdf: (doc, images, layout, signal) => renderCtPdf(pdf, doc, images, layout, signal),
    previewHtml: (doc, imageUrl, layout) => renderCtHtml(doc, imageUrl, { layout }),
    clipboardHtml: (doc, images, layout) => {
      const missing = ctMissingImageKeys(doc, (key) => images.has(key));
      if (missing.length > 0) throw new CtImageMissingError(missing);
      return renderCtHtml(doc, (key) => ctImageDataUri(images.get(key)!, key), {
        clipboardSection: 'plano',
        layout,
      });
    },
    fileStem: ctFileStem,
  };
}
