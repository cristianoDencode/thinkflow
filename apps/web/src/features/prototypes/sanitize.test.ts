import { describe, expect, it } from 'vitest';
import { prepareSnapshot, sanitizeCss, splitBody } from './sanitize';

describe('prepareSnapshot (untrusted html)', () => {
  it('removes scripts, frames, event handlers and javascript: urls', () => {
    const { html } = prepareSnapshot(
      '<body><script>alert(1)</script><iframe src="x"></iframe><a href="javascript:alert(1)" onclick="x()">a</a>' +
        '<img src=x onerror="y()"><object data="z"></object><form action=" JaVa\nscript:alert(1)"></form></body>',
      '',
    );
    expect(html).not.toMatch(/script|iframe|onclick|onerror|javascript|object/i);
    expect(html).toContain('<a>a</a>');
  });

  it('keeps data: images and normal links', () => {
    const { html } = prepareSnapshot(
      '<body><img src="data:image/png;base64,AAAA"><a href="/x">x</a></body>',
      '',
    );
    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).toContain('href="/x"');
  });

  it('folds <style>, body style and bgcolor into the css and returns a <body> element', () => {
    const out = prepareSnapshot(
      '<body class="pg" bgcolor="CCCCCC" style="margin:0"><style>.a{color:red}</style><p class="a">x</p></body>',
      'p{margin:1px}',
    );
    expect(out.html).toBe('<body class="pg"><p class="a">x</p></body>');
    expect(out.css).toContain('p{margin:1px}');
    expect(out.css).toContain('.a{color:red}');
    expect(out.css).toContain('body{margin:0}');
    expect(out.css).toContain('body{background-color:#CCCCCC}');
  });

  it('wraps a bare fragment in <body>', () => {
    expect(prepareSnapshot('<b>oi</b>', '').html).toBe('<body><b>oi</b></body>');
  });

  it('sanitizeCss drops imports, expressions and script urls', () => {
    const css = sanitizeCss(
      '@import url(http://x/y.css); a{width:expression(alert(1));background:url(javascript:alert(1));behavior:url(x)} b{color:red}',
    );
    expect(css).not.toMatch(/@import|expression|javascript|behavior/);
    expect(css).toContain('b{color:red}');
  });
});

describe('splitBody', () => {
  it('returns the inner html and the body attributes', () => {
    expect(splitBody('<body class="a b" data-x="1"><p>x</p></body>')).toEqual({
      inner: '<p>x</p>',
      attrs: { class: 'a b', 'data-x': '1' },
    });
  });
});
