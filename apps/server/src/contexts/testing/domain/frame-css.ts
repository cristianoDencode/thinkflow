/*
 * CSS of a flattened frame. A captured screen inlines every same-origin iframe as a
 * `<div data-tf-frame="n">` (see `prototype-script.ts`); the stylesheets of that frame's document
 * must only apply inside its div, so every selector gets the div as ancestor and the selectors of
 * the frame's own `html`/`body`/`:root` become the div itself. Pure string processing: no CSS
 * parser dependency in the domain.
 */

/** Attribute that marks the div standing for an iframe. */
export const FRAME_ATTR = 'data-tf-frame';

export interface ScopeOptions {
  /** `@font-face` blocks already emitted (shared by every frame): a duplicate is dropped. */
  seenFontFaces?: Set<string>;
  /**
   * The frame holds other flattened frames. In the browser the CSS of a document never reaches the
   * documents of its iframes, so its rules must not match inside the nested divs (a reset such as
   * `* { border: 0 }` of the window wrapper would otherwise strip the routine's fieldsets).
   */
  hasChildFrames?: boolean;
}

const isSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

/** Index just after the string literal that starts at `i`. */
function skipString(css: string, i: number): number {
  const quote = css[i];
  let p = i + 1;
  while (p < css.length) {
    const c = css[p];
    if (c === '\\') p += 2;
    else if (c === quote || c === '\n') return p + 1;
    else p++;
  }
  return css.length;
}

/** Index just after the comment that starts at `i` (`/*`). */
function skipComment(css: string, i: number): number {
  const end = css.indexOf('*/', i + 2);
  return end === -1 ? css.length : end + 2;
}

/** Index of the `}` that closes the block opened at `open` (`css[open] === '{'`); end of text if open. */
function matchingBrace(css: string, open: number): number {
  let depth = 0;
  let p = open;
  while (p < css.length) {
    const c = css[p];
    if (c === '"' || c === "'") p = skipString(css, p);
    else if (c === '/' && css[p + 1] === '*') p = skipComment(css, p);
    else if (c === '\\') p += 2;
    else {
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return p;
      p++;
    }
  }
  return css.length;
}

interface Rule {
  /** Text before `{` or `;`, trimmed (comments removed). */
  prelude: string;
  /** Text between the braces; null for a statement ending in `;`. */
  body: string | null;
}

/** Splits a stylesheet (or the body of a grouping at-rule) into its top-level rules. */
function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    let prelude = '';
    let parens = 0;
    let ended = false;
    while (i < css.length) {
      const c = css[i]!;
      if (c === '/' && css[i + 1] === '*') {
        i = skipComment(css, i);
      } else if (c === '"' || c === "'") {
        const end = skipString(css, i);
        prelude += css.slice(i, end);
        i = end;
      } else if (c === '\\') {
        prelude += css.slice(i, i + 2);
        i += 2;
      } else if (c === '<' && css.startsWith('<!--', i)) {
        i += 4;
      } else if (c === '-' && css.startsWith('-->', i) && prelude.trim() === '') {
        i += 3;
      } else if (c === '}') {
        i++; // a stray closing brace
      } else if (c === '{' && parens === 0) {
        const close = matchingBrace(css, i);
        rules.push({ prelude: prelude.trim(), body: css.slice(i + 1, close) });
        i = close + 1;
        ended = true;
        break;
      } else if (c === ';' && parens === 0) {
        rules.push({ prelude: prelude.trim(), body: null });
        i++;
        ended = true;
        break;
      } else {
        if (c === '(' || c === '[') parens++;
        else if ((c === ')' || c === ']') && parens > 0) parens--;
        prelude += c;
        i++;
      }
    }
    if (!ended) break; // trailing junk without `{` or `;`
  }
  return rules.filter((r) => r.prelude !== '' || r.body !== null);
}

/** Splits `text` at `separator` characters outside parentheses, brackets and strings. */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let p = 0;
  while (p < text.length) {
    const c = text[p]!;
    if (c === '"' || c === "'") {
      p = skipString(text, p);
      continue;
    }
    if (c === '\\') {
      p += 2;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === separator && depth === 0) {
      out.push(text.slice(start, p));
      start = p + 1;
    }
    p++;
  }
  out.push(text.slice(start));
  return out;
}

/** End of the compound selector that starts at `from` (up to a combinator at depth 0). */
function compoundEnd(selector: string, from: number): number {
  let depth = 0;
  let p = from;
  while (p < selector.length) {
    const c = selector[p]!;
    if (c === '"' || c === "'") {
      p = skipString(selector, p);
      continue;
    }
    if (c === '\\') {
      p += 2;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (isSpace(c) || c === '>' || c === '+' || c === '~')) return p;
    p++;
  }
  return selector.length;
}

const ROOTISH = /^(html|body|:root)(?![\w-])/i;

/**
 * One selector of a frame's stylesheet, scoped: `body.x p` → `[scope].x p`, `html body` → `[scope]`,
 * `:root` → `[scope]`, `*` → `[scope], [scope] *`, anything else → `[scope] selector`.
 */
export function scopeSelector(raw: string, scope: string): string {
  const selector = raw.trim();
  if (selector === '') return '';
  if (selector === '*') return `${scope},${scope} *`;
  const first = ROOTISH.exec(selector);
  if (!first) return `${scope} ${selector}`;
  let end = compoundEnd(selector, 0);
  let head = scope + selector.slice(first[0].length, end);
  // `html body` / `html > body` / `:root body`: the same div
  if (first[1]!.toLowerCase() !== 'body') {
    const body = /^(\s*(?:>\s*)?)body(?![\w-])/i.exec(selector.slice(end));
    if (body) {
      const start = end + body[1]!.length;
      const bodyEnd = compoundEnd(selector, start);
      head += selector.slice(start + 'body'.length, bodyEnd);
      end = bodyEnd;
    }
  }
  return head + selector.slice(end);
}

/** Start of the last compound selector of `selector` (after the last combinator at depth 0). */
function lastCompoundStart(selector: string): number {
  let depth = 0;
  let start = 0;
  let p = 0;
  while (p < selector.length) {
    const c = selector[p]!;
    if (c === '"' || c === "'") {
      p = skipString(selector, p);
      continue;
    }
    if (c === '\\') {
      p += 2;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (isSpace(c) || c === '>' || c === '+' || c === '~')) {
      while (p < selector.length && (isSpace(selector[p]) || '>+~'.includes(selector[p]!))) p++;
      start = p;
      continue;
    }
    p++;
  }
  return start;
}

const LEGACY_PSEUDO_ELEMENT = /^:(?:before|after|first-line|first-letter)(?![\w-])/i;

/**
 * Adds `exclusion` (a `:not(…)`) to the subject of `selector`: right before a trailing
 * pseudo-element (`a::before` → `a:not(…)::before`), since nothing may follow it.
 */
export function addToSubject(selector: string, exclusion: string): string {
  const from = lastCompoundStart(selector);
  let depth = 0;
  for (let p = from; p < selector.length; p++) {
    const c = selector[p]!;
    if (c === '"' || c === "'") {
      p = skipString(selector, p) - 1;
    } else if (c === '\\') {
      p++;
    } else if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && c === ':') {
      if (selector[p + 1] === ':' || LEGACY_PSEUDO_ELEMENT.test(selector.slice(p))) {
        return selector.slice(0, p) + exclusion + selector.slice(p);
      }
    }
  }
  return selector + exclusion;
}

const KEYFRAMES = /^@(?:-[a-z]+-)?keyframes\s+(?:"([^"]+)"|'([^']+)'|([^\s{]+))\s*$/i;

/** Names of the `@keyframes` of a stylesheet. */
function keyframeNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const m of css.matchAll(/@(?:-[a-z]+-)?keyframes\s+(?:"([^"]+)"|'([^']+)'|([^\s{"']+))/gi)) {
    names.add(m[1] ?? m[2] ?? m[3] ?? '');
  }
  names.delete('');
  return names;
}

/** `animation` / `animation-name` values pointing at a renamed keyframes. */
function renameAnimations(body: string, names: ReadonlySet<string>, suffix: string): string {
  if (names.size === 0 || !/animation/i.test(body)) return body;
  return body.replace(/(animation(?:-name)?\s*:)([^;}]*)/gi, (_m, prop: string, value: string) => {
    const renamed = value.replace(/-?[A-Za-z_][\w-]*/g, (id) => (names.has(id) ? id + suffix : id));
    return prop + renamed;
  });
}

const GROUPING_AT_RULES = new Set([
  'media',
  'supports',
  'container',
  'layer',
  'document',
  '-moz-document',
]);
/** Dropped: the frame's document is not a page of its own any more. */
const DROPPED_AT_RULES = new Set([
  'import',
  'charset',
  'namespace',
  'page',
  'viewport',
  '-ms-viewport',
  'font-feature-values',
]);

interface Transform {
  /** Appended to `@keyframes` names ('' keeps them). */
  suffix: string;
  seen: Set<string>;
  /** The selectors that replace one selector of the stylesheet. */
  selectors: (raw: string) => string[];
}

function transformCss(css: string, t: Transform): string {
  const { suffix, seen } = t;
  const names = suffix ? keyframeNames(css) : new Set<string>();

  const process = (rules: readonly Rule[]): string => {
    const out: string[] = [];
    for (const rule of rules) {
      if (rule.prelude.startsWith('@')) {
        const name = /^@([\w-]+)/.exec(rule.prelude)?.[1]?.toLowerCase() ?? '';
        if (DROPPED_AT_RULES.has(name)) continue;
        if (rule.body === null) {
          out.push(`${rule.prelude};`);
        } else if (GROUPING_AT_RULES.has(name)) {
          out.push(`${rule.prelude}{${process(parseRules(rule.body))}}`);
        } else if (name === 'font-face') {
          const key = rule.body.replace(/\s+/g, ' ').trim();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(`@font-face{${rule.body}}`);
        } else if (/^(?:-[a-z]+-)?keyframes$/.test(name)) {
          const m = KEYFRAMES.exec(rule.prelude);
          const id = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
          if (!m || !id) continue;
          const head = /^@(?:-[a-z]+-)?keyframes\s+/i.exec(rule.prelude)![0];
          const renamed = m[3] !== undefined ? `${id}${suffix}` : `"${id}${suffix}"`;
          out.push(`${head}${renamed}{${rule.body}}`);
        } else if (name === 'property' || name === 'counter-style') {
          out.push(`${rule.prelude}{${rule.body}}`);
        }
        // anything else (unknown at-rules) is dropped: it may not be scopable
        continue;
      }
      if (rule.body === null) continue;
      const selectors = [
        ...new Set(splitTopLevel(rule.prelude, ',').flatMap(t.selectors).filter(Boolean)),
      ];
      if (selectors.length === 0) continue;
      out.push(`${selectors.join(',')}{${renameAnimations(rule.body, names, suffix)}}`);
    }
    return out.join('\n');
  };
  return process(parseRules(css));
}

/**
 * Scopes the stylesheet of the frame `frameId` so it only applies inside `<div data-tf-frame="id">`.
 * `@media`/`@supports`/`@container`/`@layer` blocks are scoped inside, `@font-face` duplicates are
 * dropped, `@keyframes` get a unique name (and the `animation` declarations follow), `@import`,
 * `@charset` and `@page` are dropped. With `hasChildFrames`, no rule reaches into the divs of the
 * frames nested in this one (see `ScopeOptions`).
 */
export function scopeCss(css: string, frameId: number, options: ScopeOptions = {}): string {
  const scope = `[${FRAME_ATTR}="${frameId}"]`;
  const exclusion = options.hasChildFrames
    ? `:not(${scope} [${FRAME_ATTR}],${scope} [${FRAME_ATTR}] *)`
    : '';
  return transformCss(css, {
    suffix: `-tf${frameId}`,
    seen: options.seenFontFaces ?? new Set<string>(),
    selectors: (raw) =>
      splitTopLevel(scopeSelector(raw, scope), ',').map((sel) => {
        const s = sel.trim();
        // the frame div itself (`body`, `html`, `:root` rules) is not "inside" any nested frame
        if (!exclusion || (s.startsWith(scope) && lastCompoundStart(s) === 0)) return s;
        return addToSubject(s, exclusion);
      }),
  });
}

/**
 * The same for the captured document itself when it holds flattened frames: its rules apply
 * outside the frame divs only, as an iframe's document is not styled by the page around it.
 */
export function isolateTopCss(
  css: string,
  options: Pick<ScopeOptions, 'seenFontFaces'> = {},
): string {
  const exclusion = `:not([${FRAME_ATTR}],[${FRAME_ATTR}] *)`;
  return transformCss(css, {
    suffix: '',
    seen: options.seenFontFaces ?? new Set<string>(),
    selectors: (raw) => {
      const s = raw.trim();
      return [s ? addToSubject(s, exclusion) : ''];
    },
  });
}

/** What the browser's own stylesheet does to a table in quirks mode (it does not inherit text styles). */
const QUIRKS_TABLE =
  'font-size:medium;font-weight:normal;font-style:normal;font-variant:normal;line-height:normal;white-space:normal;text-align:start;color:CanvasText';
const STANDARDS_TABLE =
  'font-size:inherit;font-weight:inherit;font-style:inherit;font-variant:inherit;line-height:inherit;white-space:inherit;text-align:inherit;color:inherit';

/**
 * Rules that come first in the CSS of a frame: the div starts from the browser defaults (it is a
 * new document, so nothing is inherited from the page around it) and tables follow the document
 * mode (quirks or standards) the frame had. `topQuirks`: the page that holds it is in quirks mode,
 * so tables of a standards frame must be put back to inheriting. The reset is on the div only:
 * the elements inside keep the browser's defaults (fieldset border, input and button looks…).
 */
export function frameBaseCss(
  frameId: number,
  mode: { quirks: boolean; topQuirks: boolean; hasChildFrames?: boolean },
): string {
  const scope = `[${FRAME_ATTR}="${frameId}"]`;
  const table = mode.hasChildFrames
    ? addToSubject(`${scope} table`, `:not(${scope} [${FRAME_ATTR}] *)`)
    : `${scope} table`;
  const rules = [`${scope}{all:initial;box-sizing:border-box}`];
  if (mode.quirks) rules.push(`${table}{${QUIRKS_TABLE}}`);
  else if (mode.topQuirks) rules.push(`${table}{${STANDARDS_TABLE}}`);
  return rules.join('\n');
}

/** Table rule of the top document when it is in quirks mode. */
export const TOP_QUIRKS_CSS = `table{${QUIRKS_TABLE}}`;
