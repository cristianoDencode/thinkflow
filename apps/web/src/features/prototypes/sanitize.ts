/*
 * The HTML/CSS of a prototype comes from the server (captured from a third-party page, or pasted
 * by the user): it is untrusted. Before it reaches the editor canvas it is reduced to inert
 * markup: no scripts, no inline event handlers, no frames/embeds, no external stylesheets, no
 * `javascript:` URLs. The editor itself also runs with `allowScripts: false`.
 */

const DROP_TAGS =
  'script, iframe, frame, frameset, object, embed, applet, base, link, meta, noscript';
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster'];

const hasScriptScheme = (value: string) =>
  // eslint-disable-next-line no-control-regex
  /^(javascript|vbscript):/i.test(value.replace(/[\u0000- \u007f]+/g, ''));

export function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/url\(\s*(['"]?)\s*(javascript|vbscript):[^)]*\)/gi, 'none')
    .replace(/behavior\s*:[^;}]*/gi, '')
    .replace(/-moz-binding\s*:[^;}]*/gi, '');
}

export interface PreparedSnapshot {
  html: string;
  css: string;
}

/** Removes unsafe attributes of one element, in place. */
function cleanAttributes(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on') || name === 'srcdoc') el.removeAttribute(attr.name);
    else if (URL_ATTRS.includes(name) && hasScriptScheme(attr.value)) el.removeAttribute(attr.name);
    else if (name === 'style' && /expression\s*\(|javascript:/i.test(attr.value))
      el.setAttribute(attr.name, sanitizeCss(attr.value));
  }
}

/**
 * Turns an untrusted HTML document/fragment + CSS into inert markup. The result `html` is a
 * complete `<body …>…</body>` element (the server's format); `<style>` tags and the body's inline
 * style/bgcolor are folded into the css.
 */
export function prepareSnapshot(html: string, css: string): PreparedSnapshot {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  let styles = css;
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    styles += `\n${style.textContent ?? ''}`;
    style.remove();
  }
  const bodyStyle = doc.body.getAttribute('style');
  if (bodyStyle) styles += `\nbody{${bodyStyle}}`;
  doc.body.removeAttribute('style');
  const bodyBg = doc.body.getAttribute('bgcolor');
  if (bodyBg && /^#?[0-9a-z]+$/i.test(bodyBg)) {
    styles += `\nbody{background-color:${/^[0-9a-f]{6}$/i.test(bodyBg) ? `#${bodyBg}` : bodyBg}}`;
  }
  doc.body.removeAttribute('bgcolor');

  for (const el of Array.from(doc.body.querySelectorAll(DROP_TAGS))) el.remove();
  cleanAttributes(doc.body);
  for (const el of Array.from(doc.body.querySelectorAll('*'))) cleanAttributes(el);
  return { html: doc.body.outerHTML, css: sanitizeCss(styles).trim() };
}

/** The content and the attributes of a `<body …>…</body>` element. */
export function splitBody(html: string): { inner: string; attrs: Record<string, string> } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(doc.body.attributes)) attrs[attr.name] = attr.value;
  return { inner: doc.body.innerHTML.trim(), attrs };
}
