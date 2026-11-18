import {
  eachElement,
  getAttr,
  parseHtml,
  removeAttr,
  serializeNodes,
  setAttr,
  textContent,
  type HtmlElement,
  type HtmlNode,
} from './html-tree';
import { scrubPersonalData } from './pii-scrub';

/*
 * LGPD scrub of a captured screen: what the person typed or the grid listed must not stay in a
 * prototype that is stored, edited and sent to a document. Labels, titles, legends, button
 * captions, select options and the headers of grids stay; field values and the cells of grid bodies go.
 * What is left is then checked by the privacy detectors (CPF, CNPJ, e-mail, phone, names…): the
 * personal data of the screen itself (the logged user in the header) becomes a fictitious value.
 */

/** What replaces the text of a grid cell. */
export const SCRUBBED_CELL = '—';

/** Inputs whose `value` is a caption, not data. */
const CAPTION_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image']);
/** Inputs whose `value` is a fixed token of the option, not what is shown. */
const TOGGLE_INPUT_TYPES = new Set(['checkbox', 'radio']);

const FORM_CONTROLS = new Set(['input', 'select', 'textarea', 'button']);
const HEADER_CLASS =
  /(^|[\s_-])(th|head|header|headers|cab|cabec|cabecalho|titulo|title|colhead)([\s_-]|$)/i;

const lowerAttr = (el: HtmlElement, name: string): string =>
  (getAttr(el, name) ?? '').toLowerCase();

function clearFieldValues(root: readonly HtmlNode[]): void {
  eachElement(root, (el) => {
    if (el.tag === 'input') {
      const type = lowerAttr(el, 'type') || 'text';
      if (CAPTION_INPUT_TYPES.has(type) || TOGGLE_INPUT_TYPES.has(type)) return;
      removeAttr(el, 'value');
    } else if (el.tag === 'textarea') {
      el.children = [];
    } else if (el.tag === 'select') {
      resetSelect(el);
    }
  });
}

/** The options stay (they are the screen's vocabulary); the choice goes back to the first one. */
function resetSelect(select: HtmlElement): void {
  const options: HtmlElement[] = [];
  eachElement(select.children, (el) => {
    if (el.tag === 'option') options.push(el);
  });
  options.forEach((opt, index) => {
    removeAttr(opt, 'selected');
    if (index === 0) setAttr(opt, 'selected', null);
  });
}

export const cellsOf = (row: HtmlElement): HtmlElement[] =>
  row.children.filter(
    (c): c is HtmlElement => c.type === 'element' && (c.tag === 'td' || c.tag === 'th'),
  );

/** `tr` elements that belong to `table` itself (not to a table nested inside a cell). */
export function rowsOf(table: HtmlElement): { row: HtmlElement; section: string }[] {
  const rows: { row: HtmlElement; section: string }[] = [];
  const walk = (nodes: readonly HtmlNode[], section: string) => {
    for (const node of nodes) {
      if (node.type !== 'element') continue;
      if (node.tag === 'tr') rows.push({ row: node, section });
      else if (node.tag === 'thead' || node.tag === 'tbody' || node.tag === 'tfoot') {
        walk(node.children, node.tag);
      }
      // anything else (a nested table, a div…) is not this table's row
    }
  };
  walk(table.children, 'table');
  return rows;
}

const containsTag = (nodes: readonly HtmlNode[], tags: ReadonlySet<string>): boolean => {
  let found = false;
  eachElement(nodes, (el) => {
    if (tags.has(el.tag)) found = true;
  });
  return found;
};

const NESTED_OR_CONTROL = new Set(['table', ...FORM_CONTROLS]);

/** A row looks like a header: `th` cells, or cells styled/classed as headers (e-Cidade grids). */
export function isHeaderRow(row: HtmlElement): boolean {
  const cells = cellsOf(row);
  if (cells.length === 0) return false;
  if (cells.every((c) => c.tag === 'th')) return true;
  return cells.every((c) => {
    if (c.tag === 'th') return true;
    if (
      HEADER_CLASS.test(getAttr(c, 'class') ?? '') ||
      HEADER_CLASS.test(getAttr(row, 'class') ?? '')
    ) {
      return true;
    }
    if (/\bfont-weight\s*:\s*(bold|[6-9]00)/i.test(getAttr(c, 'style') ?? '')) return true;
    // a cell that is all bold text
    const only = c.children.filter((n) => n.type === 'element' || textContent(n).trim() !== '');
    return (
      only.length > 0 &&
      only.every((n) => n.type === 'element' && (n.tag === 'b' || n.tag === 'strong'))
    );
  });
}

function scrubCell(cell: HtmlElement): void {
  // a cell holding a nested grid or a field is layout: those are handled on their own
  if (containsTag(cell.children, NESTED_OR_CONTROL)) return;
  if (textContent(cell).replace(/&nbsp;|\s/g, '') === '') return; // empty stays empty
  cell.children = [{ type: 'text', text: SCRUBBED_CELL }];
}

function scrubTables(root: readonly HtmlNode[]): void {
  const tables: HtmlElement[] = [];
  eachElement(root, (el) => {
    if (el.tag === 'table') tables.push(el);
  });
  for (const table of tables) {
    const rows = rowsOf(table);
    if (rows.length === 0) continue;
    const hasThead = rows.some((r) => r.section === 'thead');
    const hasTh = rows.some((r) => cellsOf(r.row).some((c) => c.tag === 'th'));
    const firstBodyRow = rows.find((r) => r.section !== 'thead');
    const headerFirst = !!firstBodyRow && isHeaderRow(firstBodyRow.row);
    // layout tables (labels + fields, no header) are not grids: they would lose their captions
    if (!hasThead && !hasTh && !headerFirst) continue;
    for (const { row, section } of rows) {
      if (section === 'thead' || (headerFirst && row === firstBodyRow?.row)) continue;
      // `th` cells of the body are row captions: kept
      for (const cell of cellsOf(row)) if (cell.tag === 'td') scrubCell(cell);
    }
  }
  // ARIA grids built from divs
  eachElement(root, (el) => {
    const role = lowerAttr(el, 'role');
    if (role === 'gridcell' || role === 'cell') scrubCell(el);
  });
}

/** Scrubs a parsed tree in place. */
export function scrubTree(root: readonly HtmlNode[]): void {
  clearFieldValues(root);
  scrubTables(root);
  // <output> shows a computed result
  eachElement(root, (el) => {
    if (el.tag === 'output') el.children = [];
  });
  scrubPersonalData(root);
}

/** Scrubs `html` (already sanitized or not) and returns the new markup. */
export function scrubHtml(html: string): string {
  const tree = parseHtml(html);
  scrubTree(tree);
  return serializeNodes(tree);
}
