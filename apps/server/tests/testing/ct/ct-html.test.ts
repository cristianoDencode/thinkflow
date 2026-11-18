import { DEFAULT_CT_LAYOUT } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import { createCtDocument } from '../../../src/contexts/testing/domain/ct-document';
import { CtImageFormatError } from '../../../src/contexts/testing/infrastructure/ct/ct-style';
import {
  ctImageDataUri,
  renderCtHtml,
  safeImageUrl,
} from '../../../src/contexts/testing/infrastructure/ct/render-ct-html';
import {
  ctPdfTemplates,
  ctPrintHtml,
  renderCtPdf,
} from '../../../src/contexts/testing/infrastructure/ct/render-ct-pdf';
import { SAMPLE_IMAGES, customLayout, sampleDoc } from './ct-fixtures';

const url = (key: string): string => `/api/img/${encodeURIComponent(key)}`;

describe('renderCtHtml (preview)', () => {
  const html = renderCtHtml(sampleDoc(), url);

  it('is a standalone pt-BR page with the template structure in order', () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain('font-size:10.5pt');
    expect(html).toMatch(/Calibri, Carlito/);
    const order = [
      'Caso de Teste</span>',
      'DOCUMENTAÇÃO TÉCNICA',
      '<h1 class="title">Caso de Teste</h1>',
      '1.</span> Cabeçalho',
      'Cálculo incorreto da taxa de exemplo',
      '2.</span> Descrição da Demanda',
      '2.1. Contexto',
      '3.</span> Plano de Teste',
      '3.1. Critérios de Aceitação',
      'Caso de Uso 1',
      'Caso de Uso 2 - Cadastro inválido',
      '4.</span> Controle de Versões do Documento',
      'Página X de Y',
    ];
    let at = -1;
    for (const part of order) {
      const next = html.indexOf(part, at + 1);
      expect(next, part).toBeGreaterThan(at);
      at = next;
    }
  });

  it('is client-neutral: no logo, no branding strings', () => {
    expect(html).not.toContain('alt="Logotipo"');
    expect(html).not.toContain('data:image/png;base64,iVBOR');
    expect(html).toContain('<div class="pghead"><span>Caso de Teste</span></div>');
    expect(html).toContain('<div class="pgfoot">Página X de Y</div>');
    expect(html).toContain('#4A6FA5');
  });

  it('renders the header table with a line break in the module and the use case parts', () => {
    expect(html).toContain('Financeiro / Empenho<br>Patrimonial / Protocolo');
    expect(html).toContain('<td class="l">ID/Código do Chamado</td>');
    expect(html).toContain('class="uc-status">Finalizado<');
    expect(html).toContain('src="/api/img/evid%2Ftela-1.png"');
    expect(html).not.toContain('Consolas');
    expect(html).toMatch(/font-family:Calibri[^;]*;font-size:9\.5pt[^"]*white-space:pre-wrap/);
    expect(html).toContain('FROM tabela_exemplo');
    expect(html).toContain('Tela de cadastro com o erro');
    expect(html).toContain('<td class="c">1.1</td>');
  });

  it('uses the analysis title default and escapes every text', () => {
    const doc = createCtDocument({
      title: '<img src=x onerror=alert(1)>',
      context: '<b>negrito</b> & "aspas"',
      useCases: [{ status: '<i>', items: [{ kind: 'text', text: '<script>1</script>' }] }],
    });
    const out = renderCtHtml(doc, url);
    expect(out).toContain('2.</span> Análise');
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('<script>1');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('&lt;b&gt;negrito&lt;/b&gt; &amp; &quot;aspas&quot;');
  });

  it('sanitises image URLs', () => {
    expect(safeImageUrl('javascript:alert(1)')).toBe('');
    expect(safeImageUrl('data:text/html;base64,AAAA')).toBe('');
    expect(safeImageUrl('//evil.example/x.png')).toBe('');
    expect(safeImageUrl('https://x.test/a.png')).toBe('https://x.test/a.png');
    expect(safeImageUrl('/api/a.png')).toBe('/api/a.png');
    const out = renderCtHtml(sampleDoc(), () => 'javascript:alert(1)');
    expect(out).not.toContain('javascript:');
  });
});

describe('custom layout (model)', () => {
  const layout = customLayout();

  it('preview uses the model colors, font, texts and logo', () => {
    const html = renderCtHtml(sampleDoc(), url, { layout });
    expect(html).toContain('<h1 class="title">Relatório de Teste Acme</h1>');
    expect(html).toContain('QUALIDADE');
    expect(html).toContain('Acme Corp - Controle de Qualidade');
    expect(html).toContain('Uso restrito da Acme');
    expect(html).toContain('#AA1122');
    expect(html).toContain('#0055CC');
    expect(html).toContain("font-family:Georgia, 'DejaVu Serif'");
    expect(html).not.toContain('Carlito');
    expect(html).toContain('class="pghead logo-left"');
    expect(html).toContain(`src="${layout.logo}"`);
    expect(html).not.toContain('#4A6FA5');
  });

  it('hides the header / footer / kicker when the model says so', () => {
    const html = renderCtHtml(sampleDoc(), url, {
      layout: customLayout({ showHeader: false, showFooter: false, kicker: '' }),
    });
    expect(html).not.toContain('class="pghead');
    expect(html).not.toContain('class="pgfoot"');
    expect(html).not.toContain('class="kicker"');
  });

  it('the clipboard fragment follows the font and status color', () => {
    const html = renderCtHtml(sampleDoc(), (k) => ctImageDataUri(SAMPLE_IMAGES.get(k)!, k), {
      clipboardSection: 'plano',
      layout,
    });
    expect(html).toContain('Georgia');
    expect(html).toContain('color:#0055CC');
  });

  it('the PDF templates carry the model texts, logo (left) and colors', () => {
    const { headerTemplate, footerTemplate } = ctPdfTemplates(layout);
    expect(headerTemplate).toContain('Acme Corp - Controle de Qualidade');
    expect(headerTemplate).toContain(`src="${layout.logo}"`);
    expect(headerTemplate).toContain('flex-direction:row-reverse');
    expect(footerTemplate).toContain('Uso restrito da Acme');
    expect(footerTemplate).toContain('class="pageNumber"');
    expect(headerTemplate).toContain('Georgia');
    const off = ctPdfTemplates(customLayout({ showHeader: false, showFooter: false }));
    expect(off.headerTemplate).not.toContain('Acme');
    expect(off.footerTemplate).not.toContain('pageNumber');
  });

  it('the print HTML uses the model look and no simulated header', () => {
    const html = ctPrintHtml(sampleDoc(), SAMPLE_IMAGES, layout);
    expect(html).toContain('Relatório de Teste Acme');
    expect(html).toContain('#AA1122');
    expect(html).not.toContain('class="pghead');
  });

  it('renderCtPdf passes the model templates to the PdfRenderer', async () => {
    let header = '';
    await renderCtPdf(
      {
        async pdf(_html, options) {
          header = options.headerTemplate;
          return new Uint8Array();
        },
      },
      sampleDoc(),
      SAMPLE_IMAGES,
      layout,
    );
    expect(header).toContain('Acme Corp');
  });

  it('DEFAULT_CT_LAYOUT is neutral', () => {
    expect(DEFAULT_CT_LAYOUT.logo).toBeNull();
    expect(DEFAULT_CT_LAYOUT.headerText).toBe('Caso de Teste');
    expect(DEFAULT_CT_LAYOUT.footerText).toBe('');
  });
});

describe('renderCtHtml (forPdf)', () => {
  it('omits the simulated header / footer and locks the CSP to data: images', () => {
    const html = ctPrintHtml(sampleDoc(), SAMPLE_IMAGES);
    expect(html).not.toContain('class="pghead"');
    expect(html).not.toContain('class="pgfoot"');
    expect(html).toContain('img-src data:');
    expect(html).toContain('DOCUMENTAÇÃO TÉCNICA');
    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(2);
    expect(html).toContain('<body class="pdf">');
  });

  it('the page templates carry the logo, the texts and Chromium page-number fields', () => {
    const { headerTemplate, footerTemplate } = ctPdfTemplates();
    expect(headerTemplate).toContain('Caso de Teste');
    expect(headerTemplate).not.toContain('<img');
    expect(footerTemplate).toContain('class="pageNumber"');
    expect(footerTemplate).toContain('class="totalPages"');
    expect(footerTemplate).not.toContain('·');
  });

  it('renderCtPdf hands the print HTML and templates to the injected PdfRenderer', async () => {
    const calls: { html: string; options: { pageSize: string; headerTemplate: string } }[] = [];
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const out = await renderCtPdf(
      {
        async pdf(html, options) {
          calls.push({ html, options });
          return bytes;
        },
      },
      sampleDoc(),
      SAMPLE_IMAGES,
    );
    expect(out).toBe(bytes);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.pageSize).toBe('A4');
    expect(calls[0]!.options.headerTemplate).toContain('Caso de Teste');
    expect(calls[0]!.html).toContain('Caso de Uso 2');
  });

  it('rejects a missing image before printing', async () => {
    await expect(
      renderCtPdf({ pdf: async () => new Uint8Array() }, sampleDoc(), new Map()),
    ).rejects.toThrow(/Imagem não encontrada/);
  });

  it('ctImageDataUri sniffs the type and refuses unknown bytes', () => {
    expect(ctImageDataUri(SAMPLE_IMAGES.get('evid/tela-1.png')!)).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(() => ctImageDataUri(new Uint8Array([1, 2, 3]), 'k')).toThrow(CtImageFormatError);
  });
});

describe('renderCtHtml (clipboard "plano")', () => {
  const dataUrl = (key: string): string => ctImageDataUri(SAMPLE_IMAGES.get(key)!, key);
  const html = renderCtHtml(sampleDoc(), dataUrl, { clipboardSection: 'plano' });

  it('contains only the Caso de Uso blocks, not the header sections', () => {
    for (const absent of [
      'DOCUMENTAÇÃO TÉCNICA',
      'Cabeçalho',
      'Título',
      'ID/Código do Chamado',
      'Descrição da Demanda',
      'Contexto',
      'Plano de Teste',
      'Critérios de Aceitação',
      'Controle de Versões',
      'Página X de Y',
      '<html',
      '<body',
    ]) {
      expect(html, absent).not.toContain(absent);
    }
    expect(html).toContain('Caso de Uso 1');
    expect(html).toContain('Caso de Uso 2 - Cadastro inválido');
    expect(html).toContain('Finalizado');
    expect(html.match(/<table /g)).toHaveLength(2);
  });

  it('is paste friendly: inline styles only, no classes or style tags, data-URI images with pixel sizes', () => {
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\sclass=/);
    expect(html).not.toMatch(/<script/);
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toMatch(
      /<img src="data:image\/png;base64,[^"]+" alt="[^"]*" width="628" height="246"/,
    );
    expect(html).toContain('background-color:#F2F2F2');
    // tables are separated by a paragraph so Word does not merge them
    expect(html).toMatch(/<\/table><p [^>]*>&nbsp;<\/p><table/);
  });

  it('keeps blank lines as empty paragraphs and escapes text', () => {
    const doc = createCtDocument({
      useCases: [{ status: 'x', items: [{ kind: 'text', text: 'a < b\n\nc' }] }],
    });
    const out = renderCtHtml(doc, dataUrl, { clipboardSection: 'plano' });
    expect(out).toContain('a &lt; b');
    expect(out).toMatch(/&nbsp;<\/p>/);
  });

  it('is empty-safe without use cases', () => {
    const out = renderCtHtml(createCtDocument(), dataUrl, { clipboardSection: 'plano' });
    expect(out).not.toContain('<table');
  });
});
