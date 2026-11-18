import { eachElement, getAttr, type HtmlAttr, type HtmlNode } from './html-tree';

/*
 * Compaction of a prototype before it goes to the model, and the way back:
 *  - pictures (`data:` URIs in attributes, inline styles and the stylesheet) are replaced by short
 *    placeholders — `data-img="n"` on the element, `url("#img-n")` in CSS — and put back afterwards,
 *    so the model never sees (or pays for) a base64 blob and cannot corrupt one;
 *  - whitespace runs are collapsed;
 *  - the stylesheet is trimmed to the rules that can match the HTML that is sent.
 */

/** Pictures taken out of the markup/CSS; numbers are 1-based. */
export class ImageVault {
  private readonly values: string[] = [];
  private readonly numbers = new Map<string, number>();

  /** Same picture, same number. */
  add(value: string): number {
    const known = this.numbers.get(value);
    if (known) return known;
    this.values.push(value);
    this.numbers.set(value, this.values.length);
    return this.values.length;
  }

  get(n: number): string | undefined {
    return this.values[n - 1];
  }

  get size(): number {
    return this.values.length;
  }
}

const isDataUri = (value: string | null): value is string =>
  value !== null && /^\s*data:/i.test(value);

/** `src` → `data-img`; `background` → `data-img-background`. */
const placeholderAttr = (attr: string): string =>
  attr === 'src' ? 'data-img' : `data-img-${attr}`;
const PLACEHOLDER_ATTR = /^data-img(?:-(.+))?$/;

const CSS_DATA_URL = /url\(\s*(?:"(data:[^"]*)"|'(data:[^']*)'|(data:[^)"']*))\s*\)/gi;
const CSS_IMG_PLACEHOLDER = /url\(\s*["']?#img-(\d+)["']?\s*\)/g;

/** Replaces every `url(data:…)` of a stylesheet / style attribute with `url("#img-n")`. */
export function stripImagesFromCss(css: string, vault: ImageVault): string {
  return css.replace(CSS_DATA_URL, (_m, dq?: string, sq?: string, bare?: string) => {
    const value = dq ?? sq ?? bare ?? '';
    return `url("#img-${vault.add(value.trim())}")`;
  });
}

/** Puts the pictures back into CSS; unknown placeholders are left as harmless anchors. */
export function restoreImagesInCss(css: string, vault: ImageVault): string {
  return css.replace(CSS_IMG_PLACEHOLDER, (whole, n: string) => {
    const value = vault.get(Number(n));
    return value === undefined ? whole : `url("${value.replace(/"/g, '%22').replace(/\s/g, '')}")`;
  });
}

/** Moves the pictures of a (cloned) tree into the vault, leaving `data-img` placeholders. */
export function stripImagesFromTree(nodes: HtmlNode[], vault: ImageVault): void {
  const strip = (list: HtmlNode[]) => {
    for (const node of list) {
      if (node.type === 'css') {
        node.css = stripImagesFromCss(node.css, vault);
      } else if (node.type === 'element') {
        const attrs: HtmlAttr[] = [];
        for (const attr of node.attrs) {
          if (attr.name === 'style' && attr.value) {
            attrs.push({ name: 'style', value: stripImagesFromCss(attr.value, vault) });
          } else if (isDataUri(attr.value)) {
            attrs.push({
              name: placeholderAttr(attr.name),
              value: String(vault.add(attr.value.trim())),
            });
          } else {
            attrs.push(attr);
          }
        }
        node.attrs = attrs;
        strip(node.children);
      }
    }
  };
  strip(nodes);
}

/**
 * Puts the pictures back after the model answered. Returns the numbers that were restored, and
 * how many placeholders pointed at nothing (invented by the model: they are dropped).
 */
export function restoreImagesInTree(
  nodes: HtmlNode[],
  vault: ImageVault,
): { restored: Set<number>; unknown: number } {
  const restored = new Set<number>();
  let unknown = 0;
  const walk = (list: HtmlNode[]) => {
    for (const node of list) {
      if (node.type === 'css') {
        node.css = restoreImagesInCss(node.css, vault);
        for (const m of node.css.matchAll(/#img-(\d+)/g)) restored.add(Number(m[1]));
      } else if (node.type === 'element') {
        const attrs: HtmlAttr[] = [];
        for (const attr of node.attrs) {
          const match = PLACEHOLDER_ATTR.exec(attr.name);
          if (match) {
            const value = vault.get(Number(attr.value));
            if (value === undefined) unknown++;
            else {
              restored.add(Number(attr.value));
              attrs.push({ name: match[1] ?? 'src', value });
            }
          } else if (attr.name === 'style' && attr.value) {
            const refs = [...attr.value.matchAll(/#img-(\d+)/g)];
            for (const r of refs) restored.add(Number(r[1]));
            attrs.push({ name: 'style', value: restoreImagesInCss(attr.value, vault) });
          } else {
            attrs.push(attr);
          }
        }
        node.attrs = attrs;
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return { restored, unknown };
}

/** Numbers of the placeholders present in a tree/stylesheet (what the model was shown). */
export function placeholdersIn(nodes: HtmlNode[], css = ''): Set<number> {
  const found = new Set<number>();
  for (const m of css.matchAll(/#img-(\d+)/g)) found.add(Number(m[1]));
  const walk = (list: HtmlNode[]) => {
    for (const node of list) {
      if (node.type === 'css')
        for (const m of node.css.matchAll(/#img-(\d+)/g)) found.add(Number(m[1]));
      else if (node.type === 'element') {
        for (const attr of node.attrs) {
          if (PLACEHOLDER_ATTR.test(attr.name)) found.add(Number(attr.value));
          else if (attr.name === 'style' && attr.value)
            for (const m of attr.value.matchAll(/#img-(\d+)/g)) found.add(Number(m[1]));
        }
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return found;
}

const PRESERVE_SPACE = new Set(['pre', 'textarea', 'style', 'script']);

/** Collapses whitespace runs to one space and drops blank edges (in place). */
export function collapseWhitespace(nodes: HtmlNode[]): void {
  const walk = (list: HtmlNode[], preserve: boolean) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const node = list[i]!;
      if (node.type === 'text' && !preserve) {
        const text = node.text.replace(/\s+/g, ' ');
        const atEdge = i === 0 || i === list.length - 1;
        const next = list[i + 1];
        const prev = list[i - 1];
        // a blank between two elements is kept as one space only between inline-looking neighbours
        const betweenElements = prev?.type === 'element' && next?.type === 'element';
        if (text.trim() === '' && (atEdge || !betweenElements)) list.splice(i, 1);
        else node.text = text;
      } else if (node.type === 'element') {
        walk(node.children, preserve || PRESERVE_SPACE.has(node.tag));
      }
    }
  };
  walk(nodes, false);
}

/* ------------------------------------------------------------------ CSS trimming ---- */

export interface Vocabulary {
  tags: Set<string>;
  classes: Set<string>;
  ids: Set<string>;
}

/** Tags, classes and ids that appear in a forest of nodes. */
export function vocabularyOf(nodes: readonly HtmlNode[]): Vocabulary {
  const vocab: Vocabulary = {
    tags: new Set(['html', 'body']),
    classes: new Set(),
    ids: new Set(),
  };
  eachElement(nodes, (el) => {
    vocab.tags.add(el.tag);
    for (const c of (getAttr(el, 'class') ?? '').split(/\s+/)) if (c) vocab.classes.add(c);
    const id = getAttr(el, 'id');
    if (id) vocab.ids.add(id);
  });
  return vocab;
}

interface CssChunk {
  /** Selector list or at-rule head (without the block). */
  head: string;
  /** Block content without the braces; null for a statement (`@charset …;`). */
  block: string | null;
}

/** Splits a stylesheet into its top-level rules/statements (strings and comments aware). */
export function splitCss(css: string): CssChunk[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const chunks: CssChunk[] = [];
  let i = 0;
  let headStart = 0;
  let depth = 0;
  let blockStart = 0;
  let head = '';
  let quote = '';
  let paren = 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '{') {
      if (depth === 0) {
        head = text.slice(headStart, i).trim();
        blockStart = i + 1;
      }
      depth++;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0) {
        chunks.push({ head, block: text.slice(blockStart, i) });
        headStart = i + 1;
      }
    } else if (ch === ';' && depth === 0 && paren === 0) {
      const statement = text.slice(headStart, i).trim();
      if (statement) chunks.push({ head: statement, block: null });
      headStart = i + 1;
    }
  }
  return chunks;
}

/** Splits `a, b:not(.c, .d), e` at the commas that are not inside () or []. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** Removes `[attr]` selectors and `:pseudo(...)` / `::pseudo` parts (they never need a vocabulary). */
function stripPseudo(selector: string): string {
  let out = selector.replace(/\[[^\]]*\]/g, '');
  // functional pseudo-classes, innermost first
  for (let guard = 0; guard < 6 && /:[-a-z]+\([^()]*\)/i.test(out); guard++)
    out = out.replace(/::?[-a-z]+\([^()]*\)/gi, '');
  return out.replace(/::?[-a-z]+/gi, '');
}

/** Whether a selector can match something in the vocabulary (a necessary condition, never too strict). */
export function selectorMayMatch(selector: string, vocab: Vocabulary): boolean {
  const plain = stripPseudo(selector);
  for (const m of plain.matchAll(/\.(-?[_a-zA-Z][-\w]*|\\.[-\w\\]*)/g)) {
    if (!vocab.classes.has(m[1]!.replace(/\\/g, ''))) return false;
  }
  for (const m of plain.matchAll(/#(-?[_a-zA-Z][-\w]*)/g)) {
    if (!vocab.ids.has(m[1]!)) return false;
  }
  // type selectors: at the start of a compound (start of string or after a combinator)
  for (const m of plain.matchAll(/(?:^|[\s>+~])([a-zA-Z][-\w]*)/g)) {
    if (!vocab.tags.has(m[1]!.toLowerCase())) return false;
  }
  return true;
}

const CONDITIONAL_AT = new Set(['media', 'supports', 'document', 'layer', 'container']);

function trimChunks(chunks: CssChunk[], vocab: Vocabulary): string[] {
  const out: string[] = [];
  for (const { head, block } of chunks) {
    if (head.startsWith('@')) {
      const name = /^@([-\w]+)/.exec(head)?.[1]?.toLowerCase() ?? '';
      if (name === 'import') continue;
      if (block === null) out.push(`${head};`);
      else if (CONDITIONAL_AT.has(name)) {
        const inner = trimChunks(splitCss(block), vocab);
        if (inner.length > 0) out.push(`${head}{${inner.join('')}}`);
      } else {
        out.push(`${head}{${block.trim()}}`); // @font-face, @keyframes, @page…
      }
      continue;
    }
    if (block === null) continue;
    const kept = splitSelectors(head).filter((s) => selectorMayMatch(s, vocab));
    if (kept.length > 0) out.push(`${kept.join(',')}{${block.trim()}}`);
  }
  return out;
}

/** The rules of `css` that can match the vocabulary (unused @keyframes go too). */
export function trimCss(css: string, vocab: Vocabulary): string {
  const rules = trimChunks(splitCss(css), vocab);
  const body = rules.filter((r) => !/^@(?:-\w+-)?keyframes\b/i.test(r)).join('\n');
  const keyframes = rules
    .filter((r) => /^@(?:-\w+-)?keyframes\b/i.test(r))
    .filter((r) => {
      const name = /^@(?:-\w+-)?keyframes\s+([-\w]+)/i.exec(r)?.[1];
      return !!name && body.includes(name);
    });
  return [body, ...keyframes].filter(Boolean).join('\n');
}
