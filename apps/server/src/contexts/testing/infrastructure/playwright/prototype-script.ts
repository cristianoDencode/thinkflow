import { FRAME_ATTR } from '../../domain/frame-css';
import { TOOLBAR_HOST_ID } from './recorder-script';

/**
 * Serializer of "the current screen" for the prototypes. Runs inside the frame being captured
 * (`frame.evaluate`), as a plain JavaScript expression in a string — like RECORDER_SCRIPT, so no
 * bundler helper (`__name`…) can end up inside the page.
 *
 * It clones the document and turns the clone into a standalone snapshot of what is on screen:
 *  - form state becomes attributes (`value`, `checked`, `selected`, textarea text);
 *  - same-origin pictures (`<img>`, `<input type=image>`, `<canvas>`, CSS `url()`) become `data:` URIs;
 *  - what is not on screen (`display:none`, `visibility:hidden`, empty zero-size boxes such as hidden
 *    loaders and overlays) is left out;
 *  - styles are collected from the CSSOM (`document.styleSheets`) and pruned per document: only the
 *    rules whose selector matches an element of the captured subtree stay (pseudo-classes and
 *    -elements are ignored when testing), `@font-face` only when its family is used and
 *    `@keyframes` only when referenced; sheets the page may not read (cross-origin) are reported by
 *    address so the server can download them with the same cookies;
 *  - scripts, styles, links, `<base>`, `<meta http-equiv>` and the recorder toolbar are removed;
 *  - every same-origin iframe (depth ≤ 4) is flattened: it becomes a `<div data-tf-frame="n">` with
 *    the iframe's exact box (position, size, margins, display…) holding the child's body content,
 *    and its stylesheets come back apart (`frames`) so the server can scope them to that div. Frames
 *    of another origin (the page may not read them) stay empty boxes of the same size.
 * `ROOT` (an element handle of the frame the expression runs in) limits the capture to that
 * element: it is placed at 0,0 of a body the size of the element, inside copies of its ancestors
 * (so selectors that depend on them still match) — used for a window whose title bar lives in the
 * page around its iframe. It never mutates the live page. The caller sanitizes (and, by default,
 * scrubs) the result.
 */
export interface PrototypeSerializerOptions {
  /** A single picture bigger than this stays an address instead of a `data:` URI. */
  maxImageBytes: number;
  /** All inlined pictures together. */
  maxTotalImageBytes: number;
  /** How deep nested frames are flattened (the page itself is depth 0). */
  maxFrameDepth: number;
  /** Frames flattened in all; the rest become empty boxes. */
  maxFrames: number;
}

export type RawCssPart = { css: string } | { href: string; media: string };

/** What the page returns; `parts` keep the cascade order of the styles. */
export interface RawPrototypeSnapshot {
  /** `<body>…</body>` of the clone. */
  html: string;
  /** Styles of the captured document itself (not scoped). */
  parts: RawCssPart[];
  /** The document is in quirks mode (`BackCompat`). */
  quirks: boolean;
  /** Styles of each flattened frame (to be scoped to `div[data-tf-frame=id]`). */
  frames: {
    id: number;
    /** 0 = the captured document itself */ parent: number;
    quirks: boolean;
    parts: RawCssPart[];
  }[];
  /** Frames inlined / left as empty boxes (another origin, too deep, too many). */
  flattened: number;
  blankFrames: number;
  width: number;
  height: number;
  title: string;
  url: string;
}

export const prototypeSerializerDefaults = { maxFrameDepth: 4, maxFrames: 40 } as const;

/** A function expression `(root) => …`; call it with an element handle to capture just that element. */
export function prototypeSerializerOnElement(options: PrototypeSerializerOptions): string {
  return `(el) => (${SERIALIZER})(${JSON.stringify({ ...options, hostId: TOOLBAR_HOST_ID, frameAttr: FRAME_ATTR })}, el)`;
}

export function prototypeSerializerExpression(options: PrototypeSerializerOptions): string {
  return `(${SERIALIZER})(${JSON.stringify({ ...options, hostId: TOOLBAR_HOST_ID, frameAttr: FRAME_ATTR })}, null)`;
}

const SERIALIZER = String.raw`async (OPTS, ROOT) => {
  const topDoc = document;
  const FRAME_ATTR = OPTS.frameAttr;
  const origin = location.origin;
  const abs = (u, base) => { try { return new URL(u, base || topDoc.baseURI).href; } catch (e) { return u; } };

  // ---- pictures -> data URIs (same origin only; bounded; shared by every frame) ----
  const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif' };
  let total = 0;
  let running = 0;
  const waiting = [];
  const slot = async () => {
    if (running >= 8) await new Promise((r) => waiting.push(r));
    running++;
  };
  const release = () => { running--; const next = waiting.shift(); if (next) next(); };
  const cache = new Map();
  function toDataUri(url) {
    if (cache.has(url)) return cache.get(url);
    const task = (async () => {
      await slot();
      try {
        const u = new URL(url, topDoc.baseURI);
        if (u.origin !== origin) return null;
        const res = await fetch(u.href, { credentials: 'include' });
        if (!res.ok) return null;
        let blob = await res.blob();
        if (!blob.type || !blob.type.startsWith('image/')) {
          const ext = (u.pathname.split('.').pop() || '').toLowerCase();
          if (!TYPES[ext]) return null;
          blob = new Blob([blob], { type: TYPES[ext] });
        }
        if (blob.size > OPTS.maxImageBytes || total + blob.size > OPTS.maxTotalImageBytes) return null;
        total += blob.size;
        return await new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
          fr.onerror = () => resolve(null);
          fr.readAsDataURL(blob);
        });
      } catch (e) {
        return null;
      } finally {
        release();
      }
    })();
    cache.set(url, task);
    return task;
  }

  const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi;
  const FONT = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
  /** Makes every url() absolute (against the stylesheet) and inlines the pictures it can. */
  async function rewriteCssUrls(css, base) {
    const found = new Map();
    css.replace(CSS_URL, (whole, dq, sq, bare) => {
      const u = dq !== undefined ? dq : sq !== undefined ? sq : bare;
      if (u && !found.has(whole)) found.set(whole, u.trim());
      return whole;
    });
    await Promise.all(Array.from(found.entries()).map(async ([whole, u]) => {
      if (/^(data:|#|about:|blob:)/i.test(u)) { found.set(whole, whole); return; }
      const a = abs(u, base);
      const data = FONT.test(a) ? null : await toDataUri(a);
      found.set(whole, 'url("' + (data || a).replace(/"/g, '%22') + '")');
    }));
    return css.replace(CSS_URL, (whole) => found.get(whole) || whole);
  }

  // ---- frames ----
  const frames = [];
  const stats = { flattened: 0, blank: 0 };
  let nextFrame = 0;

  const blank = (doc, b, a) => {
    const box = doc.createElement('div');
    box.setAttribute('data-tf-blank', '1');
    if (b.id) box.id = b.id;
    if (b.className && typeof b.className === 'string') box.className = b.className;
    box.setAttribute('style', (a.getAttribute('style') || '') + ';display:inline-block;box-sizing:border-box;width:' + Math.round(a.offsetWidth) + 'px;height:' + Math.round(a.offsetHeight) + 'px;background:#f5f5f5;border:1px dashed #bbb');
    return box;
  };

  /** The layout of an <iframe> in its parent, kept on the div that replaces it. */
  function frameBoxStyle(cs, a) {
    const css = [];
    const add = (p, v) => { if (v !== undefined && v !== null && v !== '') css.push(p + ':' + v); };
    add('display', cs.display === 'inline' ? 'inline-block' : cs.display);
    if (cs.position !== 'static') {
      add('position', cs.position);
      for (const side of ['top', 'right', 'bottom', 'left']) { const v = cs[side]; if (v && v !== 'auto') add(side, v); }
    }
    add('box-sizing', 'border-box');
    add('width', Math.round(a.offsetWidth) + 'px');
    add('height', Math.round(a.offsetHeight) + 'px');
    add('margin', cs.marginTop + ' ' + cs.marginRight + ' ' + cs.marginBottom + ' ' + cs.marginLeft);
    if (cs.cssFloat && cs.cssFloat !== 'none') add('float', cs.cssFloat);
    if (cs.verticalAlign && cs.verticalAlign !== 'baseline') add('vertical-align', cs.verticalAlign);
    if (cs.zIndex && cs.zIndex !== 'auto') add('z-index', cs.zIndex);
    if (cs.transform && cs.transform !== 'none') add('transform', cs.transform);
    if (cs.opacity && cs.opacity !== '1') add('opacity', cs.opacity);
    if (cs.visibility && cs.visibility !== 'visible') add('visibility', cs.visibility);
    if (cs.flexGrow && cs.flexGrow !== '0') add('flex-grow', cs.flexGrow);
    if (cs.flexShrink && cs.flexShrink !== '1') add('flex-shrink', cs.flexShrink);
    if (cs.flexBasis && cs.flexBasis !== 'auto') add('flex-basis', cs.flexBasis);
    if (cs.alignSelf && cs.alignSelf !== 'auto') add('align-self', cs.alignSelf);
    if (cs.order && cs.order !== '0') add('order', cs.order);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const style = cs['border' + side + 'Style'];
      const width = cs['border' + side + 'Width'];
      if (style && style !== 'none' && parseFloat(width) > 0) add('border-' + side.toLowerCase(), width + ' ' + style + ' ' + cs['border' + side + 'Color']);
    }
    add('overflow', 'hidden');
    return css.join(';');
  }

  const transparent = (c) => !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';

  /** The child document's body content goes inside the div; its box gets what the body/canvas had. */
  async function fillFrame(box, childDoc, id, depth, parentId) {
    const r = await serializeDoc(childDoc, depth, null, id);
    const body = r.clone.querySelector('body');
    const view = childDoc.defaultView;
    if (body && childDoc.body && childDoc.body.tagName === 'BODY') {
      const bcs = view.getComputedStyle(childDoc.body);
      const hcs = view.getComputedStyle(childDoc.documentElement);
      const extra = [];
      // the canvas shows the root's background, or else the body's
      const bgFrom = !transparent(hcs.backgroundColor) || hcs.backgroundImage !== 'none' ? hcs : bcs;
      if (!transparent(bgFrom.backgroundColor)) extra.push('background-color:' + bgFrom.backgroundColor);
      if (bgFrom.backgroundImage && bgFrom.backgroundImage !== 'none') {
        extra.push('background-image:' + bgFrom.backgroundImage, 'background-repeat:' + bgFrom.backgroundRepeat, 'background-position:' + bgFrom.backgroundPosition, 'background-size:' + bgFrom.backgroundSize);
      }
      // the editor saves components without the page's body/html rules: the base text style lives on the div too
      for (const prop of ['color', 'font-family', 'font-size', 'font-style', 'font-weight', 'line-height', 'text-align']) {
        const v = bcs.getPropertyValue(prop);
        if (v && v !== 'normal' && v !== 'start') extra.push(prop + ':' + v);
      }
      // the body's margin (8px by default) is the frame's inner space; its padding adds to it
      const space = (side) => (parseFloat(bcs['margin' + side]) || 0) + (parseFloat(bcs['padding' + side]) || 0);
      extra.push('padding:' + space('Top') + 'px ' + space('Right') + 'px ' + space('Bottom') + 'px ' + space('Left') + 'px');
      const own = (body.getAttribute('style') || '').replace(/(?:^|;)\s*(?:margin|padding|position|display|width|height|top|left|right|bottom|float|overflow)[a-z-]*\s*:[^;]*/gi, '');
      const css = await rewriteCssUrls(own + ';' + (box.getAttribute('style') || '') + ';' + extra.join(';'), childDoc.baseURI);
      box.setAttribute('style', css);
      const cls = body.getAttribute('class');
      if (cls) box.setAttribute('class', cls);
      while (body.firstChild) box.appendChild(body.firstChild);
    }
    frames.push({ id, parent: parentId, quirks: r.quirks, parts: r.parts });
  }

  // ---- one document (the page, or a flattened frame) ----
  const KEEP_BOX = { OPTION: 1, OPTGROUP: 1, BR: 1, WBR: 1, AREA: 1, MAP: 1, SOURCE: 1, TRACK: 1, PARAM: 1, COL: 1, COLGROUP: 1, TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, TR: 1, TD: 1, TH: 1, CAPTION: 1, HTML: 1, BODY: 1, HEAD: 1 };
  const DYNAMIC = /::?(?:before|after|first-line|first-letter|selection|placeholder|backdrop|marker|file-selector-button|-(?:webkit|moz|ms|o)-[\w-]+|[\w-]*scrollbar[\w-]*|hover|focus(?:-within|-visible)?|active|visited|link|any-link|target)(?:\([^)]*\))?/gi;
  const sizedInside = (el) => {
    for (const d of Array.from(el.querySelectorAll('*'))) if (!(d.offsetWidth === 0 && d.offsetHeight === 0)) return true;
    return false;
  };
  /** Splits a selector list at the commas outside parentheses, brackets and strings. */
  function splitSelectors(text) {
    const out = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let p = 0; p < text.length; p++) {
      const c = text[p];
      if (quote) { if (c === '\\') p++; else if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '\\') p++;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
      else if (c === ',' && depth === 0) { out.push(text.slice(start, p)); start = p + 1; }
    }
    out.push(text.slice(start));
    return out.map((x) => x.trim()).filter(Boolean);
  }

  async function serializeDoc(doc, depth, rootEl, ownerId) {
    const view = doc.defaultView;
    const base = doc.baseURI;
    const node0 = rootEl || doc.documentElement;
    const live = [node0].concat(Array.from(node0.querySelectorAll('*')));

    // what is on screen: hidden and empty zero-size elements go (with everything inside them)
    const gone = new Set();
    const families = new Set();
    const addFamilies = (list) => {
      for (const f of String(list || '').split(',')) {
        const n = f.trim().replace(/^["']|["']$/g, '').toLowerCase();
        if (n) families.add(n);
      }
    };
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      if (i > 0 && gone.has(a.parentElement)) { gone.add(a); continue; }
      let cs = null;
      try { cs = view.getComputedStyle(a); } catch (e) { cs = null; }
      if (!cs) continue;
      if (i > 0) {
        if (cs.display === 'none' || (cs.visibility === 'hidden' && !KEEP_BOX[a.tagName])) { gone.add(a); continue; }
        if (!KEEP_BOX[a.tagName] && cs.display !== 'contents' && a.offsetWidth === 0 && a.offsetHeight === 0 && !(a.textContent || '').trim() && !sizedInside(a)) { gone.add(a); continue; }
      }
      addFamilies(cs.fontFamily);
    }

    // styles, in cascade order, pruned to what the captured elements use. 2: the selector matches
    // something captured; 1: only an ancestor of the captured element (outside the snapshot)
    const ancestors = [];
    for (let e = node0.parentElement; e; e = e.parentElement) ancestors.push(e);
    const verdicts = new Map();
    const selectorUsed = (sel) => {
      if (verdicts.has(sel)) return verdicts.get(sel);
      let uncertain = false;
      const tested = sel.replace(DYNAMIC, (m, off) => {
        const prev = off > 0 ? sel[off - 1] : '';
        if (prev === '(') uncertain = true;
        return prev === '' || prev === ' ' || prev === '>' || prev === '+' || prev === '~' || prev === '(' || prev === ',' ? '*' : '';
      });
      let used = 0;
      if (uncertain) used = 2;
      else {
        try {
          if (node0.matches(tested)) used = 2;
          else {
            const first = node0.querySelector(tested);
            if (first && (!gone.has(first) || Array.from(node0.querySelectorAll(tested)).some((e) => !gone.has(e)))) used = 2;
          }
          if (!used && ancestors.some((e) => e.matches(tested))) used = 1;
        } catch (e) {
          used = /-(?:moz|ms|o)-/i.test(sel) ? 0 : 2; // a selector this browser cannot parse: keep unless vendor-specific
        }
      }
      verdicts.set(sel, used);
      return used;
    };
    // what an element outside the snapshot still gives the captured one: inherited properties
    const INHERITED = /^(?:--|color$|font|line-height$|letter-spacing$|word-spacing$|text-(?:align|indent|transform|shadow|rendering)|white-space$|direction$|visibility$|cursor$|list-style|quotes$|border-(?:collapse|spacing)$|empty-cells$|caption-side$)/;
    const inheritedDeclarations = (style) => {
      const out = [];
      for (let k = 0; k < style.length; k++) {
        const prop = style[k];
        if (INHERITED.test(prop)) out.push(prop + ': ' + style.getPropertyValue(prop) + (style.getPropertyPriority(prop) ? ' !important' : '') + ';');
      }
      return out.join(' ');
    };

    const items = [];
    /** Appends the rules worth keeping to sink as { base, text } (font-face / keyframes carry their name). */
    function pruneRules(rules, sheetBase, sink) {
      for (const rule of Array.from(rules)) {
        const type = rule.type;
        if (type === 1) {
          const selectors = splitSelectors(rule.selectorText || '');
          const used = selectors.filter((sel) => selectorUsed(sel) === 2);
          const outside = selectors.filter((sel) => selectorUsed(sel) === 1);
          if (used.length > 0) {
            if (used.length === selectors.length || (rule.cssRules && rule.cssRules.length)) sink.push({ base: sheetBase, text: rule.cssText });
            else if (rule.style.cssText) sink.push({ base: sheetBase, text: used.join(', ') + ' { ' + rule.style.cssText + ' }' });
          }
          if (outside.length > 0) {
            const inherited = inheritedDeclarations(rule.style);
            if (inherited) sink.push({ base: sheetBase, text: outside.join(', ') + ' { ' + inherited + ' }' });
          }
        } else if (type === 4 || type === 12 || (type === 0 && rule.cssRules && /^@(?:container|layer)\b/.test(rule.cssText))) {
          let head;
          if (type === 4) {
            const cond = rule.media.mediaText;
            if (/\bprint\b/i.test(cond) && !/\b(?:screen|all)\b/i.test(cond)) continue; // never on screen
            head = '@media ' + cond;
          } else if (type === 12) head = '@supports ' + rule.conditionText;
          else head = rule.cssText.slice(0, rule.cssText.indexOf('{')).trim();
          const inner = [];
          pruneRules(rule.cssRules, sheetBase, inner);
          if (inner.length) sink.push({ base: sheetBase, text: head + ' {\n' + inner.map((x) => x.text).join('\n') + '\n}' });
        } else if (type === 5) {
          sink.push({ base: sheetBase, text: rule.cssText, font: String(rule.style.getPropertyValue('font-family') || '').replace(/^["']|["']$/g, '').trim().toLowerCase() });
        } else if (type === 7) {
          sink.push({ base: sheetBase, text: rule.cssText, keyframes: String(rule.name || '').toLowerCase() });
        } else if (type === 6 || type === 10 || type === 3) {
          continue; // @page, @namespace, @import (followed apart)
        } else {
          sink.push({ base: sheetBase, text: rule.cssText });
        }
      }
    }
    async function addSheet(sheet, level) {
      if (!sheet || sheet.disabled || level > 4) return;
      const media = sheet.media && sheet.media.mediaText ? sheet.media.mediaText : '';
      if (media) { try { if (!view.matchMedia(media).matches) return; } catch (e) { /* keep it */ } }
      let rules;
      try { rules = sheet.cssRules; } catch (e) { rules = null; }
      const sheetBase = sheet.href || base;
      if (!rules) {
        if (sheet.href) items.push({ href: sheet.href, media });
        return;
      }
      for (const rule of Array.from(rules)) {
        if (rule.type === 3) await addSheet(rule.styleSheet, level + 1); // @import
        else pruneRules([rule], sheetBase, items);
      }
    }
    for (const sheet of Array.from(doc.styleSheets)) await addSheet(sheet, 0);
    try {
      for (const sheet of Array.from(doc.adoptedStyleSheets || [])) await addSheet(sheet, 0);
    } catch (e) { /* not supported */ }

    // fonts and animations nobody uses go; the rest is grouped by stylesheet address and its url()s rewritten
    const usedText = items.filter((it) => it.text && !it.font && !it.keyframes).map((it) => it.text).join('\n').toLowerCase();
    const parts = [];
    const slots = [];
    let group = null;
    for (const it of items) {
      if (it.font !== undefined && (!it.font || (!families.has(it.font) && usedText.indexOf(it.font) === -1))) continue;
      if (it.keyframes !== undefined && (!it.keyframes || usedText.indexOf(it.keyframes) === -1)) continue;
      if (it.href !== undefined) { group = null; slots.push({ part: { href: it.href, media: it.media } }); continue; }
      if (group && group.base === it.base) group.text += '\n' + it.text;
      else { group = { base: it.base, text: it.text }; slots.push({ group }); }
    }
    for (const slot of slots) {
      if (slot.group) slot.promise = rewriteCssUrls(slot.group.text, slot.group.base).then((css) => ({ css }));
    }
    for (const slot of slots) {
      const part = slot.part || (await slot.promise);
      if (part.css === undefined || part.css.trim()) parts.push(part);
    }

    // the document, as it is on screen
    const clone = node0.cloneNode(true);
    const copy = [clone].concat(Array.from(clone.querySelectorAll('*')));
    const drop = [];
    const jobs = [];

    for (let i = 0; i < live.length && i < copy.length; i++) {
      const a = live[i];
      const b = copy[i];
      const tag = a.tagName;
      if (gone.has(a)) { if (!gone.has(a.parentElement)) drop.push(b); continue; }
      if (a.id === OPTS.hostId) { drop.push(b); continue; }
      if (tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'BASE' || tag === 'TEMPLATE') { drop.push(b); continue; }
      if (tag === 'META') { if (a.getAttribute('http-equiv')) drop.push(b); continue; }
      if (tag === 'IFRAME' || tag === 'FRAME') {
        if (!b.parentNode) continue;
        const cs = view.getComputedStyle(a);
        if (cs.display === 'none' || a.offsetWidth < 1 || a.offsetHeight < 1) { drop.push(b); continue; }
        let child = null;
        try { child = a.contentDocument; } catch (e) { child = null; }
        if (child && child.documentElement && depth < OPTS.maxFrameDepth && nextFrame < OPTS.maxFrames) {
          const id = ++nextFrame;
          const box = doc.createElement('div');
          box.setAttribute(FRAME_ATTR, String(id));
          if (a.title) box.setAttribute('title', a.title);
          box.setAttribute('style', frameBoxStyle(cs, a));
          b.parentNode.replaceChild(box, b);
          stats.flattened++;
          jobs.push(fillFrame(box, child, id, depth + 1, ownerId));
        } else {
          b.parentNode.replaceChild(blank(doc, b, a), b);
          stats.blank++;
        }
        continue;
      }
      if (tag === 'OBJECT' || tag === 'EMBED') {
        if (b.parentNode) b.parentNode.replaceChild(blank(doc, b, a), b);
        continue;
      }
      if (tag === 'INPUT') {
        const type = (a.type || 'text').toLowerCase();
        if (type === 'password' || type === 'file') b.removeAttribute('value');
        else if (type === 'checkbox' || type === 'radio') {
          if (a.checked) b.setAttribute('checked', ''); else b.removeAttribute('checked');
        } else if (type === 'image') {
          const src = a.src;
          if (src) jobs.push(toDataUri(src).then((d) => b.setAttribute('src', d || abs(src, base))));
        } else if (type !== 'submit' && type !== 'button' && type !== 'reset') {
          if (a.value) b.setAttribute('value', a.value); else b.removeAttribute('value');
        }
      } else if (tag === 'TEXTAREA') {
        b.textContent = a.value;
      } else if (tag === 'OPTION') {
        if (a.selected) b.setAttribute('selected', ''); else b.removeAttribute('selected');
      } else if (tag === 'IMG') {
        const src = a.currentSrc || a.src;
        b.removeAttribute('srcset');
        b.removeAttribute('sizes');
        b.removeAttribute('loading');
        if (src) jobs.push(toDataUri(src).then((d) => b.setAttribute('src', d || abs(src, base))));
      } else if (tag === 'CANVAS') {
        try {
          const img = doc.createElement('img');
          img.setAttribute('src', a.toDataURL('image/png'));
          img.setAttribute('width', String(a.width));
          img.setAttribute('height', String(a.height));
          if (b.parentNode) b.parentNode.replaceChild(img, b);
        } catch (e) { /* tainted canvas: left empty */ }
      }
      const style = b.getAttribute && b.getAttribute('style');
      if (style && style.indexOf('url(') !== -1) {
        jobs.push(rewriteCssUrls(style, base).then((s) => b.setAttribute('style', s)));
      }
      const bg = b.getAttribute && b.getAttribute('background');
      if (bg) jobs.push(toDataUri(abs(bg, base)).then((d) => b.setAttribute('background', d || abs(bg, base))));
    }
    await Promise.all(jobs);
    for (const node of drop) if (node.parentNode) node.parentNode.removeChild(node);
    return { clone, parts, quirks: doc.compatMode === 'BackCompat' };
  }

  // ---- the captured document ----
  const top = await serializeDoc(topDoc, 0, ROOT || null, 0);
  let html;
  let width = Math.round(window.innerWidth) || 0;
  let height = Math.round(window.innerHeight) || 0;
  if (!ROOT) {
    const body = top.clone.querySelector('body');
    html = body ? body.outerHTML : '<body></body>';
  } else {
    // just the element: at 0,0 of a body of its size, inside copies of its ancestors
    width = Math.round(ROOT.offsetWidth) || 0;
    height = Math.round(ROOT.offsetHeight) || 0;
    const box = ';box-sizing:border-box;width:' + width + 'px;height:' + height + 'px';
    top.clone.setAttribute('style', (top.clone.getAttribute('style') || '') + ';position:absolute;left:0;top:0;right:auto;bottom:auto;margin:0;float:none;transform:none;z-index:auto' + box);
    let wrapped = top.clone;
    const WRAPPERS = { DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, ASIDE: 1, HEADER: 1, FOOTER: 1, NAV: 1, CENTER: 1, FORM: 1 };
    const RESET = 'display:block;position:static;margin:0;padding:0;border:0;width:auto;height:auto;min-width:0;min-height:0;max-width:none;max-height:none;overflow:visible;float:none;transform:none;background:none;box-shadow:none;opacity:1';
    for (let p = ROOT.parentElement; p && p !== topDoc.body && p !== topDoc.documentElement; p = p.parentElement) {
      const w = topDoc.createElement(WRAPPERS[p.tagName] ? p.tagName : 'div');
      for (const attr of Array.from(p.attributes)) {
        if (attr.name === 'style' || attr.name.startsWith('on')) continue;
        try { w.setAttribute(attr.name, attr.value); } catch (e) { /* invalid name */ }
      }
      w.setAttribute('style', RESET);
      w.appendChild(wrapped);
      wrapped = w;
    }
    const bodyEl = topDoc.createElement('body');
    for (const attr of Array.from(topDoc.body.attributes)) {
      if (attr.name === 'style' || attr.name.startsWith('on')) continue;
      try { bodyEl.setAttribute(attr.name, attr.value); } catch (e) { /* invalid name */ }
    }
    const ownStyle = (topDoc.body.getAttribute('style') || '').replace(/(?:^|;)\s*(?:margin|padding|position|width|height|overflow)[a-z-]*\s*:[^;]*/gi, '');
    bodyEl.setAttribute('style', ownStyle + ';margin:0;padding:0;position:relative;overflow:hidden' + box);
    bodyEl.appendChild(wrapped);
    html = bodyEl.outerHTML;
  }

  return {
    html,
    parts: top.parts,
    quirks: top.quirks,
    frames: frames.sort((x, y) => x.id - y.id),
    flattened: stats.flattened,
    blankFrames: stats.blank,
    width,
    height,
    title: topDoc.title || '',
    url: location.href,
  };
}`;
