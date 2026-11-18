import type { Component } from 'grapesjs';
import {
  ECIDADE_COMPONENT_KINDS,
  EC_KIND_ATTR,
  EC_PART_ATTR,
  type EcidadeComponentKind,
  type EcidadeComponentPart,
} from '@thinkflow/shared';

/*
 * Model-level helpers shared by the e-Cidade component types, the "Desta tela" palette and the
 * insertion logic: which kind a component is, where its parts are (`data-ec-part` first, then the
 * `ec-*` classes of the built-in blocks), and how to read / rewrite their text and lists WITHOUT
 * changing the markup around them (captured screens keep their own tags, classes and CSS).
 * Everything works on GrapesJS models, so it also runs on a headless editor (tests).
 */

/* ---- kinds ---------------------------------------------------------------------------------- */

/** Root class of the built-in blocks (and of screens built before the `data-ec` attributes). */
const CLASS_KIND: Record<string, EcidadeComponentKind> = {
  'ec-title': 'window-title',
  'ec-status': 'status-bar',
  'ec-fieldset': 'fieldset',
  'ec-field': 'field',
  'ec-lookup': 'lookup',
  'ec-date': 'date',
  'ec-daterange': 'date-range',
  'ec-combo': 'select',
  'ec-textarea': 'textarea',
  'ec-check': 'checkbox',
  'ec-radios': 'radio-group',
  'ec-btn': 'button',
  'ec-buttons': 'button-bar',
  'ec-grid': 'grid',
  'ec-tabs': 'tabs',
  'ec-msg': 'message',
};

export const KIND_TYPE: Record<EcidadeComponentKind, string> = {
  'window-title': 'ec-title',
  'status-bar': 'ec-status',
  fieldset: 'ec-fieldset',
  field: 'ec-field',
  lookup: 'ec-lookup',
  date: 'ec-date',
  'date-range': 'ec-date-range',
  select: 'ec-combo',
  textarea: 'ec-textarea',
  checkbox: 'ec-check',
  'radio-group': 'ec-radios',
  button: 'ec-btn',
  'button-bar': 'ec-buttons',
  grid: 'ec-grid',
  tabs: 'ec-tabs',
  message: 'ec-msg',
};

/** Kinds that hold other components (their other children stay free to select/drag). */
export const CONTAINER_KINDS: ReadonlySet<EcidadeComponentKind> = new Set(['fieldset', 'tabs']);

const isKind = (value: string): value is EcidadeComponentKind =>
  (ECIDADE_COMPONENT_KINDS as readonly string[]).includes(value);

/**
 * Kind of an element from its attribute / classes. The attribute wins over the classes; an
 * unknown attribute value is ignored. `ec-btn` is only a button when the tag is one.
 */
export function kindFromMarkup(
  kindAttr: string | null | undefined,
  classes: Iterable<string>,
  tag: string,
): EcidadeComponentKind | null {
  const fromAttr = String(kindAttr ?? '').trim();
  if (isKind(fromAttr)) return fromAttr;
  for (const cls of classes) {
    const kind = CLASS_KIND[cls];
    if (!kind) continue;
    if (kind === 'button' && tag.toLowerCase() !== 'button') continue;
    return kind;
  }
  return null;
}

/* ---- model helpers --------------------------------------------------------------------------- */

export const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

export const childrenOf = (model: Component): Component[] =>
  (model.components() as unknown as { models: Component[] }).models;

export const tagOf = (c: Component) => String(c.get('tagName') ?? '').toLowerCase();

/**
 * Where a component of this tag may be dropped (GrapesJS' own rule of the native table types, which
 * the e-Cidade types do not inherit): rows only into a table section, cells only into a row, a
 * section only into a table. `true` for anything else.
 */
export function draggableRuleFor(tag: string): true | string[] {
  switch (tag.toLowerCase()) {
    case 'tr':
      return ['tbody', 'thead', 'tfoot'];
    case 'td':
    case 'th':
      return ['tr'];
    case 'tbody':
    case 'thead':
    case 'tfoot':
      return ['table'];
    default:
      return true;
  }
}
export const hasClass = (c: Component, cls: string) => c.getClasses().includes(cls);
export const attr = (c: Component | undefined, name: string) =>
  String(c?.getAttributes()[name] ?? '');
const isTextNode = (c: Component) => c.is('textnode') || c.get('type') === 'textnode';
const isElement = (c: Component) => !isTextNode(c) && c.get('type') !== 'comment';
export const elementChildren = (c: Component) => childrenOf(c).filter(isElement);

export function setAttr(c: Component | undefined, name: string, value: string): void {
  if (!c) return;
  if (value) c.addAttributes({ [name]: value });
  else c.removeAttributes(name);
}

export function ecKindOf(c: Component): EcidadeComponentKind | null {
  if (isTextNode(c)) return null;
  return kindFromMarkup(attr(c, EC_KIND_ATTR), c.getClasses(), tagOf(c));
}

export const partOfAttr = (c: Component): string => attr(c, EC_PART_ATTR);

/** Visits the descendants in document order; `visit` returning false skips that subtree. */
export function walk(model: Component, visit: (c: Component) => boolean | void): void {
  for (const child of childrenOf(model)) {
    if (visit(child) === false) continue;
    walk(child, visit);
  }
}

export function findAll(model: Component, pred: (c: Component) => boolean): Component[] {
  const out: Component[] = [];
  walk(model, (c) => {
    if (pred(c)) out.push(c);
  });
  return out;
}

export const byTag = (model: Component, ...tags: string[]) =>
  findAll(model, (c) => tags.includes(tagOf(c)));

/* ---- parts ----------------------------------------------------------------------------------- */

const BUTTON_INPUT_TYPES = ['button', 'submit', 'reset', 'image'];
export const isButtonLike = (c: Component) =>
  tagOf(c) === 'button' ||
  (tagOf(c) === 'input' && BUTTON_INPUT_TYPES.includes(attr(c, 'type').toLowerCase()));
const isFormField = (c: Component) =>
  ['input', 'select', 'textarea'].includes(tagOf(c)) &&
  !isButtonLike(c) &&
  attr(c, 'type').toLowerCase() !== 'hidden';

/** How the built-in blocks (and screens without annotations) identify each part. */
const FALLBACK: Record<EcidadeComponentPart, (c: Component) => boolean> = {
  label: (c) =>
    hasClass(c, 'ec-label') ||
    (tagOf(c) === 'label' &&
      !hasClass(c, 'ec-radio') &&
      !findAll(c, (i) => ['radio', 'checkbox'].includes(attr(i, 'type').toLowerCase())).length),
  input: isFormField,
  desc: () => false, // see `descOf`: lookups without annotations use their second input
  button: isButtonLike,
  separator: (c) => hasClass(c, 'ec-sep'),
  legend: (c) => tagOf(c) === 'legend' || hasClass(c, 'ec-legend'),
  header: (c) => hasClass(c, 'ec-tabs-head') || tagOf(c) === 'thead',
  row: (c) => tagOf(c) === 'tr',
  cell: (c) => ['td', 'th'].includes(tagOf(c)),
  tab: (c) => hasClass(c, 'ec-tab'),
  panel: (c) => hasClass(c, 'ec-tabs-body'),
  title: (c) => hasClass(c, 'ec-title-text'),
  text: (c) => hasClass(c, 'ec-msg-text'),
};

/**
 * Elements of a part, in document order: the ones annotated `data-ec-part="<part>"`, or (when
 * the component has none) the ones the built-in classes / tags identify. Inside a container
 * (fieldset, tabs) the search does not enter nested components.
 */
export function partsOf(root: Component, part: EcidadeComponentPart): Component[] {
  const kind = ecKindOf(root);
  const container = kind ? CONTAINER_KINDS.has(kind) : false;
  const annotated: Component[] = [];
  const inferred: Component[] = [];
  walk(root, (c) => {
    if (isTextNode(c)) return false;
    if (container && ecKindOf(c)) return false;
    if (partOfAttr(c) === part) annotated.push(c);
    else if (!partOfAttr(c) && FALLBACK[part](c)) inferred.push(c);
    return true;
  });
  return annotated.length ? annotated : inferred;
}

export const partOf = (root: Component, part: EcidadeComponentPart): Component | undefined =>
  partsOf(root, part)[0];

/** Form controls of a field (the lookup's code input comes first, never its description). */
export const inputsOf = (root: Component): Component[] => {
  const annotated = partsOf(root, 'input').filter((c) => partOfAttr(c) === 'input');
  return annotated.length ? annotated : findAll(root, FALLBACK.input);
};
export const inputOf = (root: Component): Component | undefined => inputsOf(root)[0];

/** The description input of a lookup: annotated, class-based or the 2nd text input. */
export function descOf(root: Component): Component | undefined {
  const explicit = partsOf(root, 'desc')[0];
  if (explicit) return explicit;
  const inputs = findAll(root, (c) => tagOf(c) === 'input' && isFormField(c));
  return inputs.length > 1 ? inputs[1] : undefined;
}

/** The control itself when the component is a lone `<input type=text>` row root. */
export const isControlRoot = (root: Component) =>
  ['input', 'select', 'textarea'].includes(tagOf(root));

/* ---- text ----------------------------------------------------------------------------------- */

export const tidy = (s: string) =>
  s
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function rawTextOf(m: Component): string {
  if (isTextNode(m)) return String(m.get('content') ?? '');
  const content = m.get('content');
  if (typeof content === 'string' && content) return content.replace(/<[^>]*>/g, '');
  return childrenOf(m).map(rawTextOf).join('');
}

export const textOf = (m: Component | undefined): string => (m ? tidy(rawTextOf(m)) : '');

const textNodesOf = (m: Component): Component[] => {
  const out: Component[] = [];
  walk(m, (c) => {
    if (isTextNode(c)) out.push(c);
    return !isTextNode(c);
  });
  return out;
};

const rawContent = (n: Component) => String(n.get('content') ?? '');

/**
 * Replaces the text of an element keeping the markup around it: the first visible text node gets
 * the new text, the other visible ones are emptied (`<td><a><b>Old:</b></a></td>` stays a link).
 */
export function setTextKeepMarkup(m: Component | undefined, text: string): void {
  if (!m) return;
  const nodes = textNodesOf(m);
  const visible = nodes.filter((n) => tidy(rawContent(n)) !== '');
  const target = visible[0] ?? nodes[0];
  if (!target) {
    m.components(escapeHtml(text));
    return;
  }
  target.set('content', text);
  visible.slice(1).forEach((n) => n.set('content', ''));
}

/** Visible text segments of an element (one per non-blank text node). */
export const textSegments = (m: Component): string[] =>
  textNodesOf(m)
    .map((n) => tidy(rawContent(n)))
    .filter(Boolean);

/** Rewrites the non-blank text nodes one by one; extra lines join the last node. */
export function setTextSegments(m: Component, values: string[]): void {
  const nodes = textNodesOf(m).filter((n) => tidy(rawContent(n)) !== '');
  if (!nodes.length) {
    if (values.length) m.components(escapeHtml(values.join(' ')));
    return;
  }
  nodes.forEach((n, i) => {
    const isLast = i === nodes.length - 1;
    const value = isLast ? values.slice(i).join(' ') : (values[i] ?? '');
    n.set('content', value);
  });
}

/** Caption of a button: the `value` of `<input type=button>`, otherwise its text. */
export const captionOf = (c: Component | undefined): string =>
  !c ? '' : tagOf(c) === 'input' ? attr(c, 'value') : textOf(c);

export function setCaption(c: Component | undefined, caption: string): void {
  if (!c) return;
  if (tagOf(c) === 'input') setAttr(c, 'value', caption);
  else setTextKeepMarkup(c, caption);
}

/* ---- lists (options, buttons, radios, tabs, columns) -------------------------------------------- */

/** The ancestors of a component, nearest first. */
const ancestorsOf = (c: Component): Component[] => {
  const out: Component[] = [];
  for (let p = c.parent(); p; p = p.parent()) out.push(p);
  return out;
};

/**
 * One "item" (the components that make up one button / radio option) per control. Wrapped controls
 * (`<td><input></td>`, `<label><input>Text</label>`) are their own wrapper; controls that are
 * direct siblings own the nodes that follow them up to the next control (the text of a radio, the
 * `&nbsp;` between buttons).
 */
export function itemsOf(root: Component, controls: Component[]): Component[][] {
  if (!controls.length) return [];
  const chains = controls.map((c) => [c, ...ancestorsOf(c)]);
  let lca: Component | undefined;
  if (controls.length === 1) {
    const parent = controls[0]!.parent();
    lca =
      parent === root || !parent || !['td', 'th', 'label', 'span', 'li'].includes(tagOf(parent))
        ? parent
        : parent.parent();
  } else {
    lca = chains[0]!.find((a) => chains.every((chain) => chain.includes(a)) && a !== controls[0]);
  }
  if (!lca) return controls.map((c) => [c]);
  const tops = chains.map((chain) => chain[chain.indexOf(lca!) - 1] ?? chain[0]!);
  const wrapped = tops.some((t, i) => t !== controls[i]);
  if (wrapped && new Set(tops).size === tops.length) return tops.map((t) => [t]);
  // siblings: each control owns what follows it
  const siblings = childrenOf(lca);
  return tops.map((top, i) => {
    const from = siblings.indexOf(top);
    const nextTop = tops[i + 1];
    const next = nextTop ? siblings.indexOf(nextTop) : siblings.length;
    return siblings.slice(from, Math.max(from + 1, next));
  });
}

/**
 * Makes `items` match `names`: renames in place, appends clones of the last item, removes the
 * trailing ones (always keeps one). Clones keep the markup (tags, classes, attributes) of the item.
 */
export function syncItems(
  items: Component[][],
  names: string[],
  rename: (item: Component[], name: string) => void,
  prepareClone?: (clone: Component[]) => void,
): void {
  const wanted = names.length ? names : [''];
  const have = items.length;
  wanted.slice(0, have).forEach((name, i) => rename(items[i]!, name));
  if (!have) return;
  for (let i = have; i < wanted.length; i++) {
    const last = items[items.length - 1]!;
    const anchor = last[last.length - 1]!;
    const parent = anchor.parent();
    if (!parent) break;
    let at = (anchor.index() ?? 0) + 1;
    const clone = last.map((c) => {
      const copy = c.clone();
      parent.append(copy, { at: at++ });
      return copy;
    });
    prepareClone?.(clone);
    rename(clone, wanted[i] ?? '');
    items.push(clone);
  }
  while (items.length > wanted.length && items.length > 1) {
    items.pop()!.forEach((c) => c.remove());
  }
}

const isFormFieldOrButton = (c: Component) => isFormField(c) || isButtonLike(c);

const contains = (ancestor: Component, node: Component): boolean =>
  ancestor === node || ancestorsOf(node).includes(ancestor);

/** Visible text nodes of an item that are not the caption/value of one of its own controls. */
function ownTextNodes(item: Component[]): Component[] {
  const controls = item
    .flatMap((c) => [c, ...findAll(c, isFormFieldOrButton)])
    .filter(isFormFieldOrButton);
  return item
    .flatMap((c) => (isTextNode(c) ? [c] : textNodesOf(c)))
    .filter((n) => tidy(rawContent(n)) !== '' && !controls.some((f) => contains(f, n)));
}

/** Renames an item: its own text, else the caption of its button, else appends the text. */
export function renameItem(item: Component[], name: string): void {
  const own = ownTextNodes(item);
  if (own.length) {
    own[0]!.set('content', name);
    own.slice(1).forEach((n) => n.set('content', ''));
    return;
  }
  const button = item.flatMap((c) => [c, ...findAll(c, isButtonLike)]).find(isButtonLike);
  if (button) return setCaption(button, name);
  const anchor = item[item.length - 1]!;
  anchor.parent()?.append(escapeHtml(name), { at: (anchor.index() ?? 0) + 1 });
}

/** Text of an item (see `renameItem`). */
export function itemText(item: Component[]): string {
  const own = tidy(ownTextNodes(item).map(rawContent).join(''));
  if (own) return own;
  const button = item.flatMap((c) => [c, ...findAll(c, isButtonLike)]).find(isButtonLike);
  return button ? captionOf(button) : '';
}

/* ---- grid ----------------------------------------------------------------------------------- */

export interface GridParts {
  headerRow?: Component;
  headerCells: Component[];
  rows: Component[];
}

const cellsOf = (row: Component) =>
  elementChildren(row).filter((c) => ['td', 'th'].includes(tagOf(c)));

export function gridParts(root: Component): GridParts {
  const annotated = findAll(root, (c) => partOfAttr(c) === 'header');
  let headerRow: Component | undefined;
  let headerCells: Component[] = [];
  const cellHeaders = annotated.filter((c) => ['th', 'td'].includes(tagOf(c)));
  if (cellHeaders.length) {
    headerCells = cellHeaders;
    headerRow = cellHeaders[0]!.parent();
  } else {
    const holder = annotated[0];
    headerRow =
      holder && tagOf(holder) === 'tr'
        ? holder
        : holder
          ? findAll(holder, (c) => tagOf(c) === 'tr')[0]
          : undefined;
  }
  if (!headerRow) {
    headerRow =
      findAll(root, (c) => tagOf(c) === 'thead')
        .map((t) => findAll(t, (c) => tagOf(c) === 'tr')[0])
        .find(Boolean) ??
      byTag(root, 'tr').find((tr) => elementChildren(tr).some((c) => tagOf(c) === 'th'));
  }
  if (headerRow && !headerCells.length) headerCells = cellsOf(headerRow);

  const inFoot = (tr: Component) =>
    ancestorsOf(tr).some((a) => ['thead', 'tfoot'].includes(tagOf(a)));
  const annotatedRows = findAll(root, (c) => partOfAttr(c) === 'row' && tagOf(c) === 'tr');
  const rows = (annotatedRows.length ? annotatedRows : byTag(root, 'tr'))
    .filter((tr) => tr !== headerRow && !inFoot(tr))
    .filter((tr) => cellsOf(tr).length > 0);
  return { headerRow, headerCells, rows };
}

/** Blanks a cell keeping its markup: no text, a single `&nbsp;`, empty inputs. */
export function blankCell(cell: Component): void {
  const nodes = textNodesOf(cell);
  nodes.forEach((n, i) => n.set('content', i === 0 ? ' ' : ''));
  if (!nodes.length) cell.components('&nbsp;');
  findAll(cell, (c) => tagOf(c) === 'input').forEach((i) => setAttr(i, 'value', ''));
}

export function gridColumns(root: Component): string[] {
  const { headerCells } = gridParts(root);
  return headerCells.map(textOf);
}

export function gridSetColumns(root: Component, names: string[]): void {
  const { headerRow, headerCells, rows } = gridParts(root);
  if (!headerRow || !headerCells.length) return;
  const wanted = names.length ? names : ['Coluna'];
  const have = headerCells.length;
  wanted.slice(0, have).forEach((n, i) => setTextKeepMarkup(headerCells[i], n));
  for (let i = have; i < wanted.length; i++) {
    const last = headerCells[headerCells.length - 1]!;
    const copy = last.clone();
    headerRow.append(copy, { at: (last.index() ?? 0) + 1 });
    setTextKeepMarkup(copy, wanted[i] ?? '');
    headerCells.push(copy);
    rows.forEach((row) => {
      const cells = cellsOf(row);
      const tail = cells[cells.length - 1];
      if (!tail) return;
      const cellCopy = tail.clone();
      row.append(cellCopy, { at: (tail.index() ?? 0) + 1 });
      blankCell(cellCopy);
    });
  }
  while (headerCells.length > wanted.length && headerCells.length > 1) {
    const idx = headerCells.length - 1;
    headerCells.pop()!.remove();
    rows.forEach((row) => {
      const cells = cellsOf(row);
      cells[idx]?.remove();
    });
  }
}

export const gridRowCount = (root: Component) => gridParts(root).rows.length;

/** Adds clones of the last data row (keeping the zebra striping) or removes trailing rows. */
export function gridSetRows(root: Component, count: number): void {
  const { rows } = gridParts(root);
  if (!rows.length) return;
  const wanted = Math.max(1, count);
  const classKey = (r: Component) => r.getClasses().join(' ');
  while (rows.length > wanted) rows.pop()!.remove();
  while (rows.length < wanted) {
    const last = rows[rows.length - 1]!;
    const prev = rows[rows.length - 2];
    const template: Component = prev && classKey(prev) !== classKey(last) ? prev : last;
    const copy = template.clone();
    const parent = last.parent();
    if (!parent) break;
    parent.append(copy, { at: (last.index() ?? 0) + 1 });
    cellsOf(copy).forEach(blankCell);
    rows.push(copy);
  }
}

/* ---- tabs ----------------------------------------------------------------------------------- */

const ACTIVE_CLASS = /(^|-)(active|ativ[oa]|selected|current|on)$/i;
export const tabActiveClass = (tab: Component) =>
  tab.getClasses().find((c) => ACTIVE_CLASS.test(c));

export function tabsActive(root: Component): number {
  const tabs = partsOf(root, 'tab');
  const idx = tabs.findIndex((t) => tabActiveClass(t) || attr(t, 'aria-selected') === 'true');
  return Math.max(0, idx);
}

export function tabsSetActive(root: Component, index: number): void {
  const tabs = partsOf(root, 'tab');
  const cls = tabs.map(tabActiveClass).find(Boolean) ?? 'ec-tab-active';
  tabs.forEach((t, i) => {
    const current = tabActiveClass(t);
    if (i === index) t.addClass(cls);
    else if (current) t.removeClass(current);
  });
}

export function tabsSetNames(root: Component, names: string[]): void {
  const active = tabsActive(root);
  syncItems(
    partsOf(root, 'tab').map((t) => [t]),
    names.length ? names : ['Aba'],
    ([tab], name) => setTextKeepMarkup(tab, name),
  );
  tabsSetActive(root, Math.min(active, partsOf(root, 'tab').length - 1));
}
