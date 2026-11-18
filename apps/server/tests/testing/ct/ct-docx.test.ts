import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  CtImageMissingError,
  createCtDocument,
} from '../../../src/contexts/testing/domain/ct-document';
import { CtImageFormatError } from '../../../src/contexts/testing/infrastructure/ct/ct-style';
import { renderCtDocx } from '../../../src/contexts/testing/infrastructure/ct/render-ct-docx';
import { SAMPLE_IMAGES, customLayout, makePng, sampleDoc } from './ct-fixtures';

async function open(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const text = async (name: string) => zip.file(name)!.async('string');
  return { zip, text };
}

const plain = (xml: string): string =>
  xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<');

describe('renderCtDocx', () => {
  it('is a valid OOXML package with header, footer and the expected parts', async () => {
    const { zip } = await open(await renderCtDocx(sampleDoc(), SAMPLE_IMAGES));
    const names = Object.keys(zip.files);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('word/document.xml');
    expect(names.filter((n) => /^word\/header\d*\.xml$/.test(n))).toHaveLength(1);
    expect(names.filter((n) => /^word\/footer\d*\.xml$/.test(n))).toHaveLength(1);
  });

  it('writes the sections, header table values and a consistent numbering', async () => {
    const { text } = await open(await renderCtDocx(sampleDoc(), SAMPLE_IMAGES));
    const body = plain(await text('word/document.xml'));
    for (const expected of [
      'DOCUMENTAÇÃO TÉCNICA',
      'Caso de Teste',
      '1. Cabeçalho',
      'Título',
      'Cálculo incorreto da taxa de exemplo',
      'ID/Código do Chamado',
      '900.001',
      'Prioridade',
      'Alta',
      'Sistema / Módulo Afetado',
      'Responsável pela Documentação',
      'Fulana de Tal',
      '2. Descrição da Demanda',
      '2.1. Contexto',
      'inconsistência fictícia',
      '3. Plano de Teste',
      '3.1. Critérios de Aceitação',
      'Caso de Uso 1',
      'Finalizado',
      'Caso de Uso 2 - Cadastro inválido',
      'Pendente',
      'Tela de cadastro com o erro',
      '4. Controle de Versões do Documento',
      'Versão',
      'Descrição da Alteração',
      'Criação do documento',
      'Ajuste dos casos de uso',
    ]) {
      expect(body, expected).toContain(expected);
    }
    // multi-line module keeps both lines (line break inside one cell)
    expect(body).toContain('Financeiro / Empenho\nPatrimonial / Protocolo'.replace('\n', ''));
    expect(await text('word/document.xml')).toContain('<w:br/>');
  });

  it('uses "Análise" when the analysis title is the default', async () => {
    const doc = createCtDocument({ title: 'x' });
    const { text } = await open(await renderCtDocx(doc, new Map()));
    const body = plain(await text('word/document.xml'));
    expect(body).toContain('2. Análise');
    expect(body).toContain('3.1. Critérios de Aceitação');
  });

  it('neutral default: header text, no logo; footer has PAGE and NUMPAGES fields', async () => {
    const { zip, text } = await open(await renderCtDocx(sampleDoc(), SAMPLE_IMAGES));
    const headerName = Object.keys(zip.files).find((n) => /^word\/header\d*\.xml$/.test(n))!;
    const footerName = Object.keys(zip.files).find((n) => /^word\/footer\d*\.xml$/.test(n))!;
    const header = await text(headerName);
    const footer = await text(footerName);
    expect(plain(header)).toContain('Caso de Teste');
    expect(header).not.toContain('<w:drawing>');
    expect(footer).toMatch(/PAGE/);
    expect(footer).toMatch(/NUMPAGES/);
    expect(plain(footer)).toContain('Página');
    expect(plain(header).trim()).toBe('Caso de Teste');
    expect(plain(footer)).not.toContain('·');
  });

  it('a custom model sets colors, font, texts and the logo (left)', async () => {
    const layout = customLayout();
    const { zip, text } = await open(await renderCtDocx(sampleDoc(), SAMPLE_IMAGES, layout));
    const headerName = Object.keys(zip.files).find((n) => /^word\/header\d*\.xml$/.test(n))!;
    const footerName = Object.keys(zip.files).find((n) => /^word\/footer\d*\.xml$/.test(n))!;
    const header = await text(headerName);
    expect(plain(header)).toContain('Acme Corp - Controle de Qualidade');
    expect(header).toContain('<w:drawing>');
    expect(header.indexOf('<w:drawing>')).toBeLessThan(header.indexOf('Acme Corp'));
    expect(plain(await text(footerName))).toContain('Uso restrito da Acme');
    const rels = await text(`word/_rels/${headerName.split('/')[1]}.rels`);
    expect(rels).toMatch(/media\/[^"]+\.png/);
    // 2 screenshots + the logo
    expect(Object.keys(zip.files).filter((n) => n.startsWith('word/media/'))).toHaveLength(3);
    const body = await text('word/document.xml');
    expect(plain(body)).toContain('Relatório de Teste Acme');
    expect(plain(body)).toContain('QUALIDADE');
    expect(body).toContain('w:val="AA1122"');
    expect(body).toContain('w:val="0055CC"');
    expect(body).not.toContain('w:val="4A6FA5"');
    const styles = await text('word/styles.xml');
    expect(styles).toContain('w:ascii="Georgia"');
    expect(styles).not.toContain('w:ascii="Calibri"');
  });

  it('leaves out the header and the footer when the model hides them', async () => {
    const layout = customLayout({ showHeader: false, showFooter: false, kicker: '' });
    const { zip } = await open(await renderCtDocx(sampleDoc(), SAMPLE_IMAGES, layout));
    const names = Object.keys(zip.files);
    expect(names.filter((n) => /^word\/header\d*\.xml$/.test(n))).toHaveLength(0);
    expect(names.filter((n) => /^word\/footer\d*\.xml$/.test(n))).toHaveLength(0);
    // the logo lives in the header: only the 2 screenshots remain
    expect(names.filter((n) => n.startsWith('word/media/'))).toHaveLength(2);
  });

  it('is A4 with 2 cm side margins and Calibri as the document font', async () => {
    const { text } = await open(await renderCtDocx(sampleDoc(), SAMPLE_IMAGES));
    const doc = await text('word/document.xml');
    expect(doc).toContain('w:w="11906"');
    expect(doc).toContain('w:h="16838"');
    expect(doc).toMatch(/w:left="1134"/);
    expect(doc).toMatch(/w:right="1134"/);
    const styles = await text('word/styles.xml');
    expect(styles).toContain('w:ascii="Calibri"');
    expect(styles).toContain('w:val="pt-BR"');
  });

  it('embeds every screenshot, scaled to the content width keeping the aspect ratio', async () => {
    const { zip, text } = await open(await renderCtDocx(sampleDoc(), SAMPLE_IMAGES));
    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/'));
    // 2 screenshots; the neutral default has no logo
    expect(media.length).toBe(2);
    const xml = await text('word/document.xml');
    const extents = [...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map((m) => ({
      cx: Number(m[1]),
      cy: Number(m[2]),
    }));
    expect(extents).toHaveLength(2);
    const EMU_PER_PX = 9525;
    expect(extents[0]!.cx / EMU_PER_PX).toBe(628);
    expect(extents[0]!.cy / extents[0]!.cx).toBeCloseTo(602 / 1534, 2);
    expect(extents[1]!.cx / EMU_PER_PX).toBe(628);
    expect(extents[1]!.cy / extents[1]!.cx).toBeCloseTo(900 / 1200, 2);
    expect(xml).toContain('descr="Tela de cadastro com o erro"');
  });

  it('writes code blocks in the body font, one paragraph per line', async () => {
    const { text } = await open(await renderCtDocx(sampleDoc(), SAMPLE_IMAGES));
    const xml = await text('word/document.xml');
    const paragraphs = xml.match(/<w:p>.*?<\/w:p>|<w:p [^>]*>.*?<\/w:p>/gs) ?? [];
    const mono = paragraphs.filter((p) => p.includes('w:ascii="Calibri"'));
    expect(mono.map(plain).map((s) => s.trim())).toEqual([
      'SELECT *',
      'FROM tabela_exemplo',
      'WHERE codigo = 123 AND valor > 0',
    ]);
  });

  it('shades the label cells and colours the status green italic', async () => {
    const { text } = await open(await renderCtDocx(sampleDoc(), SAMPLE_IMAGES));
    const xml = await text('word/document.xml');
    expect(xml).toContain('w:fill="F2F2F2"');
    expect(xml).toContain('w:val="11734B"');
    expect(xml).toContain('w:val="4A6FA5"');
  });

  it('escapes XML-significant text and does not interpret it', async () => {
    const doc = createCtDocument({
      title: 'A & B <script>',
      useCases: [{ status: 'ok', items: [{ kind: 'text', text: '1 < 2 && "x"' }] }],
    });
    const { text } = await open(await renderCtDocx(doc, new Map()));
    const body = plain(await text('word/document.xml'));
    expect(body).toContain('A & B <script>');
    expect(body).toContain('1 < 2 && "x"');
  });

  it('works without use cases or versions', async () => {
    const doc = createCtDocument({ versions: [] });
    const { text } = await open(await renderCtDocx(doc, new Map()));
    expect(plain(await text('word/document.xml'))).toContain('Versão');
  });

  it('fails clearly on a missing or unsupported image', async () => {
    await expect(renderCtDocx(sampleDoc(), new Map())).rejects.toBeInstanceOf(CtImageMissingError);
    const bad = new Map(SAMPLE_IMAGES);
    bad.set('evid/tela-1.png', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    await expect(renderCtDocx(sampleDoc(), bad)).rejects.toBeInstanceOf(CtImageFormatError);
  });

  it('accepts JPEG bytes (sniffed, not trusted by name)', async () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff,
      0xd9,
    ]);
    const doc = createCtDocument({
      useCases: [{ status: 's', items: [{ kind: 'image', key: 'a.png', width: 10, height: 5 }] }],
    });
    const { zip } = await open(await renderCtDocx(doc, new Map([['a.png', jpeg]])));
    expect(Object.keys(zip.files).some((n) => /^word\/media\/.*\.jpe?g$/.test(n))).toBe(true);
    void makePng;
  });
});
