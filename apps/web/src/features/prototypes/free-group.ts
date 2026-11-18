import type { Component } from 'grapesjs';
import { FREE_WRAPPER_ATTR } from '@thinkflow/shared';
import {
  FREE_GROUP_ATTR,
  freeWrapperOf,
  freeWrappers,
  isGroup,
  leftOf,
  maxZ,
  topOf,
  zOf,
} from './free-layout';

/*
 * Grouping in the free layout. A group is a free wrapper that holds other wrappers:
 *   <div data-tf-free="g" data-tf-group="1" style="position:absolute;left;top;width;height;z-index">
 * Its children keep their look: their `left` / `top` become relative to the group (the group sits
 * at the union box of what was grouped) and their `z-index` values are untouched (the group makes
 * its own stacking context). Everything here runs in one call stack, so the UndoManager fuses it
 * into ONE undo step.
 */

const px = (n: number) => `${n}px`;

/**
 * The wrappers a "group" would act on: the wrappers of the selected components (a unit and a part
 * of it count once), at least two, all siblings (same parent), none of them locked. Undefined when
 * the selection cannot be grouped.
 */
export function groupableWrappers(
  selected: readonly Component[],
  isLocked: (c: Component) => boolean = () => false,
): Component[] | undefined {
  const wrappers = new Set<Component>();
  for (const c of selected) {
    const wrapper = freeWrapperOf(c);
    if (!wrapper) return undefined;
    wrappers.add(wrapper);
  }
  const list = [...wrappers];
  const parent = list[0]?.parent();
  if (list.length < 2 || !parent) return undefined;
  if (list.some((w) => w.parent() !== parent || isLocked(w))) return undefined;
  return list;
}

/** The group a "ungroup" would open: exactly one selected component, a group, not locked. */
export function ungroupableGroup(
  selected: readonly Component[],
  isLocked: (c: Component) => boolean = () => false,
): Component | undefined {
  const [only] = selected;
  return selected.length === 1 && only && isGroup(only) && !isLocked(only) ? only : undefined;
}

/**
 * Wraps `wrappers` (siblings) in a new group at their union box, on top of their siblings. The
 * children keep their place on screen and their relative stacking. Returns the group.
 */
export function groupWrappers(wrappers: readonly Component[]): Component {
  const parent = wrappers[0]!.parent()!;
  const ordered = [...wrappers].sort((a, b) => (a.index() ?? 0) - (b.index() ?? 0));
  const boxes = ordered.map((w) => {
    const el = w.getEl();
    const left = leftOf(w);
    const top = topOf(w);
    return {
      w,
      left,
      top,
      right: left + (el?.offsetWidth ?? 0),
      bottom: top + (el?.offsetHeight ?? 0),
    };
  });
  const L = Math.min(...boxes.map((b) => b.left));
  const T = Math.min(...boxes.map((b) => b.top));
  const R = Math.max(...boxes.map((b) => b.right));
  const B = Math.max(...boxes.map((b) => b.bottom));
  const [group] = parent.append({
    tagName: 'div',
    attributes: { [FREE_WRAPPER_ATTR]: 'g', [FREE_GROUP_ATTR]: '1' },
    style: {
      position: 'absolute',
      left: px(L),
      top: px(T),
      width: px(R - L),
      height: px(B - T),
      'z-index': String(maxZ(parent) + 1),
    },
  });
  // an explicit id: a component without one loses its rule when it is cloned (Ctrl+D)
  group!.addAttributes({ id: group!.getId() });
  for (const b of boxes) {
    b.w.move(group!);
    b.w.addStyle({ left: px(b.left - L), top: px(b.top - T) });
  }
  return group!;
}

/** (z-index, document order): the stacking order the editor goes by. */
const stacked = (list: readonly Component[]): Component[] =>
  [...list].sort((a, b) => zOf(a) - zOf(b) || list.indexOf(a) - list.indexOf(b));

/**
 * Dissolves a group: its children go back to the group's parent at their absolute positions (left /
 * top + the group's), in the group's place in the document, and the group is removed. The stacking
 * is kept: the children take the group's slot among its siblings (z-index renumbered 1..n where it
 * changed). Returns the children.
 */
export function ungroupWrapper(group: Component): Component[] {
  const parent = group.parent();
  if (!parent) return [];
  const gl = leftOf(group);
  const gt = topOf(group);
  const kids = freeWrappers(group);
  const order = stacked(freeWrappers(parent)).flatMap((w) => (w === group ? stacked(kids) : [w]));
  const at = group.index() ?? 0;
  kids.forEach((kid, i) => {
    const left = leftOf(kid) + gl;
    const top = topOf(kid) + gt;
    kid.move(parent, { at: at + i });
    kid.addStyle({ left: px(left), top: px(top) });
  });
  order.forEach((w, rank) => {
    if (zOf(w) !== rank + 1) w.addStyle({ 'z-index': String(rank + 1) });
  });
  group.remove();
  return kids;
}
