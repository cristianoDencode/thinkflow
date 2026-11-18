import { describe, expect, it } from 'vitest';
import { ExtractionError } from '../../src/contexts/library/domain/library';
import { CompositeExtractor } from '../../src/contexts/library/infrastructure/extractors/composite-extractor';
import { makeDocx, makePdf, PNG_1X1 } from './library-fixtures';

const extractor = new CompositeExtractor();
const run = (kind: 'pdf' | 'docx' | 'markdown' | 'text' | 'image', bytes: Uint8Array) =>
  extractor.extract({ bytes, kind, name: `x.${kind}` }, {});

describe('extractors', () => {
  it('extracts one section per PDF page', async () => {
    const pdf = await makePdf(['Capa do manual', 'Prazo de aprovação: 5 dias', '']);
    const out = await run('pdf', pdf);
    expect(out.pageCount).toBe(3);
    expect(out.method).toBe('text');
    expect(out.sections.map((s) => s.page)).toEqual([1, 2]);
    expect(out.sections[1]!.text).toContain('Prazo de aprovação: 5 dias');
  });

  it('rejects corrupt PDFs with a friendly message', async () => {
    await expect(run('pdf', new TextEncoder().encode('%PDF-1.4 lixo'))).rejects.toBeInstanceOf(
      ExtractionError,
    );
  });

  it('extracts DOCX paragraphs', async () => {
    const out = await run('docx', await makeDocx(['Primeiro parágrafo', 'Segundo parágrafo']));
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0]!.text).toContain('Primeiro parágrafo');
    expect(out.sections[0]!.text).toContain('Segundo parágrafo');
    expect(out.sections[0]!.text).toMatch(/Primeiro parágrafo\s+Segundo/);
  });

  it('rejects an invalid DOCX', async () => {
    await expect(run('docx', new TextEncoder().encode('PK not really'))).rejects.toThrow(
      /DOCX inválido/,
    );
  });

  it('decodes UTF-8 text and strips the BOM', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Título\nação')]);
    const out = await run('markdown', bytes);
    expect(out.sections[0]!.text).toBe('# Título\nação');
    expect(out.pageCount).toBeNull();
  });

  it('fails images when OCR is off, and recognizes them when an engine is provided', async () => {
    await expect(run('image', PNG_1X1)).rejects.toThrow(/OCR desativado/);
    const withOcr = new CompositeExtractor({
      ocr: () => ({ method: 'ocr-local', recognize: async () => 'Texto da imagem' }),
    });
    const out = await withOcr.extract({ bytes: PNG_1X1, kind: 'image', name: 'a.png' }, {});
    expect(out.method).toBe('ocr-local');
    expect(out.sections[0]!.text).toBe('Texto da imagem');
  });
});
