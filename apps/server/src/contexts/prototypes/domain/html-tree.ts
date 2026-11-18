/**
 * A tiny, dependency-free HTML tokenizer + tree + serializer, enough to sanitize and scrub the
 * HTML of screen prototypes (the domain may not use npm parsers). It is not a spec-complete HTML5
 * parser: it targets the well-formed markup a browser serializes (`outerHTML`) and tolerates
 * sloppy pasted markup by nesting what it cannot close. Whatever it does not understand is
 * dropped, never passed through, and the serializer re-escapes everything it writes.
 */

export interface HtmlAttr {
  /** Lower-case. */
  name: string;
  /** Raw value as written (entities not decoded); null for boolean attributes. */
  value: string | null;
}

export interface HtmlElement {
  type: 'element';
  /** Lower-case. */
  tag: string;
  attrs: HtmlAttr[];
  children: HtmlNode[];
}

/** Text between tags, as written (entities not decoded). */
export interface HtmlText {
  type: 'text';
  text: string;
}

/** Content of a `<style>` element. */
export interface HtmlCss {
  type: 'css';
  css: string;
}

export type HtmlNode = HtmlElement | HtmlText | HtmlCss;

export const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Elements whose content is not markup: it is read up to the matching end tag. */
const RAW_TEXT_TAGS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
]);

const MAX_DEPTH = 400;
const ATTR_NAME = /^[a-z_:][-a-z0-9_:.]*$/;
const TAG_NAME = /^[a-z][a-z0-9:_-]*$/;

/** Opening one of these closes an open one of the listed tags (omitted end tags). */
const AUTO_CLOSE: Record<string, { closes: string[]; stopAt: string[] }> = {
  tr: { closes: ['tr', 'td', 'th'], stopAt: ['table', 'thead', 'tbody', 'tfoot'] },
  td: { closes: ['td', 'th'], stopAt: ['tr', 'table'] },
  th: { closes: ['td', 'th'], stopAt: ['tr', 'table'] },
  thead: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], stopAt: ['table'] },
  tbody: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], stopAt: ['table'] },
  tfoot: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], stopAt: ['table'] },
  li: { closes: ['li'], stopAt: ['ul', 'ol', 'menu'] },
  option: { closes: ['option'], stopAt: ['select', 'datalist', 'optgroup'] },
  dt: { closes: ['dt', 'dd'], stopAt: ['dl'] },
  dd: { closes: ['dt', 'dd'], stopAt: ['dl'] },
};

const isSpace = (c: string): boolean =>
  c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isAlpha = (c: string | undefined): boolean => !!c && /[a-zA-Z]/.test(c);

interface OpenTag {
  tag: string;
  attrs: HtmlAttr[];
  selfClosing: boolean;
  end: number;
}

/** Reads a start tag at `i` (`html[i] === '<'` followed by a letter); null when unterminated. */
function readStartTag(html: string, i: number): OpenTag | null {
  let p = i + 1;
  let name = '';
  while (p < html.length && !isSpace(html[p]!) && html[p] !== '/' && html[p] !== '>') {
    name += html[p];
    p++;
  }
  const attrs: HtmlAttr[] = [];
  let selfClosing = false;
  for (;;) {
    while (p < html.length && (isSpace(html[p]!) || html[p] === '/')) {
      if (html[p] === '/' && html[p + 1] === '>') selfClosing = true;
      p++;
    }
    if (p >= html.length) return null;
    if (html[p] === '>') {
      return { tag: name.toLowerCase(), attrs, selfClosing, end: p + 1 };
    }
    let attrName = '';
    while (
      p < html.length &&
      !isSpace(html[p]!) &&
      html[p] !== '=' &&
      html[p] !== '>' &&
      !(html[p] === '/' && html[p + 1] === '>')
    ) {
      attrName += html[p];
      p++;
    }
    while (p < html.length && isSpace(html[p]!)) p++;
    let value: string | null = null;
    if (html[p] === '=') {
      p++;
      while (p < html.length && isSpace(html[p]!)) p++;
      const quote = html[p];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, p + 1);
        if (close === -1) return null;
        value = html.slice(p + 1, close);
        p = close + 1;
      } else {
        let v = '';
        while (p < html.length && !isSpace(html[p]!) && html[p] !== '>') {
          v += html[p];
          p++;
        }
        value = v;
      }
    }
    const lower = attrName.toLowerCase();
    // invalid names are consumed and dropped; the first of a repeated attribute wins
    if (ATTR_NAME.test(lower) && !attrs.some((a) => a.name === lower)) {
      attrs.push({ name: lower, value });
    }
  }
}

/** Parses `html` into a forest of nodes. Comments, doctypes and processing instructions are dropped. */
export function parseHtml(html: string): HtmlNode[] {
  const root: HtmlElement = { type: 'element', tag: '#root', attrs: [], children: [] };
  const stack: HtmlElement[] = [root];
  let foreign = 0; // open <svg>/<math> ancestors
  const top = () => stack[stack.length - 1]!;
  const pushText = (text: string) => {
    if (!text) return;
    const last = top().children.at(-1);
    if (last?.type === 'text') last.text += text;
    else top().children.push({ type: 'text', text });
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));
    const next = html[lt + 1];
    // comment / CDATA / doctype / bogus comment: dropped
    if (next === '!' || next === '?') {
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4);
        i = close === -1 ? html.length : close + 3;
      } else {
        const close = html.indexOf('>', lt + 2);
        i = close === -1 ? html.length : close + 1;
      }
      continue;
    }
    if (next === '/') {
      const m = /^<\/([a-zA-Z][^\s/>]*)[^>]*>?/.exec(html.slice(lt, lt + 300));
      if (!m) {
        // "</" not followed by a name: bogus comment up to ">"
        const close = html.indexOf('>', lt + 2);
        i = close === -1 ? html.length : close + 1;
        continue;
      }
      const name = m[1]!.toLowerCase();
      let depth = stack.length - 1;
      while (depth > 0 && stack[depth]!.tag !== name) depth--;
      if (depth > 0) {
        for (let k = stack.length - 1; k >= depth; k--) {
          const closed = stack.pop()!;
          if (closed.tag === 'svg' || closed.tag === 'math') foreign--;
        }
      }
      i = lt + m[0].length;
      continue;
    }
    if (!isAlpha(next)) {
      pushText('<');
      i = lt + 1;
      continue;
    }
    const open = readStartTag(html, lt);
    if (!open) {
      break; // unterminated tag at EOF: dropped
    }
    i = open.end;
    if (!TAG_NAME.test(open.tag)) continue;
    const { tag } = open;

    if (RAW_TEXT_TAGS.has(tag)) {
      const re = new RegExp(`</${tag}[\\s/>]`, 'i');
      const rest = html.slice(i);
      const found = re.exec(rest);
      const body = found ? rest.slice(0, found.index) : rest;
      i += body.length;
      if (found) {
        const close = html.indexOf('>', i);
        i = close === -1 ? html.length : close + 1;
      }
      const el: HtmlElement = { type: 'element', tag, attrs: open.attrs, children: [] };
      if (tag === 'style') el.children.push({ type: 'css', css: body });
      else if (body) el.children.push({ type: 'text', text: body });
      if (stack.length < MAX_DEPTH) top().children.push(el);
      continue;
    }

    const rule = AUTO_CLOSE[tag];
    if (rule) {
      // the outermost open element this tag implicitly closes, without leaving its table/list
      let target = -1;
      for (let k = stack.length - 1; k > 0; k--) {
        const candidate = stack[k]!.tag;
        if (rule.stopAt.includes(candidate)) break;
        if (rule.closes.includes(candidate)) target = k;
      }
      if (target > 0) {
        while (stack.length > target) {
          const closed = stack.pop()!;
          if (closed.tag === 'svg' || closed.tag === 'math') foreign--;
        }
      }
    }

    if (stack.length >= MAX_DEPTH) continue; // absurdly deep: the tag is dropped
    const el: HtmlElement = { type: 'element', tag, attrs: open.attrs, children: [] };
    top().children.push(el);
    if (VOID_TAGS.has(tag)) continue;
    const isForeign = tag === 'svg' || tag === 'math';
    if (open.selfClosing && (foreign > 0 || isForeign)) continue;
    stack.push(el);
    if (isForeign) foreign++;
  }
  return root.children;
}

const escapeText = (text: string): string => text.replace(/</g, '&lt;');
const escapeAttr = (value: string): string => value.replace(/"/g, '&quot;');

/** CSS text inside `<style>`: no `<` may survive (foreign-content parsers read it as markup). */
export const neutralizeCssForHtml = (css: string): string => css.replace(/</g, '\\3c ');

export function serializeNodes(nodes: readonly HtmlNode[]): string {
  const out: string[] = [];
  const walk = (list: readonly HtmlNode[]) => {
    for (const node of list) {
      if (node.type === 'text') out.push(escapeText(node.text));
      else if (node.type === 'css') out.push(neutralizeCssForHtml(node.css));
      else {
        out.push(`<${node.tag}`);
        for (const a of node.attrs) {
          out.push(a.value === null ? ` ${a.name}` : ` ${a.name}="${escapeAttr(a.value)}"`);
        }
        out.push('>');
        if (VOID_TAGS.has(node.tag)) continue;
        walk(node.children);
        out.push(`</${node.tag}>`);
      }
    }
  };
  walk(nodes);
  return out.join('');
}

export const getAttr = (el: HtmlElement, name: string): string | null =>
  el.attrs.find((a) => a.name === name)?.value ?? null;

export const hasAttr = (el: HtmlElement, name: string): boolean =>
  el.attrs.some((a) => a.name === name);

export function setAttr(el: HtmlElement, name: string, value: string | null): void {
  const existing = el.attrs.find((a) => a.name === name);
  if (existing) existing.value = value;
  else el.attrs.push({ name, value });
}

export function removeAttr(el: HtmlElement, name: string): void {
  el.attrs = el.attrs.filter((a) => a.name !== name);
}

/** The text of a subtree, entities left as written. */
export function textContent(node: HtmlNode): string {
  if (node.type === 'text') return node.text;
  if (node.type === 'css') return '';
  return node.children.map(textContent).join('');
}

/** Depth-first walk over every element (the root list included). */
export function eachElement(nodes: readonly HtmlNode[], visit: (el: HtmlElement) => void): void {
  for (const node of nodes) {
    if (node.type !== 'element') continue;
    visit(node);
    eachElement(node.children, visit);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  tab: '\t',
  newline: '\n',
  nbsp: '\u00a0',
  lpar: '(',
  rpar: ')',
  sol: '/',
  bsol: '\\',
  period: '.',
  comma: ',',
  semi: ';',
  num: '#',
  percnt: '%',
  excl: '!',
  equals: '=',
  quest: '?',
  commat: '@',
  lsqb: '[',
  rsqb: ']',
  lbrace: '{',
  rbrace: '}',
  plus: '+',
  hyphen: '-',
  dash: '-',
};

/** Decodes the entities an attacker could use to hide a URL scheme (numeric, and the common named ones). */
export function decodeEntities(raw: string): string {
  return raw.replace(
    /&(?:#x([0-9a-f]{1,6});?|#(\d{1,7});?|([a-z][a-z0-9]{1,10});)/gi,
    (m, hex, dec, name) => {
      let code: number;
      if (hex) code = parseInt(hex, 16);
      else if (dec) code = parseInt(dec, 10);
      else {
        const named = NAMED_ENTITIES[String(name).toLowerCase()];
        return named ?? m;
      }
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    },
  );
}
