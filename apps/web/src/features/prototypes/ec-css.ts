/*
 * The subset of a screen's stylesheet a component needs, so a component saved to "Meus blocos"
 * keeps its look in another prototype: the rules whose selectors match the component (or
 * something inside it), plus the `@font-face` / `@keyframes` / `:root` variables those rules use.
 */

/** Splits at `sep` ignoring separators inside (), [], strings and comments. */
export function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

interface CssNode {
  /** Selector list or at-rule prelude (`@media print`). */
  prelude: string;
  /** Declarations (style rule) or inner rules (at-rule with a block); null for `@import x;`. */
  body: string | null;
}

/** Top-level rules of a stylesheet (comments dropped; blocks kept as raw text). */
export function parseRules(css: string): CssNode[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const nodes: CssNode[] = [];
  let i = 0;
  while (i < text.length) {
    // prelude up to `{` or `;`
    let j = i;
    let quote = '';
    let paren = 0;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (paren === 0 && (ch === '{' || ch === ';')) break;
    }
    const prelude = text.slice(i, j).trim();
    if (j >= text.length || text[j] === ';') {
      if (prelude) nodes.push({ prelude, body: null });
      i = j + 1;
      continue;
    }
    // block: find the matching `}`
    let depth = 1;
    let k = j + 1;
    quote = '';
    for (; k < text.length && depth > 0; k++) {
      const ch = text[k];
      if (quote) {
        if (ch === '\\') k++;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (prelude) nodes.push({ prelude, body: text.slice(j + 1, k - 1) });
    i = k;
  }
  return nodes;
}

/** Pseudo-classes/elements that depend on interaction: matched against the plain element. */
const DYNAMIC_PSEUDO =
  /::?(?:hover|focus|focus-within|focus-visible|active|visited|link|target|before|after|first-line|first-letter|selection|placeholder|-webkit-[\w-]+|-moz-[\w-]+|-ms-[\w-]+)/gi;

function selectorMatches(selector: string, roots: Element[], selfOnly: Element[]): boolean {
  const plain = selector.replace(DYNAMIC_PSEUDO, '').trim();
  if (!plain || /[>+~]\s*$/.test(plain)) return true;
  try {
    return (
      roots.some((root) => root.matches(plain) || root.querySelector(plain) !== null) ||
      selfOnly.some((el) => el.matches(plain))
    );
  } catch {
    return true; // syntax the engine does not know: keep the rule rather than lose it
  }
}

const VAR_USE = /var\(\s*(--[\w-]+)/g;

function declarations(body: string): { name: string; text: string }[] {
  return splitTopLevel(body, ';').map((text) => ({
    name: text.slice(0, Math.max(0, text.indexOf(':'))).trim(),
    text,
  }));
}

interface Collected {
  /** Rules that only carry custom properties (`:root{--x:1}`): candidates for the variables pass. */
  rootRules: CssNode[];
  support: CssNode[];
}

function collect(
  nodes: CssNode[],
  roots: Element[],
  selfOnly: Element[],
  acc: Collected,
): string[] {
  const kept: string[] = [];
  for (const node of nodes) {
    const { prelude, body } = node;
    if (body === null) continue; // @import / @charset: never part of a block
    if (prelude.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
      if (name === 'font-face' || name === 'keyframes' || name.endsWith('keyframes')) {
        acc.support.push(node);
      } else if (['media', 'supports', 'layer', 'container'].includes(name)) {
        const inner = collect(parseRules(body), roots, selfOnly, acc);
        if (inner.length) kept.push(`${prelude}{${inner.join('')}}`);
      }
      continue;
    }
    const selectors = splitTopLevel(prelude, ',');
    if (selectors.every((s) => /^(:root|html)$/i.test(s))) {
      acc.rootRules.push(node);
      continue;
    }
    const matching = selectors.filter((s) => selectorMatches(s, roots, selfOnly));
    if (matching.length) kept.push(`${matching.join(',')}{${body.trim()}}`);
  }
  return kept;
}

/**
 * Rules of `css` that apply to `roots` (the component elements, in a document that also holds
 * their context: ancestors are used to match `table.layout td` style selectors). `selfOnly` are
 * elements (e.g. the table a row came from) whose own rules count, but not their descendants'.
 */
export function cssSubsetFor(css: string, roots: Element[], selfOnly: Element[] = []): string {
  if (!css.trim() || !roots.length) return '';
  const acc: Collected = { rootRules: [], support: [] };
  const kept = collect(parseRules(css), roots, selfOnly, acc);
  const keptText = kept.join('\n');

  // custom properties the kept rules (and the support rules) read
  const used = new Set<string>();
  const scan = (text: string) => Array.from(text.matchAll(VAR_USE)).forEach((m) => used.add(m[1]!));
  scan(keptText);
  const vars: string[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const rule of acc.rootRules) {
      for (const decl of declarations(rule.body ?? '')) {
        if (decl.name.startsWith('--') && used.has(decl.name) && !vars.includes(decl.text)) {
          vars.push(decl.text);
          scan(decl.text);
          changed = true;
        }
      }
    }
  }

  // fonts and animations the kept rules refer to (by name, wherever it appears)
  const lowerKept = keptText.toLowerCase();
  const support = acc.support
    .filter((node) => {
      const name = /^@([\w-]+)/.exec(node.prelude)?.[1]?.toLowerCase() ?? '';
      const wanted =
        name === 'font-face'
          ? /font-family\s*:\s*([^;}]+)/i.exec(node.body ?? '')?.[1]
          : node.prelude.replace(/^@[\w-]*keyframes\s*/i, '');
      const key = (wanted ?? '').replace(/["']/g, '').trim().toLowerCase();
      return key !== '' && lowerKept.includes(key);
    })
    .map((node) => `${node.prelude}{${(node.body ?? '').trim()}}`);

  return [...support, ...(vars.length ? [`:root{${vars.join(';')}}`] : []), ...kept].join('\n');
}
