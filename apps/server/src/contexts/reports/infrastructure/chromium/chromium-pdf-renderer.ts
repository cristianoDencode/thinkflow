import type { PdfOptions, PdfRenderer, RendererStatus } from '../../domain/render-ports';
import type { ChromiumBrowser } from './chromium-browser';

const PDF_TIMEOUT_MS = 60_000;

/**
 * Prints the report HTML with Chromium: JavaScript off, no network, `setContent` only (never a
 * file:// or http URL), so nothing outside the document can be read or fetched.
 */
export class ChromiumPdfRenderer implements PdfRenderer {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly browser: ChromiumBrowser) {}

  status(): Promise<RendererStatus> {
    return this.browser.status();
  }

  pdf(html: string, options: PdfOptions): Promise<Uint8Array> {
    // one print at a time: keeps memory low on small servers
    const run = this.chain.then(() => this.print(html, options));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private print(html: string, options: PdfOptions): Promise<Uint8Array> {
    return this.browser.use(async (browser) => {
      const context = await this.browser.newIsolatedContext(browser, { javaScriptEnabled: false });
      let timer: NodeJS.Timeout | undefined;
      try {
        const work = (async () => {
          const page = await context.newPage();
          await page.setContent(html, { waitUntil: 'load', timeout: PDF_TIMEOUT_MS });
          return await page.pdf({
            format: options.pageSize,
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: options.headerTemplate,
            footerTemplate: options.footerTemplate,
            margin: { top: '18mm', bottom: '16mm', left: '16mm', right: '16mm' },
            outline: true,
            tagged: true,
          });
        })();
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Tempo esgotado ao gerar o PDF.')),
            PDF_TIMEOUT_MS,
          );
        });
        const buffer = await Promise.race([work, timeout]);
        return new Uint8Array(buffer);
      } finally {
        if (timer) clearTimeout(timer);
        await context.close().catch(() => undefined);
      }
    });
  }
}
