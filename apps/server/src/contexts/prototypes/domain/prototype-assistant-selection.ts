import type { PrototypeAssistantSelection } from '@thinkflow/shared';
import { collapseWhitespace } from './prototype-assistant-compact';
import {
  getAttr,
  parseHtml,
  serializeNodes,
  textContent,
  type HtmlElement,
  type HtmlNode,
} from './html-tree';

/*
 * The selected component of the editor, found again in the stored markup and replaced by what
 * the model returned. Everything outside the component is never touched.
 */

/** The `<body>` of a screen; markup without one is wrapped in an empty `<body>`. */
export function parseScreen(html: string): HtmlElement {
  const nodes = parseHtml(html);
  const body = nodes.find((n): n is HtmlElement => n.type === 'element' && n.tag === 'body');
  if (body) return body;
  return { type: 'element', tag: 'body', attrs: [], children: nodes };
}

/** Positions among the element children, from `<body>`. Accepts `[0,2]`, `"0/2"`, `"0.2"`, `"0>2"`. */
export function parsePath(path: PrototypeAssistantSelection['path']): number[] | null {
  if (path === undefined) return null;
  if (Array.isArray(path)) return path;
  const parts = path.split(/[^0-9]+/).filter(Boolean);
  return parts.map(Number);
}

export interface Located {
  /** Parent element (`<body>` for a top-level component). */
  parent: HtmlElement;
  /** Index inside `parent.children` (text nodes count). */
  index: number;
  element: HtmlElement;
  /** Ancestors from `<body>` down to the parent, e.g. `body > form#f > fieldset.box`. */
  breadcrumb: string;
}

const describe = (el: HtmlElement): string => {
  const id = getAttr(el, 'id');
  const classes = (getAttr(el, 'class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2);
  return `${el.tag}${id ? `#${id}` : ''}${classes.map((c) => `.${c}`).join('')}`;
};

const normalized = (nodes: HtmlNode[]): string => {
  const copy = structuredClone(nodes);
  collapseWhitespace(copy);
  return serializeNodes(copy).trim();
};

function firstElement(html: string | undefined): HtmlElement | null {
  if (!html) return null;
  return parseHtml(html).find((n): n is HtmlElement => n.type === 'element') ?? null;
}

/** Walks the tree remembering parent and index; `visit` returns true to stop. */
function find(
  root: HtmlElement,
  trail: HtmlElement[],
  visit: (el: HtmlElement, parent: HtmlElement, index: number, trail: HtmlElement[]) => boolean,
): boolean {
  for (const [index, child] of root.children.entries()) {
    if (child.type !== 'element') continue;
    if (visit(child, root, index, trail)) return true;
    if (find(child, [...trail, child], visit)) return true;
  }
  return false;
}

/**
 * Finds the selected element: by its path (when the tag agrees with the markup the editor sent),
 * else by identical markup, id, or tag + text. `'body'` = the selection is the screen itself.
 */
export function locateSelection(
  body: HtmlElement,
  selection: PrototypeAssistantSelection,
): Located | 'body' | null {
  const wanted = firstElement(selection.html);
  if (wanted?.tag === 'body') return 'body';
  const path = parsePath(selection.path);
  if (path && path.length === 0) return 'body';

  const make = (el: HtmlElement, parent: HtmlElement, index: number, trail: HtmlElement[]) => ({
    parent,
    index,
    element: el,
    breadcrumb: ['body', ...trail.map(describe)].join(' > '),
  });

  if (path) {
    let parent = body;
    let trail: HtmlElement[] = [];
    let found: Located | null = null;
    for (const [depth, position] of path.entries()) {
      const elementIndexes = parent.children.flatMap((c, i) => (c.type === 'element' ? [i] : []));
      const index = elementIndexes[position];
      if (index === undefined) break;
      const el = parent.children[index] as HtmlElement;
      if (depth === path.length - 1) found = make(el, parent, index, trail);
      else {
        trail = [...trail, el];
        parent = el;
      }
    }
    // the path is trusted only when it points at the element the editor described
    if (found && (!wanted || wanted.tag === found.element.tag)) return found;
  }
  if (!wanted) return null;

  const key = normalized([wanted]);
  const id = getAttr(wanted, 'id');
  const text = textContent(wanted).replace(/\s+/g, ' ').trim();
  let exact: Located | null = null;
  let byId: Located | null = null;
  let byText: Located | null = null;
  find(body, [], (el, parent, index, trail) => {
    if (!exact && el.tag === wanted.tag && normalized([el]) === key)
      exact = make(el, parent, index, trail);
    if (!byId && id && el.tag === wanted.tag && getAttr(el, 'id') === id)
      byId = make(el, parent, index, trail);
    if (
      !byText &&
      text &&
      el.tag === wanted.tag &&
      textContent(el).replace(/\s+/g, ' ').trim() === text
    )
      byText = make(el, parent, index, trail);
    return exact !== null;
  });
  return exact ?? byId ?? byText;
}

/** Replaces the located element by `nodes` (in place). */
export function spliceSelection(located: Located, nodes: HtmlNode[]): void {
  located.parent.children.splice(located.index, 1, ...nodes);
}
