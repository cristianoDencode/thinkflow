import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { ChromiumBrowser } from '../../../src/contexts/reports/infrastructure/chromium/chromium-browser';
import { ChromiumPdfRenderer } from '../../../src/contexts/reports/infrastructure/chromium/chromium-pdf-renderer';
import { renderCtPdf } from '../../../src/contexts/testing/infrastructure/ct/render-ct-pdf';
import { SAMPLE_IMAGES, sampleDoc } from './ct-fixtures';

// Real Chromium: slow and needs the browser installed, so it is opt-in (RUN_CHROMIUM_TESTS=1).
describe.skipIf(!process.env.RUN_CHROMIUM_TESTS)('CT PDF with real Chromium (smoke)', () => {
  const browser = new ChromiumBrowser();
  const renderer = new ChromiumPdfRenderer(browser);
  afterAll(async () => {
    await browser.close();
  });

  it('prints an A4 PDF of the sample document', async () => {
    const bytes = await renderCtPdf(renderer, sampleDoc(), SAMPLE_IMAGES);
    expect(Buffer.from(bytes.subarray(0, 4)).toString()).toBe('%PDF');
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    const { width, height } = pdf.getPage(0).getSize();
    expect(Math.round(width)).toBe(596);
    expect(Math.round(height)).toBe(843);
  }, 60_000);
});
