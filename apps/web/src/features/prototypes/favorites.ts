import { ECIDADE_BLOCK_CATEGORY, EC_KIND_ATTR, type PrototypeBlockDto } from '@thinkflow/shared';
import { parseRules, splitTopLevel } from './ec-css';
import { structureSignature } from './ec-describe';
import type { EcidadeComponentKind } from '@thinkflow/shared';

/*
 * Favorites: components saved to the "e-Cidade" palette category (to be reused in any prototype,
 * not only in the one they were captured from). A favorite stores the component markup and the
 * subset of the screen's CSS it needs (see `ec-css.ts`); that CSS is written for the screen it
 * came from, so a generic rule (`td`, `input`, `table.layout td`…) would restyle every cell and
 * field of the prototype it is dropped in. On insertion its selectors are therefore scoped to the
 * inserted component (see `scopeFavoriteCss`), without changing their specificity.
 */

/** Attribute that ties an inserted favorite to its scoped rules. */
export const FAV_ATTR = 'data-ec-fav';

export const isFavorite = (block: Pick<PrototypeBlockDto, 'category'>): boolean =>
  block.category === ECIDADE_BLOCK_CATEGORY;

/** Tooltip of a favorite in the palette. */
export const favoriteTitle = (block: Pick<PrototypeBlockDto, 'name' | 'source'>): string =>
  block.source ?? `Favorito: ${block.name}`;

export const favoriteSource = (prototypeName: string): string =>
  `Favorito de ${prototypeName}`.slice(0, 200);

const safeId = (id: string) => id.replace(/[^\w-]/g, '');

const scopeOf = (id: string) => {
  const attr = `[${FAV_ATTR}="${safeId(id)}"]`;
  return `:where(${attr},${attr} *)`;
};

/** `::before`, `::placeholder`, `:after`… at the end of a selector: they cannot go inside `:is()`. */
const PSEUDO_ELEMENT_TAIL =
  /(?:::[\w-]+(?:\([^)]*\))?|:(?:before|after|first-line|first-letter))(?::[\w-]+(?:\([^)]*\))?)*$/i;

/**
 * `sel` -> `:where([data-ec-fav="id"], [data-ec-fav="id"] *):is(sel)`: the original selector, but
 * only for the inserted component (or what is inside it). `:where()` weighs nothing, so the
 * specificity — and with it the order in which the favorite's rules win over each other — is the
 * one of the original selector.
 */
function scopeSelector(selector: string, id: string): string {
  const tail = PSEUDO_ELEMENT_TAIL.exec(selector);
  const main = (tail ? selector.slice(0, tail.index) : selector).trim() || '*';
  return `${scopeOf(id)}:is(${main})${tail?.[0] ?? ''}`;
}

function scopeRules(css: string, id: string): string {
  const out: string[] = [];
  for (const { prelude, body } of parseRules(css)) {
    if (body === null) continue; // @import / @charset
    if (prelude.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
      const nested = ['media', 'supports', 'layer', 'container'].includes(name);
      out.push(`${prelude}{${nested ? scopeRules(body, id) : body.trim()}}`);
      continue;
    }
    const selectors = splitTopLevel(prelude, ',');
    // custom properties on :root are global by nature: they are kept as they are
    if (selectors.every((s) => /^(:root|html)$/i.test(s))) {
      out.push(`${prelude}{${body.trim()}}`);
      continue;
    }
    out.push(`${selectors.map((s) => scopeSelector(s, id)).join(',')}{${body.trim()}}`);
  }
  return out.join('\n');
}

/** The CSS of a favorite, ready to be added to the edit rules of the prototype it is inserted in. */
export function scopeFavoriteCss(css: string, id: string): string {
  return css.trim() ? scopeRules(css, id) : '';
}

const SCOPE_PREFIX =
  /:where\(\[data-ec-fav=["'][\w-]*["']\],\s*\[data-ec-fav=["'][\w-]*["']\]\s*\*\):is\(/g;

/** Inverse of `scopeFavoriteCss` (a component that came from a favorite is favorited again). */
export function unscopeFavoriteCss(css: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    SCOPE_PREFIX.lastIndex = from;
    const match = SCOPE_PREFIX.exec(css);
    if (!match) return out + css.slice(from);
    out += css.slice(from, match.index);
    const start = match.index + match[0].length;
    let depth = 1;
    let quote = '';
    let end = start;
    for (; end < css.length && depth > 0; end++) {
      const ch = css[end];
      if (quote) {
        if (ch === '\\') end++;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    out += css.slice(start, end - 1);
    from = end;
  }
}

/** Markup without the scope attribute (a favorite is stored the way it would be captured). */
export const stripFavoriteAttr = (html: string): string =>
  html.replace(/\sdata-ec-fav=(?:"[^"]*"|'[^']*')/g, '');

/** What identifies a favorite's structure: its kind plus the tags/classes/attributes, texts aside. */
export function favoriteSignature(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const kind = doc.body.querySelector(`[${EC_KIND_ATTR}]`)?.getAttribute(EC_KIND_ATTR);
  return kind ? structureSignature(stripFavoriteAttr(html), kind as EcidadeComponentKind) : null;
}
