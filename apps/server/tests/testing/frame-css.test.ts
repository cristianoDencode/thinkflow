import { describe, expect, it } from 'vitest';
import {
  addToSubject,
  frameBaseCss,
  isolateTopCss,
  scopeCss,
  scopeSelector,
  TOP_QUIRKS_CSS,
} from '../../src/contexts/testing/domain/frame-css';

const S = '[data-tf-frame="2"]';

describe('scopeSelector', () => {
  it('puts the frame div before ordinary selectors', () => {
    expect(scopeSelector('.a', S)).toBe(`${S} .a`);
    expect(scopeSelector('table td.x > a:hover', S)).toBe(`${S} table td.x > a:hover`);
    expect(scopeSelector('  #id  ', S)).toBe(`${S} #id`);
  });

  it('maps html, body and :root to the div itself', () => {
    expect(scopeSelector('html', S)).toBe(S);
    expect(scopeSelector('body', S)).toBe(S);
    expect(scopeSelector(':root', S)).toBe(S);
    expect(scopeSelector('html body', S)).toBe(S);
    expect(scopeSelector('html > body', S)).toBe(S);
  });

  it('keeps what follows html/body in the same compound and after it', () => {
    expect(scopeSelector('body.pagina', S)).toBe(`${S}.pagina`);
    expect(scopeSelector('body:not(.x)', S)).toBe(`${S}:not(.x)`);
    expect(scopeSelector('body a', S)).toBe(`${S} a`);
    expect(scopeSelector('html body table.x', S)).toBe(`${S} table.x`);
    expect(scopeSelector('html.js body.escuro > div', S)).toBe(`${S}.js.escuro > div`);
    expect(scopeSelector('body > div', S)).toBe(`${S} > div`);
  });

  it('does not mistake names that start with body/html', () => {
    expect(scopeSelector('bodyguard', S)).toBe(`${S} bodyguard`);
    expect(scopeSelector('.body', S)).toBe(`${S} .body`);
    expect(scopeSelector('html-x', S)).toBe(`${S} html-x`);
  });

  it('* covers the div and everything in it', () => {
    expect(scopeSelector('*', S)).toBe(`${S},${S} *`);
    expect(scopeSelector('*::before', S)).toBe(`${S} *::before`);
  });
});

describe('scopeCss', () => {
  it('scopes every selector of a list, even inside functions and strings', () => {
    const css = 'a, .b:not(.c, .d), [title="x, y"] { color: red }';
    expect(scopeCss(css, 2)).toBe(`${S} a,${S} .b:not(.c, .d),${S} [title="x, y"]{ color: red }`);
  });

  it('maps body rules to the div and keeps the declarations', () => {
    const out = scopeCss('body { margin: 0; background: #ccc } td { font-size: 12px }', 2);
    expect(out).toBe(`${S}{ margin: 0; background: #ccc }\n${S} td{ font-size: 12px }`);
  });

  it('scopes the rules inside @media / @supports, not the @media itself', () => {
    const out = scopeCss('@media (max-width: 600px) { body { x: y } .a { z: w } }', 2);
    expect(out).toBe(`@media (max-width: 600px){${S}{ x: y }\n${S} .a{ z: w }}`);
    expect(scopeCss('@supports (display:grid) { .g { display: grid } }', 2)).toBe(
      `@supports (display:grid){${S} .g{ display: grid }}`,
    );
  });

  it('drops @import, @charset, @namespace and @page; keeps declarations with braces in strings', () => {
    const css =
      '@charset "utf-8"; @import url(a.css); @page { margin: 1cm } .a::after { content: "}{" }';
    expect(scopeCss(css, 2)).toBe(`${S} .a::after{ content: "}{" }`);
  });

  it('ignores comments and survives junk', () => {
    expect(scopeCss('/* oi { */ .a /* x */ { color: red } /* fim', 2)).toBe(
      `${S} .a{ color: red }`,
    );
    expect(scopeCss('.a { color: red', 2)).toContain(`${S} .a`);
    expect(scopeCss('', 2)).toBe('');
    expect(scopeCss('{ } } {', 2)).toBe('');
  });

  it('keeps @font-face once across frames', () => {
    const seen = new Set<string>();
    const face = '@font-face { font-family: X; src: url("data:font/woff2;base64,AA") }';
    expect(scopeCss(face, 1, { seenFontFaces: seen })).toContain('@font-face');
    expect(scopeCss(face, 2, { seenFontFaces: seen })).toBe('');
    expect(scopeCss(`${face} .a{color:red}`, 3, { seenFontFaces: seen })).toBe(
      '[data-tf-frame="3"] .a{color:red}',
    );
  });

  it('renames @keyframes per frame and follows the animation declarations', () => {
    const css =
      '@keyframes giro { from { opacity: 0 } to { opacity: 1 } } .a { animation: giro 1s ease; animation-name: giro, outro } @-webkit-keyframes giro { 0% { top: 0 } }';
    const out = scopeCss(css, 2);
    expect(out).toContain('@keyframes giro-tf2{ from { opacity: 0 } to { opacity: 1 } }');
    expect(out).toContain('@-webkit-keyframes giro-tf2{ 0% { top: 0 } }');
    expect(out).toContain(
      `${S} .a{ animation: giro-tf2 1s ease; animation-name: giro-tf2, outro }`,
    );
    // keyframe selectors are percentages: never scoped
    expect(out).not.toContain(`${S} from`);
  });

  it('is applied twice to different frames without collisions', () => {
    const css = 'body { color: red } @keyframes k { to { top: 1px } }';
    const a = scopeCss(css, 1);
    const b = scopeCss(css, 2);
    expect(a).toContain('[data-tf-frame="1"]{ color: red }');
    expect(b).toContain('[data-tf-frame="2"]{ color: red }');
    expect(a).toContain('@keyframes k-tf1');
    expect(b).toContain('@keyframes k-tf2');
  });
});

describe('frameBaseCss', () => {
  it('starts the div from the browser defaults, nothing inherited from the page around it', () => {
    expect(frameBaseCss(3, { quirks: false, topQuirks: false })).toBe(
      '[data-tf-frame="3"]{all:initial;box-sizing:border-box}',
    );
  });

  it('keeps the quirks-mode table behaviour of the frame, or restores inheritance in a quirks page', () => {
    expect(frameBaseCss(3, { quirks: true, topQuirks: false })).toContain(
      '[data-tf-frame="3"] table{font-size:medium',
    );
    expect(frameBaseCss(3, { quirks: false, topQuirks: true })).toContain(
      '[data-tf-frame="3"] table{font-size:inherit',
    );
    expect(TOP_QUIRKS_CSS).toMatch(/^table\{font-size:medium/);
  });
});

describe('rules that must not reach into nested frames', () => {
  const NOT = ':not([data-tf-frame="2"] [data-tf-frame],[data-tf-frame="2"] [data-tf-frame] *)';

  it('adds the exclusion to the subject, before a trailing pseudo-element', () => {
    expect(addToSubject('.a .b', ':not(X)')).toBe('.a .b:not(X)');
    expect(addToSubject('.a > b::before', ':not(X)')).toBe('.a > b:not(X)::before');
    expect(addToSubject('a:after', ':not(X)')).toBe('a:not(X):after');
    expect(addToSubject('input:not([x="a b"]):focus', ':not(X)')).toBe(
      'input:not([x="a b"]):focus:not(X)',
    );
  });

  it("keeps a frame's reset from leaking into the frames inside it", () => {
    const css = scopeCss('* { border: 0 } fieldset { margin: 0 } body { color: red }', 2, {
      hasChildFrames: true,
    });
    expect(css).toContain(`[data-tf-frame="2"],[data-tf-frame="2"] *${NOT}{ border: 0 }`);
    expect(css).toContain(`[data-tf-frame="2"] fieldset${NOT}{ margin: 0 }`);
    // the frame div itself is not inside a nested frame
    expect(css).toContain('[data-tf-frame="2"]{ color: red }');
    // without nested frames the CSS stays as it was
    expect(scopeCss('fieldset { margin: 0 }', 2)).toBe('[data-tf-frame="2"] fieldset{ margin: 0 }');
  });

  it('applies the same to the captured document itself', () => {
    const css = isolateTopCss('.dialog .top { width: 1px } @media (min-width: 1px) { a { x: y } }');
    const not = ':not([data-tf-frame],[data-tf-frame] *)';
    expect(css).toContain(`.dialog .top${not}{ width: 1px }`);
    expect(css).toContain(`@media (min-width: 1px){a${not}{ x: y }}`);
  });

  it('keeps the quirks table rule of a frame out of its children', () => {
    expect(frameBaseCss(2, { quirks: true, topQuirks: false, hasChildFrames: true })).toContain(
      `[data-tf-frame="2"] table:not([data-tf-frame="2"] [data-tf-frame] *){font-size:medium`,
    );
  });
});
