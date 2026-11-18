import { describe, expect, it } from 'vitest';
import {
  FAV_ATTR,
  favoriteSignature,
  favoriteTitle,
  isFavorite,
  scopeFavoriteCss,
  stripFavoriteAttr,
  unscopeFavoriteCss,
} from './favorites';

/** A document holding `html`, to ask which elements a (scoped) selector reaches. */
function page(html: string): Document {
  const doc = document.implementation.createHTMLDocument('t');
  doc.body.innerHTML = html;
  return doc;
}
const selectors = (css: string) =>
  css
    .split('}')
    .map((r) => r.split('{')[0]!.trim())
    .filter(Boolean);

describe('favorites: scoping the css', () => {
  const css = 'td{padding:0}\ninput{border:1px solid red}\n.ec-x:hover{color:red}';

  it('limits every selector to the inserted component without changing its specificity', () => {
    const scoped = scopeFavoriteCss(css, 'b1');
    expect(selectors(scoped)).toEqual([
      ':where([data-ec-fav="b1"],[data-ec-fav="b1"] *):is(td)',
      ':where([data-ec-fav="b1"],[data-ec-fav="b1"] *):is(input)',
      ':where([data-ec-fav="b1"],[data-ec-fav="b1"] *):is(.ec-x:hover)',
    ]);
    // `:where()` weighs nothing: the selector keeps its own specificity
    expect(scoped).toContain('{padding:0}');
    expect(scoped).toContain('{border:1px solid red}');
  });

  it('generic selectors (td, input) reach only the cells and fields of the inserted component', () => {
    const html =
      '<table><tbody><tr><td id="other">x</td></tr></tbody></table>' +
      '<input id="other-input">' +
      '<table><tbody><tr data-ec="lookup" data-ec-fav="b1"><td id="mine">y</td><td><input id="mine-input"></td></tr></tbody></table>';
    const doc = page(html);
    const mine = selectors(scopeFavoriteCss('td{padding:0}\ninput{border:1px solid red}', 'b1'));
    const hit = (selector: string) =>
      [...doc.querySelectorAll(selector)].map((el) => el.id).filter(Boolean);
    expect(mine).toHaveLength(2);
    expect(hit(mine[0]!)).toEqual(['mine']);
    expect(hit(mine[1]!)).toEqual(['mine-input']);
    // unscoped, the same rules would have reached everything
    expect(hit('td')).toEqual(['other', 'mine']);
    expect(hit('input')).toEqual(['other-input', 'mine-input']);
  });

  it('the component root itself is reached too (a rule for the row of a row block)', () => {
    const doc = page(
      '<table><tbody><tr id="root" data-ec-fav="b1"><td>y</td></tr><tr id="out"><td>z</td></tr></tbody></table>',
    );
    const [selector] = selectors(scopeFavoriteCss('tr{height:20px}', 'b1')) as [string];
    expect([...doc.querySelectorAll(selector)].map((e) => e.id)).toEqual(['root']);
  });

  it('keeps pseudo-elements outside :is(), at-rules nested, and fonts/variables untouched', () => {
    const scoped = scopeFavoriteCss(
      '@font-face{font-family:F;src:url(data:font/woff2;base64,AA)}\n:root{--c:#fff}\n.a::before{content:"x"}\n@media (min-width:1px){td{x:y}}\n@import url(http://evil/x.css);',
      'b1',
    );
    expect(scoped).toContain('@font-face{font-family:F;src:url(data:font/woff2;base64,AA)}');
    expect(scoped).toContain(':root{--c:#fff}');
    expect(scoped).toContain(':where([data-ec-fav="b1"],[data-ec-fav="b1"] *):is(.a)::before{');
    expect(scoped).toContain('@media (min-width:1px){:where(');
    expect(scoped).not.toContain('@import');
  });

  it('lists of selectors are scoped one by one; empty css stays empty', () => {
    const scoped = scopeFavoriteCss('td, th{a:b}', 'b1');
    expect(selectors(scoped)).toEqual([
      ':where([data-ec-fav="b1"],[data-ec-fav="b1"] *):is(td),:where([data-ec-fav="b1"],[data-ec-fav="b1"] *):is(th)',
    ]);
    expect(scopeFavoriteCss('  ', 'b1')).toBe('');
  });

  it('unscoping gives back the original rules (a favorite is favorited again)', () => {
    const original =
      'td{padding:0}\n.a::before{content:"x"}\n@media (min-width:1px){td, input:focus{x:y}}';
    const back = unscopeFavoriteCss(scopeFavoriteCss(original, 'b1'));
    expect(back.replace(/\s+/g, '')).toBe(original.replace(/\s+/g, ''));
    expect(unscopeFavoriteCss('p{a:b}')).toBe('p{a:b}');
  });

  it('removes the scope attribute from the markup', () => {
    expect(stripFavoriteAttr(`<tr ${FAV_ATTR}="b1" data-ec="lookup"><td>x</td></tr>`)).toBe(
      '<tr data-ec="lookup"><td>x</td></tr>',
    );
  });
});

describe('favorites: identity', () => {
  const lookup = (label: string, attrs = '') =>
    `<div class="l" data-ec="lookup"${attrs}><label data-ec-part="label">${label}</label><input data-ec-part="input" value="1"></div>`;

  it('the same structure has the same signature, whatever the texts, values and scope', () => {
    expect(favoriteSignature(lookup('Empenho'))).toBe(favoriteSignature(lookup('Reduzido')));
    expect(favoriteSignature(lookup('A'))).toBe(favoriteSignature(lookup('A', ' data-ec-fav="x"')));
    expect(favoriteSignature(lookup('A'))).not.toBe(
      favoriteSignature(lookup('A').replace('class="l"', 'class="m"')),
    );
    expect(favoriteSignature('<p>sem componente</p>')).toBeNull();
  });

  it('recognizes favorites by category and titles them with their source', () => {
    expect(isFavorite({ category: 'e-Cidade' })).toBe(true);
    expect(isFavorite({ category: 'Meus blocos' })).toBe(false);
    expect(favoriteTitle({ name: 'A', source: 'Favorito de Consulta' })).toBe(
      'Favorito de Consulta',
    );
    expect(favoriteTitle({ name: 'A', source: null })).toBe('Favorito: A');
  });
});
