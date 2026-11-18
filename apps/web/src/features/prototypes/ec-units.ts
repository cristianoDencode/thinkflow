import type { Component } from 'grapesjs';
import { layerName } from './ec-describe';
import { isLockedDeep } from './layer-lock';
import {
  freeUnitOf,
  isFreeSource,
  isFreeWrapper,
  isGroup,
  isOpenGroup,
  pickedUnit,
  wrapperOfUnit,
} from './free-layout';
import {
  CONTAINER_KINDS,
  childrenOf,
  draggableRuleFor,
  ecKindOf,
  partOfAttr,
  tagOf,
} from './ec-model';

/*
 * Recognized components behave as units: their inner parts (label, input, header cells…) cannot
 * be selected, hovered or dragged on their own — a click selects the whole component. A double
 * click "enters" it (see `enterPart`) and unlocks the clicked part (and its ancestors up to the
 * component) until the selection leaves. Each root also gets a descriptive layer name.
 *
 * Free layout (`data-tf-free`): the hidden originals (`data-tf-free-src`) and everything inside them
 * are locked out of selection, hover, layers and dragging. A free wrapper is never selected itself:
 * clicking it (or the table around a copied row) selects its UNIT (the recognized component inside,
 * or the loose control / group), through GrapesJS' `delegate.select`. The unit has no layer row of
 * its own: the wrapper's row stands for it, with the unit's name.
 * A group (a wrapper that holds wrappers) is its own unit: everything inside it delegates to the
 * group until it is entered (a double click), then to the wrapper under the pointer. Inside a closed
 * group nothing is hoverable, so the highlight is the group's.
 */

const LOCK = { selectable: false, hoverable: false, draggable: false, layerable: false } as const;
const UNLOCK = { selectable: true, hoverable: true, draggable: true, layerable: true } as const;

/** The wrapper of a free layout: it moves, it is not picked. Its layer row stands for the unit. */
const WRAPPER = { selectable: false, hoverable: false, draggable: true, layerable: true } as const;
/** The unit of a wrapper: picked and moved like any component, without its own layer row. */
const UNIT = { selectable: true, hoverable: true, draggable: true, layerable: false } as const;

/** A group: picked, moved and listed like a unit, and it is a wrapper itself. */
const GROUP = { selectable: true, hoverable: true, draggable: true, layerable: true } as const;

type Flags = typeof LOCK | typeof UNLOCK | typeof WRAPPER | typeof UNIT | typeof GROUP;

const isText = (c: Component) => c.is('textnode') || c.get('type') === 'textnode';

/** `quiet`: inside a closed group, where hovering is the group's business. */
function setFlags(c: Component, flags: Flags, quiet = false): void {
  const want: Record<string, unknown> = { ...flags };
  if (quiet) want.hoverable = false;
  if (flags === UNLOCK || flags === UNIT) {
    // unlocking restores the drop rule of the tag (a row only goes into a table section…), never a
    // bare `true`; a layer-locked component stays selectable (from the layers panel) but is never draggable
    want.draggable = isLockedDeep(c) ? false : draggableRuleFor(tagOf(c));
  }
  const changed = Object.keys(want).some((k) => {
    const have = c.get(k as never) as unknown;
    const target = want[k];
    return Array.isArray(target)
      ? !Array.isArray(have) || have.join() !== target.join()
      : (have !== false) !== target;
  });
  if (changed) c.set(want as never, { avoidStore: true } as never);
}

/**
 * GrapesJS `delegate`: a click on a wrapper (or on the table around a copied row) selects the unit
 * inside it, and removing a unit removes its wrapper (no empty `position:absolute` div is left).
 */
const FREE_DELEGATE = {
  select: (c: Component): Component | undefined => pickedUnit(c),
  remove: (c: Component): Component | undefined => wrapperOfUnit(c),
};
function setDelegate(c: Component): void {
  if (c.get('delegate' as never) !== (FREE_DELEGATE as unknown))
    c.set('delegate' as never, FREE_DELEGATE as never, { avoidStore: true } as never);
}

/** Layer name of a group. */
export const GROUP_NAME = 'Grupo';

const contains = (ancestor: Component, c: Component): boolean => {
  for (let p: Component | undefined = c.parent(); p; p = p.parent())
    if (p === ancestor) return true;
  return false;
};

/** A hidden original of a free layout (`data-tf-free-src`) and all its descendants: out of the editor. */
export function hideFreeSource(root: Component): void {
  setFlags(root, LOCK);
  for (const child of childrenOf(root)) if (!isText(child)) hideFreeSource(child);
}

/**
 * (Re)applies locks and layer names to the whole tree. `open` = parts the user entered: they are
 * left unlocked. Idempotent and cheap (one pass; only changed flags are written).
 */
export function applyUnits(root: Component, open: ReadonlySet<Component> = new Set()): void {
  /**
   * `unit`: the unit of the free wrapper being visited (the nodes on the way to it are hidden).
   * `quiet`: inside a closed group: no hover, and every click delegates to the group.
   */
  const visit = (node: Component, locking: boolean, unit?: Component, quiet = false) => {
    for (const child of childrenOf(node)) {
      if (isText(child)) continue;
      if (quiet) setDelegate(child);
      if (isFreeSource(child)) {
        hideFreeSource(child);
        continue;
      }
      if (isFreeWrapper(child)) {
        const group = isGroup(child);
        const target = group ? undefined : freeUnitOf(child);
        setFlags(child, group ? GROUP : WRAPPER, quiet);
        setDelegate(child);
        visit(child, false, target, quiet || (group && !isOpenGroup(child)));
        const name = group ? GROUP_NAME : target?.getName();
        if (name && child.get('name') !== name)
          child.set('name', name, { avoidStore: true } as never);
        continue;
      }
      if (child === unit) setDelegate(child);
      if (unit && child !== unit && contains(child, unit)) {
        // the table / tbody around a copied row: not pickable, a click goes to the unit
        setFlags(child, LOCK);
        setDelegate(child);
        visit(child, false, unit, quiet);
        continue;
      }
      const kind = ecKindOf(child);
      if (kind && !locking) {
        setFlags(child, child === unit ? UNIT : UNLOCK, quiet);
        const name = layerName(child, kind);
        if (child.get('name') !== name) child.set('name', name, { avoidStore: true } as never);
        visit(child, !CONTAINER_KINDS.has(kind), undefined, quiet);
        continue;
      }
      // inside a container only the annotated pieces (legend, tab headers…) are parts
      const part = partOfAttr(child);
      const lockHere = locking || (part !== '' && part !== 'panel');
      setFlags(child, lockHere && !open.has(child) ? LOCK : child === unit ? UNIT : UNLOCK, quiet);
      visit(child, lockHere, undefined, quiet);
    }
  };
  visit(root, false);
}

/** The recognized component a part belongs to (undefined when `c` is not inside one). */
export function unitRootOf(c: Component): Component | undefined {
  let nearest: Component | undefined;
  let outerLeaf: Component | undefined;
  for (let p: Component | undefined = c; p; p = p.parent()) {
    const kind = ecKindOf(p);
    if (!kind) continue;
    nearest ??= p;
    if (!CONTAINER_KINDS.has(kind)) outerLeaf = p; // a component inside a leaf one is just a part
  }
  return outerLeaf ?? nearest;
}

/** The locked part and its locked ancestors up to (excluding) the unit root; [] if nothing is locked. */
export function lockedChain(c: Component): Component[] {
  const root = unitRootOf(c);
  if (!root || root === c) return [];
  const chain: Component[] = [];
  for (let p: Component | undefined = c; p && p !== root; p = p.parent()) chain.push(p);
  return chain.filter((p) => p.get('selectable') === false);
}

/** Unlocks the clicked part (and the locked ancestors above it); returns the chain to keep open. */
export function enterPart(c: Component): Set<Component> {
  const chain = lockedChain(c);
  chain.forEach((p) => setFlags(p, UNLOCK));
  return new Set(chain);
}
