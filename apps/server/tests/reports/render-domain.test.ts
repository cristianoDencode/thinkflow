import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { templateLayoutSchema, templateSpecSchema } from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assembleBodyMarkdown,
  assembleMarkdown,
  buildToc,
  buildTocHtml,
  escapeHtml,
  headingIds,
  pdfTemplates,
  renderDocumentHtml,
  type AssemblyInput,
} from '../../src/contexts/reports/domain/assembly';
import { mapMermaidFences, mermaidCodes } from '../../src/contexts/reports/domain/mermaid-blocks';
import {
  assemblePrototype,
  buildScreenPlanMessages,
  extractScreen,
  fallbackScreens,
  parseScreenPlan,
  screenSlugs,
} from '../../src/contexts/reports/domain/prototype';
import { emptyMeta, type ReportSection } from '../../src/contexts/reports/domain/report';
import {
  CONTENT_SECURITY_POLICY,
  documentCss,
  prototypeCss,
  safeColor,
} from '../../src/contexts/reports/domain/themes';
import { DiskLegacyPdfSource } from '../../src/contexts/reports/infrastructure/legacy-pdf-source';
import { UnavailableRenderer } from '../../src/contexts/reports/infrastructure/unavailable-renderer';

const layout = (over: object = {}) => templateLayoutSchema.parse(over);

const section = (n: number, title: string, over: Partial<ReportSection> = {}): ReportSection => ({
  reportId: 'r',
  ordinal: n,
  title,
  requirements: '',
  role: 'section',
  status: 'done',
  markdown: `Texto ${n}.`,
  html: null,
  noteIds: [],
  model: null,
  providerId: null,
  warnings: [],
  error: null,
  updatedAt: 0,
  ...over,
});

const input: AssemblyInput = {
  title: 'Guia',
  templateName: 'Modelo',
  variables: {},
  meta: emptyMeta(),
  generatedAt: Date.UTC(2026, 10, 11, 12, 0),
};

describe('themes', () => {
  it('builds CSS for every theme with the template colors and print rules', () => {
    for (const theme of ['thinkflow', 'sobrio', 'compacto'] as const) {
      const css = documentCss(layout({ theme, primaryColor: '#112233', accentColor: '#445566' }));
      expect(css, theme).toContain('#112233');
      expect(css).toContain('@page{size:A4}');
      expect(css).toContain('thead{display:table-header-group}');
      expect(css).toContain('tr{break-inside:avoid}');
      expect(css).toContain('break-after:page');
      expect(css).not.toMatch(/url\(|@import/);
    }
    expect(documentCss(layout({ pageSize: 'Letter' }))).toContain('size:Letter');
  });

  it('adds a page break before each section only when the template asks for it', () => {
    expect(documentCss(layout())).not.toContain('break-before:page');
    expect(documentCss(layout({ sectionPageBreak: true }))).toContain(
      '.content > h2{break-before:page}',
    );
  });

  it('never lets a bad color reach the CSS', () => {
    expect(safeColor('red;}body{display:none', '#6d28d9')).toBe('#6d28d9');
    const css = documentCss({ ...layout(), primaryColor: 'red;}</style><script>' });
    expect(css).not.toContain('<script');
    expect(css).not.toContain('red;}');
  });

  it('makes the prototype navigation CSS-only', () => {
    const css = prototypeCss(layout());
    expect(css).toContain('.tf-screen{display:none}');
    expect(css).toContain('.tf-screen:target{display:block}');
    expect(css).toContain(':not(:has(:target))');
  });
});

describe('document HTML', () => {
  const sections = [section(1, 'Resumo'), section(2, 'Fluxo & dados')];

  it('numbers the TOC with anchors that match the heading ids', () => {
    const toc = buildToc(sections);
    expect(toc.map((e) => e.anchor)).toEqual(['sec-1-resumo', 'sec-2-fluxo-dados']);
    const ids = headingIds(sections);
    expect(ids['1. Resumo']).toBe('sec-1-resumo');
    expect(ids['2. Fluxo & dados']).toBe('sec-2-fluxo-dados');
    expect(ids['Sobre este documento']).toBe('sobre-este-documento');
    const html = buildTocHtml(toc);
    expect(html).toContain('href="#sec-2-fluxo-dados"');
    expect(html).toContain('Fluxo &amp; dados');
    expect(html).toContain('href="#sobre-este-documento"');
  });

  it('builds a self-contained page: CSP, no script, escaped strings, cover with the logo', () => {
    const logo = 'data:image/png;base64,iVBORw0KGgo=';
    const html = renderDocumentHtml({
      title: '<script>alert(1)</script> "x"',
      metaLine: 'Modelo <b> · hoje',
      subtitle: 'Sub <i>',
      layout: layout({ logo }),
      tocHtml: buildTocHtml(buildToc(sections)),
      bodyHtml: '<h2>1. Resumo</h2>',
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(`content="${CONTENT_SECURITY_POLICY}"`);
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &quot;x&quot;');
    expect(html).toContain('Modelo &lt;b&gt; · hoje');
    expect(html).toContain('Sub &lt;i&gt;');
    expect(html).toContain(`<img class="logo" alt="" src="${logo}">`);
    expect(html).toContain('<header class="cover">');
    expect(html).toContain('<nav class="toc"');
  });

  it('drops the cover, the TOC or an unsafe logo as configured', () => {
    const html = renderDocumentHtml({
      title: 'T',
      metaLine: 'm',
      subtitle: '',
      layout: { ...layout({ cover: false, toc: false }), logo: 'https://evil.test/logo.png' },
      tocHtml: '<nav class="toc"></nav>',
      bodyHtml: '',
    });
    expect(html).toContain('class="doc-head"');
    expect(html).not.toContain('class="cover"');
    expect(html).not.toContain('class="toc"');
    expect(html).not.toContain('evil.test');
  });

  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('keeps the title out of the body used for the HTML', () => {
    const md = assembleMarkdown(input, sections);
    const body = assembleBodyMarkdown(input, sections);
    expect(md.startsWith('# Guia')).toBe(true);
    expect(body.startsWith('## 1. Resumo')).toBe(true);
    expect(md.endsWith(`${body}\n`)).toBe(true);
  });

  it('describes the diagram outcome in the appendix', () => {
    const body = assembleBodyMarkdown(
      {
        ...input,
        meta: {
          ...emptyMeta(),
          diagrams: { total: 4, rendered: 1, repaired: 1, failed: 1, unvalidated: 2 },
        },
      },
      sections,
    );
    expect(body).toContain(
      'Diagramas: 4 no total, 1 corrigido automaticamente, 2 sem validação de sintaxe, 1 com erro de sintaxe',
    );
  });

  it('adds the prototype screens to the Markdown export', () => {
    const md = assembleMarkdown(input, [
      ...sections,
      section(3, 'Lista', { role: 'screen', markdown: 'Tela de lista.', html: '<div></div>' }),
      section(4, 'Falhou', { role: 'screen', status: 'error', markdown: '' }),
    ]);
    expect(md).toContain('## Telas do protótipo\n\n### Lista\n\nTela de lista.');
    expect(md).not.toContain('Falhou');
    expect(buildToc([...sections, section(3, 'Lista', { role: 'screen' })])).toHaveLength(2);
  });

  it('escapes the PDF header and footer and only embeds PNG/JPEG data logos', () => {
    const t = pdfTemplates(layout({ logo: 'data:image/jpeg;base64,/9j/4AAQ' }), 'Título <x>', {
      header: '',
      footer: 'Rodapé "a" & b',
    });
    expect(t.headerTemplate).toContain('Título &lt;x&gt;');
    expect(t.headerTemplate).toContain('<img src="data:image/jpeg;base64,/9j/4AAQ"');
    expect(t.footerTemplate).toContain('Rodapé &quot;a&quot; &amp; b');
    expect(t.footerTemplate).toContain(
      '<span class="pageNumber"></span>/<span class="totalPages"></span>',
    );
    const bad = pdfTemplates({ ...layout(), logo: 'http://evil.test/l.png' }, 'T', {
      header: 'H',
      footer: '',
    });
    expect(bad.headerTemplate).not.toContain('evil.test');
  });
});

describe('mermaid blocks', () => {
  const md = [
    'Antes',
    '```mermaid',
    'flowchart TD',
    '  A --> B',
    '```',
    '',
    '```python',
    '```mermaid',
    'not a diagram',
    '```',
    '',
    '- item',
    '  ```mermaid',
    '  sequenceDiagram',
    '    A->>B: oi',
    '  ```',
    '~~~mermaid',
    'pie',
    '  "a": 1',
    '~~~',
  ].join('\n');

  it('lists the diagrams (indented and tilde fences included) and skips other languages', () => {
    expect(mermaidCodes(md)).toEqual([
      'flowchart TD\n  A --> B',
      'sequenceDiagram\n  A->>B: oi',
      'pie\n  "a": 1',
    ]);
  });

  it('rewrites a diagram keeping its indentation, leaving everything else alone', () => {
    const out = mapMermaidFences(md, (code) =>
      code.startsWith('sequenceDiagram') ? 'sequenceDiagram\n  X->>Y: ola' : null,
    ).markdown;
    expect(out).toContain('  sequenceDiagram\n    X->>Y: ola\n  ```');
    expect(out).toContain('flowchart TD\n  A --> B');
    expect(out).toContain('```python\n```mermaid\nnot a diagram\n```');
  });

  it('ignores an unterminated fence', () => {
    expect(mermaidCodes('```mermaid\nflowchart TD\n A --> B')).toEqual([]);
  });
});

describe('prototype helpers', () => {
  it('builds unique slugs', () => {
    expect(screenSlugs(['Lista de débitos', 'Lista de débitos', 'Detalhe!'])).toEqual([
      'lista-de-debitos',
      'lista-de-debitos-2',
      'detalhe',
    ]);
  });

  it('parses the screen plan and caps it at 8 screens', () => {
    const titles = Array.from({ length: 12 }, (_, i) => ({ titulo: `T${i}`, objetivo: 'o' }));
    const parsed = parseScreenPlan(JSON.stringify({ telas: titles }));
    expect(parsed.ok && parsed.screens).toHaveLength(8);
    expect(parseScreenPlan('nada')).toEqual({ ok: false, error: 'JSON inválido' });
    expect(parseScreenPlan('{"telas":[]}').ok).toBe(false);
  });

  it('falls back to the telas variable, else "Tela inicial"', () => {
    expect(
      fallbackScreens({ telas: 'Listagem, detalhe;\n- Formulário' }).map((s) => s.title),
    ).toEqual(['Listagem', 'detalhe', 'Formulário']);
    expect(fallbackScreens({})).toEqual([{ title: 'Tela inicial', objective: '' }]);
  });

  it('extracts the description and the html fragment of a screen answer', () => {
    expect(extractScreen('Descrição.\n```html\n<div>a</div>\n```\nFim')).toEqual({
      description: 'Descrição.\n\nFim',
      html: '<div>a</div>',
    });
    expect(extractScreen('Sem bloco')).toBeNull();
    expect(extractScreen('<div class="tf-card">x</div>')).toMatchObject({
      html: '<div class="tf-card">x</div>',
    });
  });

  it('keeps variables out of the system prompt of the plan', () => {
    const messages = buildScreenPlanMessages(templateSpec(), { produto: 'Painel' }, [
      'Visão geral',
    ]);
    expect(messages[0]!.role).toBe('system');
    expect(String(messages[1]!.content)).toContain('produto: Painel');
    expect(String(messages[1]!.content)).toContain('"telas"');
  });

  it('assembles one page with a nav, a section per screen and the specification', () => {
    const html = assemblePrototype({
      title: 'Painel <x>',
      metaLine: 'm',
      layout: layout(),
      specHtml: '<h2>Visão</h2>',
      screens: [
        { slug: 'lista', title: 'Lista', html: '<div class="tf-card">a</div>' },
        { slug: 'detalhe', title: 'Detalhe', html: '<div>b</div>' },
      ],
    });
    expect(html).toContain('<a href="#tela-lista">Lista</a>');
    expect(html).toContain('<section id="tela-detalhe" class="tf-screen">');
    expect(html).toContain('<section id="tela-especificacao" class="tf-screen">');
    expect(html.indexOf('tela-lista"')).toBeLessThan(html.indexOf('tela-especificacao"'));
    expect(html).toContain('Painel &lt;x&gt;');
    expect(html).not.toContain('<script');
    expect(html).toContain(`content="${CONTENT_SECURITY_POLICY}"`);
  });
});

function templateSpec() {
  return templateSpecSchema.parse({
    objective: 'Prototipar {{produto}}',
    sections: [{ id: 'a', title: 'Visão geral' }],
    variables: [{ name: 'produto', label: 'Produto' }],
  });
}

describe('DiskLegacyPdfSource', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const source = () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-rep-')), 'reports');
    dirs.push(path.dirname(dir));
    fs.mkdirSync(dir, { recursive: true });
    return { dir, source: new DiskLegacyPdfSource(dir) };
  };

  it('reads and deletes `<id>.pdf`, and a missing file is null', async () => {
    const { dir, source: s } = source();
    expect(await s.read('abc-1')).toBeNull();
    fs.writeFileSync(path.join(dir, 'abc-1.pdf'), new Uint8Array([1, 2, 3]));
    expect([...(await s.read('abc-1'))!]).toEqual([1, 2, 3]);
    await s.delete('abc-1');
    await s.delete('abc-1'); // no error when it is already gone
    expect(await s.read('abc-1')).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses ids that could leave the directory', async () => {
    const { source: s } = source();
    for (const id of ['../x', 'a/b', '', 'a.b', 'a\\b'])
      await expect(s.read(id), id).rejects.toThrow('invalid report id');
  });
});

describe('UnavailableRenderer', () => {
  it('reports the reason and never renders', async () => {
    const r = new UnavailableRenderer('sem chromium');
    expect(await r.status()).toEqual({
      available: false,
      reason: 'sem chromium',
      executablePath: null,
    });
    expect(await r.render()).toEqual({ ok: false, error: 'sem chromium', unavailable: true });
    await expect(r.pdf()).rejects.toThrow('sem chromium');
  });
});
