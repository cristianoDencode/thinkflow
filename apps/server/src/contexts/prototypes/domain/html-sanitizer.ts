import {
  decodeEntities,
  neutralizeCssForHtml,
  parseHtml,
  serializeNodes,
  type HtmlElement,
  type HtmlNode,
} from './html-tree';

/*
 * Sanitizer for the HTML/CSS of prototypes. The stored markup is shown inside the visual editor
 * and rendered by Chromium, so nothing in it may run code or navigate: scripts, event handlers,
 * `javascript:` URLs, frames/objects/embeds, <base>, meta refresh and external stylesheets are
 * removed. Inline styles and `data:image/*` pictures are kept. It works on a parsed tree and
 * re-serializes it, so what is stored is always well-formed and escaped by us.
 */

/** Dropped together with their whole content. */
const DROPPED_TAGS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'meta',
  'link',
  'noscript',
  'noembed',
  'noframes',
  'template',
  'xmp',
  'plaintext',
  'portal',
  'fencedframe',
  // SVG elements that can run or load code
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'handler',
  'listener',
]);

/** Attributes holding one URL. */
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'background',
  'poster',
  'cite',
  'longdesc',
  'xlink:href',
  'data',
  'manifest',
  'codebase',
  'usemap',
]);

/** Attributes where an inline picture (`data:image/*`) is acceptable. */
const DATA_IMAGE_ATTRS = new Set(['src', 'background', 'poster']);

/** Dropped everywhere (can load or run things). */
const DROPPED_ATTRS = new Set(['srcdoc', 'ping', 'srcset', 'imagesrcset', 'is', 'nonce']);

const DATA_IMAGE =
  /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i;
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/** Removes what browsers ignore inside a URL scheme (controls, spaces) before it is analyzed. */
function compactUrl(value: string): string {
  let out = '';
  for (const ch of decodeEntities(value)) {
    const c = ch.codePointAt(0)!;
    const ignored =
      c <= 0x20 ||
      (c >= 0x7f && c <= 0xa0) ||
      (c >= 0x200b && c <= 0x200f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0xfeff;
    if (!ignored) out += ch;
  }
  return out;
}

/**
 * Whether a URL may stay: relative references, `#anchors`, http(s)/mailto/tel and, for pictures,
 * `data:image/*`. Everything else (javascript:, vbscript:, data:text/html, blob:, file:…) goes.
 */
export function isSafeUrl(value: string, options: { allowDataImage?: boolean } = {}): boolean {
  const url = compactUrl(value);
  if (url === '') return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!scheme) {
    // a "&" before the first path separator could still hide a scheme (unknown named entity)
    const head = url.split(/[/?#]/, 1)[0] ?? '';
    return !head.includes('&') && !head.includes(':');
  }
  const name = scheme[1]!.toLowerCase();
  if (name === 'data') return !!options.allowDataImage && DATA_IMAGE.test(url);
  return SAFE_SCHEMES.has(name);
}

/** Decodes CSS escapes (`\6a`, `\:`) so a hidden `javascript:` can be spotted inside url(). */
function unescapeCss(value: string): string {
  return value.replace(/\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi, (_m, hex, ch) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : ch,
  );
}

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi;

/**
 * Cleans a stylesheet or an inline `style`: drops @import, IE-only script hooks, `javascript:`
 * and non-image `data:` URLs. Everything else — selectors, declarations, media queries,
 * `@font-face` — is kept as written.
 */
export function sanitizeCss(css: string): string {
  let out = css
    .replace(/<!--|-->/g, '')
    .replace(/@import\b[^;{}]*(?:;|(?=\}|$))/gi, '')
    .replace(/expression\s*\(/gi, 'blocked(')
    .replace(/(behavior|-moz-binding)\s*:/gi, 'x-$1:')
    .replace(/(?:java|vb|live)script\s*:/gi, 'blocked:');
  out = out.replace(
    CSS_URL,
    (whole, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
      const raw = dq ?? sq ?? bare ?? '';
      return isSafeUrl(unescapeCss(raw), { allowDataImage: true }) ? whole : 'url("")';
    },
  );
  return out;
}

/** The `css` field of a snapshot: cleaned and safe to place inside a `<style>` element. */
export const sanitizeStylesheet = (css: string): string => neutralizeCssForHtml(sanitizeCss(css));

/** The value of a `style` attribute, cleaned (entities decoded for the check, then escaped again). */
function sanitizeStyleAttr(raw: string): string {
  const cleaned = sanitizeCss(decodeEntities(raw));
  return cleaned.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function sanitizeElement(el: HtmlElement): HtmlElement | null {
  if (DROPPED_TAGS.has(el.tag)) return null;
  // <input type="image"> is a picture button: its src follows the picture rules
  const attrs: HtmlElement['attrs'] = [];
  for (const attr of el.attrs) {
    const { name } = attr;
    if (name.startsWith('on') || DROPPED_ATTRS.has(name)) continue;
    if (name === 'style') {
      attrs.push({ name, value: sanitizeStyleAttr(attr.value ?? '') });
      continue;
    }
    if (URL_ATTRS.has(name) || name.endsWith(':href')) {
      const value = attr.value ?? '';
      const allowDataImage = DATA_IMAGE_ATTRS.has(name);
      if (!isSafeUrl(value, { allowDataImage })) continue;
      // <use href> may only point at the same document
      if (el.tag === 'use' && !value.trim().startsWith('#')) continue;
      attrs.push(attr);
      continue;
    }
    attrs.push(attr);
  }
  return { type: 'element', tag: el.tag, attrs, children: sanitizeNodes(el.children) };
}

function sanitizeNodes(nodes: readonly HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') out.push(node);
    else if (node.type === 'css') out.push({ type: 'css', css: sanitizeCss(node.css) });
    else {
      const clean = sanitizeElement(node);
      if (clean) out.push(clean);
    }
  }
  return out;
}

/** Parses, cleans and re-serializes `html`. Idempotent. */
export function sanitizeHtml(html: string): string {
  return serializeNodes(sanitizeNodes(parseHtml(html)));
}

/** Tree form of {@link sanitizeHtml}, for callers that go on to transform the tree. */
export function sanitizeTree(html: string): HtmlNode[] {
  return sanitizeNodes(parseHtml(html));
}
