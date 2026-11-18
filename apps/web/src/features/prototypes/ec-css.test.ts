import { afterEach, describe, expect, it } from 'vitest';
import { CAPTURED_CSS, CAPTURED_HTML } from './captured-screen.fixture';
import { cssSubsetFor, parseRules, splitTopLevel } from './ec-css';

const mount = (html = CAPTURED_HTML.replace(/^<body[^>]*>|<\/body>$/g, '')) => {
  document.body.innerHTML = html;
  document.body.className = 'tela';
  return document.body;
};
afterEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
});

const rules = (css: string) =>
  parseRules(css)
    .map((r) => r.prelude)
    .filter(Boolean);

describe('css parsing', () => {
  it('splits at the top level only', () => {
    expect(splitTopLevel('a, b:not(.x, .y), c[data-a="1,2"], d', ',')).toEqual([
      'a',
      'b:not(.x, .y)',
      'c[data-a="1,2"]',
      'd',
    ]);
    expect(splitTopLevel('a:1;b:url(data:x;base64,AA);c:"x;y"', ';')).toEqual([
      'a:1',
      'b:url(data:x;base64,AA)',
      'c:"x;y"',
    ]);
  });

  it('reads rules, at-rules with blocks, statements and ignores comments and braces in strings', () => {
    const parsed = parseRules(
      '/* c */ @charset "utf-8"; a{color:red} @media print{b{x:1}c{y:2}} d::after{content:"}{"} @font-face{src:url(data:a;b)}',
    );
    expect(parsed.map((r) => r.prelude)).toEqual([
      '@charset "utf-8"',
      'a',
      '@media print',
      'd::after',
      '@font-face',
    ]);
    expect(parsed[2]?.body).toBe('b{x:1}c{y:2}');
    expect(parsed[3]?.body).toBe('content:"}{"');
  });
});

describe('cssSubsetFor', () => {
  it('keeps the rules that match the component or something inside it, with its context', () => {
    mount();
    const row = document.querySelector('tr[data-ec="lookup"]')!;
    const subset = cssSubsetFor(CAPTURED_CSS, [row]);
    expect(subset).toContain('table.layout td.rotulo{width:140px;text-align:right}');
    expect(subset).toContain('table.layout td.campo{padding:1px 3px}');
    expect(subset).toContain('.lnk{color:#cc0000;text-decoration:underline}');
    expect(subset).toContain('.lnk:hover{color:#ff0000}'); // interactive states count
    expect(subset).toContain('.in{border:1px solid #999999;background:#ffffff}');
    expect(subset).toContain('.in.somente{background:#deb887}');
    // other components' rules are left out
    for (const other of [
      '.grade',
      '.rodape',
      '.barra',
      '.btn',
      '.nunca-usada',
      '.linha-par',
      '.num',
      '.cal',
    ]) {
      expect(subset).not.toContain(other);
    }
    expect(subset).not.toContain('body.tela');
  });

  it('keeps only the matching selectors of a grouped rule', () => {
    mount('<p class="a x">1</p><p class="b">2</p>');
    const subset = cssSubsetFor('.a,.b,.c{color:red}', [document.querySelector('.a')!]);
    expect(subset).toBe('.a{color:red}');
  });

  it('keeps @media blocks reduced to the matching rules', () => {
    mount();
    const bar = document.querySelector('[data-ec="button-bar"]')!;
    const subset = cssSubsetFor(CAPTURED_CSS, [bar]);
    expect(subset).toContain('@media print{.barra{display:none}}');
    expect(subset).not.toContain('nunca-usada');
  });

  it('keeps the :root variables the kept rules use, and only those', () => {
    mount();
    const bar = document.querySelector('[data-ec="button-bar"]')!;
    const subset = cssSubsetFor(CAPTURED_CSS, [bar]);
    expect(subset).toContain(':root{--cinza:#d4d0c8}');
    expect(subset).not.toContain('--azul');
    expect(subset).not.toContain('--nao-usada');
    // no variables used -> no :root rule
    const lookup = document.querySelector('tr[data-ec="lookup"]')!;
    expect(cssSubsetFor(CAPTURED_CSS, [lookup])).not.toContain(':root');
  });

  it('keeps variables that depend on other variables', () => {
    mount('<p class="a">x</p>');
    const css = ':root{--a:var(--b);--b:#fff;--c:1}.a{color:var(--a)}';
    expect(cssSubsetFor(css, [document.querySelector('.a')!])).toBe(
      ':root{--a:var(--b);--b:#fff}\n.a{color:var(--a)}',
    );
  });

  it('keeps the @font-face of the families the kept rules use, not the others', () => {
    mount();
    const subset = cssSubsetFor(CAPTURED_CSS, [document.body]);
    expect(subset).toContain('@font-face{font-family:"ECFonte"');
    expect(subset).toContain('base64,AAAA');
    expect(subset).not.toContain('"Outra"');
    expect(subset).toContain('body.tela{margin:0');
  });

  it('keeps the @keyframes an animation refers to', () => {
    mount('<p class="a">x</p>');
    const css =
      '@keyframes pisca{from{opacity:0}to{opacity:1}}@keyframes outra{from{top:0}to{top:1px}}.a{animation:pisca 1s infinite}';
    const subset = cssSubsetFor(css, [document.querySelector('.a')!]);
    expect(subset).toContain('@keyframes pisca{from{opacity:0}to{opacity:1}}');
    expect(subset).not.toContain('outra');
  });

  it('counts the own rules of "selfOnly" elements (the table a row came from) but not their descendants', () => {
    mount();
    const row = document.querySelector('tr[data-ec="field"]')!;
    const table = row.closest('table')!;
    const css =
      'table.layout{border:1px solid red}table.layout td.rotulo{width:1px}table.layout td.so-outra-linha{x:1}';
    const without = cssSubsetFor(css, [row]);
    expect(without).not.toContain('table.layout{border');
    const withTable = cssSubsetFor(css, [row], [table]);
    expect(withTable).toContain('table.layout{border:1px solid red}');
    expect(withTable).toContain('td.rotulo');
    expect(withTable).not.toContain('so-outra-linha');
  });

  it('keeps a rule rather than losing it when the selector is not supported', () => {
    mount('<p class="a">x</p>');
    expect(cssSubsetFor('.a:foo-bar(1){color:red}', [document.querySelector('.a')!])).toContain(
      'color:red',
    );
  });

  it('returns nothing for empty input', () => {
    expect(cssSubsetFor('', [document.body])).toBe('');
    expect(cssSubsetFor('a{b:c}', [])).toBe('');
  });
});

describe('rules helper', () => {
  it('lists the preludes', () => {
    expect(rules('a{b:c}@media x{d{e:f}}')).toEqual(['a', '@media x']);
  });
});
