import { describe, expect, it } from 'vitest';
import {
  isSafeUrl,
  sanitizeCss,
  sanitizeHtml,
  sanitizeStylesheet,
} from '../../src/contexts/prototypes/domain/html-sanitizer';

describe('sanitizeHtml', () => {
  it('removes scripts, with their content, in any case', () => {
    const out = sanitizeHtml(
      '<body><p>Oi</p><script>alert(1)</script><SCRIPT src=x.js></SCRIPT></body>',
    );
    expect(out).toBe('<body><p>Oi</p></body>');
  });

  it('removes on* event handlers but keeps the other attributes', () => {
    const out = sanitizeHtml(
      '<button id="b" class="x" onclick="steal()" ONMOUSEOVER=hack() data-a="1">Ok</button>',
    );
    expect(out).toBe('<button id="b" class="x" data-a="1">Ok</button>');
  });

  it('removes javascript: URLs, however they are hidden', () => {
    const hidden = [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'java&#x09;script:alert(1)',
      '&#106;avascript:alert(1)',
      'jav&Tab;ascript:alert(1)',
      '\u0001javascript:alert(1)',
      'vbscript:msgbox(1)',
    ];
    for (const url of hidden) {
      const out = sanitizeHtml(
        `<a href="${url}">x</a><img src="${url}"><form action="${url}"></form>`,
      );
      expect(out, url).toBe('<a>x</a><img><form></form>');
    }
  });

  it('keeps ordinary links, relative URLs and anchors', () => {
    const html =
      '<a href="https://a.b/x?y=1&amp;z=2">a</a><a href="rotina.php?x=1">b</a><a href="#topo">c</a><a href="mailto:a@b.c">d</a>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('keeps data:image/* pictures and drops any other data: URL', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanitizeHtml(`<img src="${png}">`)).toBe(`<img src="${png}">`);
    expect(sanitizeHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">')).toBe('<img>');
    expect(sanitizeHtml('<a href="data:image/png;base64,AAAA">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<iframe src="data:image/png;base64,AA"></iframe>')).toBe('');
  });

  it('removes iframe, object, embed, base, meta and link elements', () => {
    const out = sanitizeHtml(
      '<head><base href="http://evil/"><meta http-equiv="refresh" content="0;url=http://evil"><meta charset="utf-8"><link rel="stylesheet" href="http://evil/a.css"><title>T</title></head>' +
        '<body><iframe src="/x"></iframe><object data="x"></object><embed src="x"><applet code="x"></applet><p>ok</p></body>',
    );
    expect(out).toBe('<head><title>T</title></head><body><p>ok</p></body>');
  });

  it('keeps inline styles and neutralizes dangerous ones', () => {
    expect(sanitizeHtml('<div style="color:red;width:10px">a</div>')).toBe(
      '<div style="color:red;width:10px">a</div>',
    );
    const out = sanitizeHtml(
      '<div style="background:url(javascript:alert(1));width:expression(alert(1))">a</div>',
    );
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/expression\(/i);
    expect(
      sanitizeHtml('<div style="background:url(data:image/gif;base64,R0lG)">a</div>'),
    ).toContain('data:image/gif');
  });

  it('cleans <style> elements and cannot be broken out of', () => {
    const out = sanitizeHtml(
      '<style>@import url(http://evil/x.css); .a{color:red} </style><svg><style><img src=x onerror=alert(1)></style></svg>',
    );
    expect(out).not.toMatch(/@import/);
    expect(out).toContain('.a{color:red}');
    // no "<" survives inside a style element: it cannot be reparsed as markup
    for (const m of out.matchAll(/<style>([\s\S]*?)<\/style>/g)) expect(m[1]).not.toContain('<');
    expect(out).not.toMatch(/<img/);
  });

  it('drops comments, doctypes and conditional comments', () => {
    expect(
      sanitizeHtml('<!DOCTYPE html><!--[if IE]><script>x</script><![endif]--><p>a</p><!-- c -->'),
    ).toBe('<p>a</p>');
  });

  it('escapes what it writes and drops invalid attribute names', () => {
    expect(sanitizeHtml('<p title=\'a"b\' "bad"=1 x<y="2">1 < 2 & 3</p>')).toBe(
      '<p title="a&quot;b">1 &lt; 2 & 3</p>',
    );
  });

  it('keeps svg, but not its script, animation or foreign-object tricks', () => {
    const out = sanitizeHtml(
      '<svg viewBox="0 0 10 10" onload="x()"><path d="M0 0L5 5"/><script>x()</script><a><animate attributeName="href" values="javascript:alert(1)"/></a><use href="http://evil/x.svg#a"/></svg><p>depois</p>',
    );
    expect(out).toBe(
      '<svg viewbox="0 0 10 10"><path d="M0 0L5 5"></path><a></a><use></use></svg><p>depois</p>',
    );
  });

  it('keeps form state and table structure, is idempotent and tolerates sloppy markup', () => {
    const html =
      '<form><input type="text" value="Ana" disabled><input type="checkbox" checked><select><option>A<option selected>B</select><textarea>t &lt;x&gt;</textarea></form>' +
      '<table><thead><tr><th>Nome</th></tr></thead><tbody><tr><td>Ana<tr><td>Rui</tbody></table>';
    const once = sanitizeHtml(html);
    expect(once).toContain('<input type="text" value="Ana" disabled>');
    expect(once).toContain('<option selected>B</option>');
    expect(once).toContain('<textarea>t &lt;x&gt;</textarea>');
    expect(once).toContain('<tr><td>Ana</td></tr><tr><td>Rui</td></tr>');
    expect(sanitizeHtml(once)).toBe(once);
  });

  it('survives unterminated input and absurd nesting', () => {
    expect(() => sanitizeHtml('<div class="a')).not.toThrow();
    expect(() => sanitizeHtml('<p>' + '<div>'.repeat(5000) + 'x')).not.toThrow();
    expect(sanitizeHtml('<p>a</p><script>never closed')).toBe('<p>a</p>');
  });
});

describe('isSafeUrl', () => {
  it('allows relative, http(s), mailto and tel; refuses other schemes', () => {
    for (const ok of [
      '',
      '/a/b.php?x=1',
      'a.php',
      '../a',
      '#x',
      'https://a.b',
      'http://a.b',
      'tel:123',
    ])
      expect(isSafeUrl(ok), ok).toBe(true);
    for (const bad of [
      'javascript:x',
      'file:///etc/passwd',
      'blob:http://a/b',
      'ftp://a',
      'x:y',
      'data:text/html,hi',
    ])
      expect(isSafeUrl(bad, { allowDataImage: true }), bad).toBe(false);
    expect(isSafeUrl('data:image/png;base64,AA', { allowDataImage: true })).toBe(true);
    expect(isSafeUrl('data:image/png;base64,AA')).toBe(false);
  });
});

describe('sanitizeCss / sanitizeStylesheet', () => {
  it('keeps normal rules (including escaped selectors) and drops @import and script hooks', () => {
    const css =
      '@import url("http://evil/x.css");\n.md\\:flex{display:flex}\n@media (min-width:10px){a{color:red}}\n@font-face{font-family:F;src:url("http://a/f.woff2")}\nb{behavior:url(x.htc);-moz-binding:url(x);width:expression(1)}';
    const out = sanitizeCss(css);
    expect(out).not.toMatch(/@import/);
    expect(out).toContain('.md\\:flex{display:flex}');
    expect(out).toContain('@media (min-width:10px){a{color:red}}');
    expect(out).toContain('url("http://a/f.woff2")');
    expect(out).not.toMatch(/(^|[^-])behavior\s*:/);
    expect(out).not.toMatch(/(^|[^-])-moz-binding\s*:/);
    expect(out).not.toMatch(/expression\(/);
  });

  it('refuses non-image data URLs and escaped javascript: inside url()', () => {
    const out = sanitizeCss(
      'a{background:url(data:text/html,<b>)}b{background:url("\\6a avascript:alert(1)")}c{background:url(data:image/png;base64,AA==)}',
    );
    expect(out).not.toMatch(/data:text/);
    expect(out).not.toMatch(/avascript/i);
    expect(out).toContain('data:image/png;base64,AA==');
  });

  it('never leaves "<" in a stylesheet meant for a <style> element', () => {
    expect(sanitizeStylesheet('a::after{content:"</style><script>x()</script>"}')).not.toContain(
      '<',
    );
  });
});
