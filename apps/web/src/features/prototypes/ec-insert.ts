import type { Component } from 'grapesjs';
import { EC_KIND_ATTR } from '@thinkflow/shared';
import { ecKindOf, elementChildren, escapeHtml, tagOf } from './ec-model';

/*
 * Inserting blocks. Captured screens lay their fields out in tables, so a recognized component is
 * often a `<tr>`, which cannot live outside a table. Such blocks travel wrapped in a minimal
 * `<table><tbody>…</tbody></table>` (cloning the attributes of the table they came from, so they
 * look right anywhere). When the wrapper lands in a table (or next to a layout table) its rows are
 * moved into that table and the wrapper disappears; elsewhere the wrapper stays.
 */

export const ROW_TAGS = ['tr', 'td', 'th'] as const;
export const isRowTag = (tag: string) => (ROW_TAGS as readonly string[]).includes(tag);

const attrString = (attrs: Record<string, string>) =>
  Object.entries(attrs)
    .filter(([name]) => /^[a-z][\w:-]*$/i.test(name) && name !== 'id' && !name.startsWith('on'))
    .map(([name, value]) => ` ${name}="${escapeHtml(String(value))}"`)
    .join('');

/** `<tr>` (or `<td>`/`<th>`) markup inside a minimal table that keeps the original table's attributes. */
export function wrapRowHtml(html: string, tag: string, tableAttrs: Record<string, string>): string {
  const row = tag === 'tr' ? html : `<tr>${html}</tr>`;
  return `<table${attrString(tableAttrs)}><tbody>${row}</tbody></table>`;
}

/** Does this HTML hold only the minimal-table wrapper around recognized rows? */
export function isRowWrapperHtml(html: string): boolean {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  if (body.children.length !== 1) return false;
  const table = body.firstElementChild!;
  if (table.tagName !== 'TABLE' || table.hasAttribute(EC_KIND_ATTR)) return false;
  const sections = Array.from(table.children);
  const section = sections[0];
  if (sections.length !== 1 || section?.tagName !== 'TBODY') return false;
  const rows = Array.from(section.children);
  return (
    rows.length > 0 &&
    rows.every(
      (tr) =>
        tr.tagName === 'TR' &&
        (tr.hasAttribute(EC_KIND_ATTR) ||
          (tr.children.length === 1 && tr.children[0]?.hasAttribute(EC_KIND_ATTR))),
    )
  );
}

/** Same as `isRowWrapperHtml`, on a component. */
export function isRowWrapper(c: Component): boolean {
  if (tagOf(c) !== 'table' || ecKindOf(c)) return false;
  const [section, ...others] = elementChildren(c);
  if (!section || others.length || tagOf(section) !== 'tbody') return false;
  const rows = elementChildren(section);
  return (
    rows.length > 0 &&
    rows.every((tr) => {
      if (tagOf(tr) !== 'tr') return false;
      if (ecKindOf(tr)) return true;
      const cells = elementChildren(tr);
      return cells.length === 1 && Boolean(ecKindOf(cells[0]!));
    })
  );
}

/** The recognized rows inside a wrapper table (what to select after inserting a row block). */
export const wrapperRows = (wrapper: Component): Component[] =>
  isRowWrapper(wrapper) ? elementChildren(elementChildren(wrapper)[0]!) : [];

const isLayoutTable = (c: Component | undefined): c is Component =>
  !!c &&
  tagOf(c) === 'table' &&
  !ecKindOf(c) &&
  elementChildren(c).some((s) =>
    elementChildren(s).some((tr) => tagOf(tr) === 'tr' && elementChildren(tr).length > 0),
  );

const lastBody = (table: Component): Component | undefined =>
  [...elementChildren(table)].reverse().find((c) => tagOf(c) === 'tbody');
const firstBody = (table: Component): Component | undefined =>
  elementChildren(table).find((c) => tagOf(c) === 'tbody');

/** Moves the rows of a wrapper table to `parent` (at `at`); returns the moved rows. */
function moveRows(wrapper: Component, parent: Component, at?: number): Component[] {
  const rows = elementChildren(elementChildren(wrapper)[0]!);
  let index = at;
  rows.forEach((row) => {
    row.move(parent, index === undefined ? {} : { at: index++ });
  });
  wrapper.remove();
  return rows;
}

/**
 * After a wrapper was inserted: if it sits in a table (`tbody`, `table`, a layout table right
 * before it) its rows go into that table; otherwise it stays. Returns what to select.
 */
export function absorbRowWrapper(wrapper: Component): Component[] {
  if (!isRowWrapper(wrapper)) return [wrapper];
  const parent = wrapper.parent();
  if (!parent) return [wrapper];
  const ptag = tagOf(parent);
  if (ptag === 'tbody') return moveRows(wrapper, parent, wrapper.index());
  if (ptag === 'thead' || ptag === 'tfoot') {
    const table = parent.parent();
    const body = table && lastBody(table);
    return body ? moveRows(wrapper, body) : [wrapper];
  }
  if (ptag === 'table') {
    const body = lastBody(parent);
    return body ? moveRows(wrapper, body) : moveRows(wrapper, parent);
  }
  // fieldset / group: continue the layout table that comes right before the wrapper
  const siblings = elementChildren(parent);
  const prev = siblings[siblings.indexOf(wrapper) - 1];
  if (isLayoutTable(prev)) {
    const body = lastBody(prev);
    if (body) return moveRows(wrapper, body);
  }
  return [wrapper];
}

/* ---- where a block goes ------------------------------------------------------------------------- */

const LEAF_TAGS = new Set(['input', 'select', 'textarea', 'img', 'hr', 'br', 'button', 'label']);

/** Can new blocks be inserted inside this component? */
export const isContainer = (c: Component) =>
  c.get('droppable') !== false && !LEAF_TAGS.has(tagOf(c));

/**
 * Where a wrapped row goes for this selection: after the selected row (`before`: right above it),
 * at the end (`before`: the start) of the selected table body / table / group's layout table.
 * `null` = not a table context (generic placement).
 */
export function rowInsertionPoint(
  sel: Component,
  before = false,
): { parent: Component; at?: number } | null {
  const tag = tagOf(sel);
  const edge = (body: Component | undefined) =>
    body ? { parent: body, ...(before ? { at: 0 } : {}) } : null;
  const section = (tr: Component) => {
    const p = tr.parent();
    if (!p) return null;
    const index = tr.index() ?? 0;
    if (tagOf(p) === 'tbody') return { parent: p, at: before ? index : index + 1 };
    // a header / footer row: its wrapper rows are absorbed by the table's body
    const table = p.parent();
    const body = table && (before && tagOf(p) === 'thead' ? firstBody(table) : lastBody(table));
    if (!body) return { parent: p, at: before ? index : index + 1 };
    return before && tagOf(p) === 'thead' ? { parent: body, at: 0 } : { parent: body };
  };
  if (tag === 'tr') return section(sel);
  if (tag === 'td' || tag === 'th') {
    const tr = sel.parent();
    return tr && tagOf(tr) === 'tr' ? section(tr) : null;
  }
  if (tag === 'tbody') return { parent: sel, ...(before ? { at: 0 } : {}) };
  if (tag === 'table') {
    const body = before ? firstBody(sel) : lastBody(sel);
    return body ? edge(body) : { parent: sel, ...(before ? { at: 0 } : {}) };
  }
  if (tag === 'fieldset') {
    const tables = elementChildren(sel).filter(isLayoutTable);
    const table = before ? tables[0] : tables[tables.length - 1];
    const body = table ? (before ? firstBody(table) : lastBody(table)) : undefined;
    return edge(body);
  }
  return null;
}

/**
 * Appends `content` (HTML, with its `<style>`) relative to the selection: into a selected
 * container, otherwise right after it in the nearest container. With `before` it goes right above
 * the selection instead (the first child of a selected container). Wrapped rows go into the table
 * of the selection (see `rowInsertionPoint`) and the wrapper dissolves. Returns what was added.
 */
export function insertContent(
  wrapper: Component,
  sel: Component | undefined,
  content: string,
  isRow: boolean,
  opts: { before?: boolean } = {},
): Component[] {
  const before = Boolean(opts.before);
  let added: Component[];
  const rowPoint = isRow && sel && sel !== wrapper ? rowInsertionPoint(sel, before) : null;
  if (rowPoint) {
    added = rowPoint.parent.append(content, rowPoint.at === undefined ? {} : { at: rowPoint.at });
  } else if (!sel || sel === wrapper) {
    added = wrapper.append(content);
  } else if (isContainer(sel)) {
    added = sel.append(content, before ? { at: 0 } : {});
  } else {
    // a leaf (field, text, input, a row of a table…): right after (before: above) it, in the nearest container
    let node: Component = sel;
    while (node.parent() && node.parent() !== wrapper && !isContainer(node.parent()!))
      node = node.parent()!;
    added = (node.parent() ?? wrapper).append(content, {
      at: (node.index() ?? 0) + (before ? 0 : 1),
    });
  }
  return isRow ? added.flatMap(absorbRowWrapper) : added;
}
