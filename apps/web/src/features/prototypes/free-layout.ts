import type { Component } from 'grapesjs';
import { FREE_SOURCE_ATTR, FREE_WRAPPER_ATTR } from '@thinkflow/shared';
import { ecKindOf, elementChildren } from './ec-model';

/*
 * Free layout ("Livre"): the server turns a captured screen into HTML where every component is
 * copied into an absolutely positioned wrapper `<div data-tf-free="n" style="position:absolute;
 * left;top;z-index">` at the end of the body, while the originals stay in place hidden
 * (`data-tf-free-src`). It is still ONE html document: "Livre" and "HTML" are two ways of
 * interacting with it. This file holds the pure helpers (detection, the unit of a wrapper,
 * position / z-order edits); the wiring lives in the adapter, `ec-units.ts` and `component-move.ts`.
 *
 * Groups: a wrapper with `data-tf-group` holds other wrappers (positioned relative to it). A group
 * IS its own unit: a click anywhere inside selects the group, unless the user "entered" it (a
 * double click): then the click goes to the wrapper under the pointer, one level down. The entered
 * state is a runtime flag on the group (never saved): the groups above the selection are open.
 */

export type EditorMode = 'free' | 'html';

const has = (c: Component, name: string): boolean => c.getAttributes()[name] !== undefined;

/** A wrapper that holds other wrappers (`data-tf-free="g" data-tf-group="1"`). */
export const FREE_GROUP_ATTR = 'data-tf-group';

export const isFreeWrapper = (c: Component): boolean => has(c, FREE_WRAPPER_ATTR);
export const isGroup = (c: Component): boolean => isFreeWrapper(c) && has(c, FREE_GROUP_ATTR);
export const isFreeSource = (c: Component): boolean => has(c, FREE_SOURCE_ATTR);

/** Does this saved html hold a free layout? (a cheap check, before any editor exists) */
export const isFreeHtml = (html: string): boolean =>
  new RegExp(`\\s${FREE_WRAPPER_ATTR}(?=[\\s=>/])`).test(html);

/** The outermost free wrappers under `root` (the ones inside a group are not listed). */
export function freeWrappers(root: Component): Component[] {
  const out: Component[] = [];
  const visit = (node: Component) => {
    for (const child of elementChildren(node)) {
      if (isFreeWrapper(child)) out.push(child);
      else if (!isFreeSource(child)) visit(child);
    }
  };
  visit(root);
  return out;
}

/** Every free wrapper under `root`, the ones inside groups too. */
export function allFreeWrappers(root: Component): Component[] {
  const out: Component[] = [];
  const visit = (node: Component) => {
    for (const child of elementChildren(node)) {
      if (isFreeWrapper(child)) out.push(child);
      if (!isFreeSource(child)) visit(child);
    }
  };
  visit(root);
  return out;
}

/** Any `[data-tf-free]` in the document? */
export const isFreeLayout = (root: Component): boolean => freeWrappers(root).length > 0;

/** The wrapper `c` lives in (or is). */
export function freeWrapperOf(c: Component): Component | undefined {
  for (let p: Component | undefined = c; p; p = p.parent()) if (isFreeWrapper(p)) return p;
  return undefined;
}

/** `c` is (inside) a hidden original. */
export function inFreeSource(c: Component): boolean {
  for (let p: Component | undefined = c; p; p = p.parent()) if (isFreeSource(p)) return true;
  return false;
}

/**
 * What a click on a wrapper selects: the outermost recognized e-Cidade component inside it, else
 * its first element (a loose control, an emptied group). A group is its own unit.
 */
export function freeUnitOf(wrapper: Component): Component | undefined {
  if (isGroup(wrapper)) return wrapper;
  let found: Component | undefined;
  const dfs = (node: Component) => {
    for (const child of elementChildren(node)) {
      if (found) return;
      if (ecKindOf(child)) {
        found = child;
        return;
      }
      dfs(child);
    }
  };
  dfs(wrapper);
  return found ?? elementChildren(wrapper)[0];
}

/** The wrapper whose unit is exactly `c` (what Delete / Ctrl+D / drag act on); a group is its own. */
export function wrapperOfUnit(c: Component): Component | undefined {
  if (isGroup(c)) return c;
  const wrapper = freeWrapperOf(c);
  return wrapper && wrapper !== c && freeUnitOf(wrapper) === c ? wrapper : undefined;
}

/* ---- groups: entered state and what a click picks ------------------------------------------------ */

const OPEN_PROP = 'tfOpen';

/** The user is working inside this group (a double click entered it). */
export const isOpenGroup = (g: Component): boolean => g.get(OPEN_PROP as never) === true;

export function setOpenGroup(g: Component, open: boolean): void {
  if (isOpenGroup(g) !== open)
    g.set(OPEN_PROP as never, open as never, { avoidStore: true } as never);
}

/** The groups above `c`, innermost first (`c` itself is not listed). */
export function groupsAbove(c: Component): Component[] {
  const out: Component[] = [];
  for (let p = c.parent(); p; p = p.parent()) if (isGroup(p)) out.push(p);
  return out;
}

/** Opens every group above `c` (what a selection inside a group implies). */
export const openAbove = (c: Component): void =>
  groupsAbove(c).forEach((g) => setOpenGroup(g, true));

/** The wrappers on the way from the document to `c` (itself included), outermost first. */
const wrapperChain = (c: Component): Component[] => {
  const chain: Component[] = [];
  for (let p: Component | undefined = c; p; p = p.parent()) if (isFreeWrapper(p)) chain.unshift(p);
  return chain;
};

/** Set while a row of the layers panel is clicked: it picks the exact wrapper, not its group. */
let deepPick = false;
export const setDeepPick = (on: boolean): void => {
  deepPick = on;
};

/**
 * The wrapper a click on `c` lands on: the outermost one, going one level down through each OPEN
 * group on the way (`deep`: always the innermost, what the layers panel means).
 */
export function pickedWrapper(c: Component, deep = deepPick): Component | undefined {
  const chain = wrapperChain(c);
  if (deep) return chain[chain.length - 1];
  let at = 0;
  while (at + 1 < chain.length && isGroup(chain[at]!) && isOpenGroup(chain[at]!)) at++;
  return chain[at];
}

/** The unit a click on `c` selects (undefined outside any wrapper). */
export function pickedUnit(c: Component, deep = deepPick): Component | undefined {
  const wrapper = pickedWrapper(c, deep);
  return wrapper && freeUnitOf(wrapper);
}

/* ---- numbers ----------------------------------------------------------------------------------- */

const num = (value: unknown): number => {
  const n = parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : 0;
};

export const leftOf = (w: Component): number => num(w.getStyle()?.left);
export const topOf = (w: Component): number => num(w.getStyle()?.top);
export const zOf = (w: Component): number => Math.round(num(w.getStyle()?.['z-index']));

/** Next `data-tf-free` number (a duplicate / a new block gets a fresh one). */
export function nextFreeNumber(root: Component): number {
  let max = 0;
  for (const w of allFreeWrappers(root))
    max = Math.max(max, parseInt(String(w.getAttributes()[FREE_WRAPPER_ATTR]), 10) || 0);
  return max + 1;
}

/** Highest z-index among the wrappers (new ones go on top). */
export const maxZ = (root: Component): number =>
  freeWrappers(root).reduce((max, w) => Math.max(max, zOf(w)), 0);

/* ---- position and order ------------------------------------------------------------------------- */

/** Moves the wrapper by (dx, dy) px: `left` / `top` (one undo step). */
export function nudgeFree(wrapper: Component, dx: number, dy: number): void {
  wrapper.addStyle({
    position: 'absolute',
    left: `${leftOf(wrapper) + dx}px`,
    top: `${topOf(wrapper) + dy}px`,
  });
}

/**
 * One step forward (`1`) / back (`-1`) among the wrappers by `z-index`. Wrappers are ranked by
 * (z-index, document order) and the rank is written back as 1..n, only where it changed; no-op at
 * the ends.
 */
export function moveZ(wrapper: Component, dir: -1 | 1): boolean {
  const parent = wrapper.parent();
  if (!parent) return false;
  const all = elementChildren(parent).filter(isFreeWrapper);
  const order = [...all].sort((a, b) => zOf(a) - zOf(b) || all.indexOf(a) - all.indexOf(b));
  const i = order.indexOf(wrapper);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return false;
  [order[i], order[j]] = [order[j]!, order[i]!];
  order.forEach((w, rank) => {
    if (zOf(w) !== rank + 1) w.addStyle({ 'z-index': String(rank + 1) });
  });
  return true;
}
