import { describe, expect, it } from 'vitest';
import { hashDiagram } from '@thinkflow/shared';
import { RemarkHtmlRenderer } from '../../src/contexts/reports/infrastructure/markdown/remark-html-renderer';

const r = new RemarkHtmlRenderer();
const FLOW = 'flowchart TD\n  A --> B';
const fence = (code: string) => `\`\`\`mermaid\n${code}\n\`\`\``;

describe('RemarkHtmlRenderer.render', () => {
  it('renders GFM: tables, task lists, strikethrough, code', () => {
    const html = r.render(
      '| a | b |\n|---|:-:|\n| 1 | 2 |\n\n- [x] feito\n\n~~riscado~~ e `código`\n\n```sql\nselect 1;\n```',
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<del>riscado</del>');
    expect(html).toContain('<code>código</code>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('class="language-sql"');
  });

  it('never honours raw HTML from the Markdown', () => {
    const html = r.render(
      'Oi <script>alert(1)</script> <img src=x onerror=alert(1)> <iframe src="http://x"></iframe>\n\n<div onclick="x()">bloco</div>\n\n<style>body{}</style>',
    );
    for (const bad of ['<script', 'onerror', 'onclick', '<iframe', '<style', '<div']) {
      expect(html, bad).not.toContain(bad);
    }
  });

  it('drops dangerous link protocols and remote images', () => {
    const html = r.render(
      '[x](javascript:alert(1)) [y](data:text/html;base64,AAAA) [ok](https://example.com)\n\n![logo](https://evil.test/p.png) ![tracker](//evil.test/p.png)',
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.test');
    expect(html).toContain('logo');
  });

  it('keeps only data: images', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(r.render(`![ok](${png})`)).toContain(`<img src="${png}"`);
    expect(r.render('![svg](data:image/svg+xml;base64,AAAA)')).not.toContain('<img');
  });

  it('gives the h2 of the table of contents their ids', () => {
    const html = r.render('## 1. Resumo\n\ntexto\n\n## Outro\n\n### 1. Resumo', {
      headingIds: { '1. Resumo': 'sec-1-resumo' },
    });
    expect(html).toContain('<h2 id="sec-1-resumo">1. Resumo</h2>');
    expect(html).toContain('<h2>Outro</h2>');
    expect(html).toContain('<h3>1. Resumo</h3>');
  });

  it('cannot be given ids or classes through Markdown or HTML', () => {
    const html = r.render('<h2 id="sec-9-x" class="x">oi</h2>\n\n## Texto');
    expect(html).not.toContain('sec-9-x');
    expect(html).not.toContain('class="x"');
  });

  describe('mermaid blocks', () => {
    it('embeds the SVG of a diagram that has one (keyed by hash)', () => {
      const svg = '<svg viewBox="0 0 1 1"><text>ok</text></svg>';
      const html = r.render(fence(FLOW), { svgByHash: { [hashDiagram(FLOW)]: svg } });
      expect(html).toContain(
        `<figure class="diagram" data-hash="${hashDiagram(FLOW)}">${svg}</figure>`,
      );
      expect(html).not.toContain('<pre');
    });

    it('falls back to an escaped code block without an SVG', () => {
      const code = 'flowchart TD\n  A["<b>x</b>"] --> B';
      const html = r.render(fence(code));
      expect(html).toContain('<pre class="mermaid-fallback"><code>');
      expect(html).toContain('&#x3C;b>x&#x3C;/b>');
      expect(html).not.toContain('<b>');
      expect(html).toContain('Diagrama não validado');
    });

    it('refuses an unsafe SVG even when one is provided', () => {
      const evil = '<svg><script>alert(1)</script></svg>';
      const html = r.render(fence(FLOW), { svgByHash: { [hashDiagram(FLOW)]: evil } });
      expect(html).not.toContain('<script');
      expect(html).toContain('mermaid-fallback');
    });

    it('does not treat other languages as diagrams', () => {
      const html = r.render('```python\nprint(1)\n```');
      expect(html).not.toContain('figure');
    });
  });
});

describe('RemarkHtmlRenderer.sanitizePrototype', () => {
  it('keeps the kit: tf-* classes, tags, inputs and links to screens', () => {
    const html = r.sanitizePrototype(
      '<div class="tf-card tf-grid"><h2>Título</h2><input class="tf-input" type="text" placeholder="Nome" value="x" disabled><button class="tf-btn-primary" type="submit">Ir</button><a class="tf-btn" href="#tela-detalhe">Ver</a><table class="tf-table"><tr><th>a</th><td>1</td></tr></table><select name="s"><option value="1" selected>Um</option></select><textarea rows="3"></textarea></div>',
    );
    expect(html).toContain('class="tf-card tf-grid"');
    expect(html).toContain(
      '<input class="tf-input" type="text" placeholder="Nome" value="x" disabled>',
    );
    expect(html).toContain('href="#tela-detalhe"');
    expect(html).toContain('<button class="tf-btn-primary" type="submit">');
    expect(html).toContain('<table class="tf-table">');
    expect(html).toContain('<option value="1" selected>');
  });

  it('removes style, handlers, scripts, ids, foreign classes and external links', () => {
    const html = r.sanitizePrototype(
      '<div class="tf-card evil" style="position:fixed" id="tela-x" onclick="x()"><script>alert(1)</script><style>*{}</style><a href="https://evil.test" class="tf-btn">fora</a><a href="#outro">sem tela</a><a href="javascript:x()">js</a><iframe src="x"></iframe><form action="https://evil.test/post" method="post"><input type="file" name="f"></form><img src="https://evil.test/p.png" alt="x"><img src="data:image/png;base64,AAAA" alt="ok"></div>',
    );
    for (const bad of [
      'style',
      'onclick',
      '<script',
      'id=',
      'evil',
      'javascript',
      '<iframe',
      'action',
      'method',
      'type="file"',
      'https:',
      '#outro',
    ]) {
      expect(html, bad).not.toContain(bad);
    }
    expect(html).toContain('class="tf-card"');
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="ok">');
    expect(html).toContain('fora');
  });

  it('keeps nothing from a full document wrapper', () => {
    const html = r.sanitizePrototype(
      '<html><head><title>x</title><script>1</script></head><body><div class="tf-card">oi</div></body></html>',
    );
    expect(html).not.toContain('<html');
    expect(html).not.toContain('<script');
    expect(html).toContain('<div class="tf-card">oi</div>');
  });
});
