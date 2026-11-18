import type { Component, Editor } from 'grapesjs';
import { leftOf, moveZ, nudgeFree, topOf } from './free-layout';

/*
 * Moving components. Captured screens are tables whose rows are the fields, so reorganizing a form
 * means changing the ORDER of its rows (the others make room), not shifting pixels:
 *  - click-hold-drag on the selected element (the first click selects) reorders it in the HTML
 *    flow — GrapesJS' `tlb-move` command in flow mode (sorter: a placeholder line, the neighbours
 *    reflow on drop). The toolbar move icon does the same;
 *  - Alt+drag moves it freely with `transform: translate(x, y)`: its original space stays reserved
 *    in the flow, so the neighbours never jump (guides included);
 *  - arrow keys nudge it by 1px (Shift: 10px), always with `transform`;
 *  - Ctrl/⌘ + ArrowUp / ArrowDown move it one position among its siblings (`moveSibling`).
 * Free layout (`opts.freeTarget`): a component inside a `data-tf-free` wrapper moves the WRAPPER
 * instead — a press-drag runs `tlb-move` in `absolute` mode (`left`/`top` with guides), the arrows
 * add ±1px (Shift: 10px) to `left`/`top`, Ctrl+↑/↓ raise / lower its `z-index`. With several units
 * selected, a press-drag on any of them (and the arrows) moves them all: GrapesJS drags the last
 * wrapper and the others follow it by the same distance (`mirror`).
 * GrapesJS writes the transform as `translateX(..) translateY(..)` (it only reads that form back
 * when a drag starts), so every write here uses the same form.
 */

/** `tlb-move` mode of the free (transform) move; any other mode reorders in the flow. */
export const MOVE_DRAG_MODE = 'translate' as const;

/** Pointer distance (px) before a press on a selected element turns into a drag. */
const DRAG_THRESHOLD = 4;
const NUDGE = 1;
const NUDGE_SHIFT = 10;
/** `tlb-move` mode of the free layout: the wrapper follows the pointer with `left` / `top`. */
export const ABSOLUTE_MODE = 'absolute' as const;
/** `tlb-move` mode that is neither `translate` nor `absolute`: reorders in the HTML flow. */
export const FLOW_MODE = 'flow';
/** Widgets of the page that own the arrow keys (menus, sliders, tabs…). */
const ARROW_OWNERS =
  '[role="menu"],[role="menubar"],[role="listbox"],[role="option"],[role="dialog"],[role="alertdialog"],[role="tablist"],[role="radiogroup"],[role="slider"],[role="combobox"],[role="tree"],[role="grid"],[aria-modal="true"]';
const TEXT_FIELD = 'input,textarea,select,[contenteditable=""],[contenteditable="true"]';

export interface ComponentMoveOptions {
  /** True for components that must not be moved (e.g. a locked layer or one inside a locked layer). */
  isLocked?: (c: Component) => boolean;
  /**
   * Free layout: the wrapper that moves in place of `c` (undefined: `c` moves as in the HTML mode,
   * e.g. outside the free mode or outside any wrapper).
   */
  freeTarget?: (c: Component) => Component | undefined;
  /**
   * Keyboard commands of the free layout; each returns true when it did something (the key is then
   * consumed). Same guards as the arrows: never inside a text field, a widget or a text edit.
   */
  keys?: {
    group(): boolean;
    ungroup(): boolean;
    /** Esc: leave the group being edited. */
    leave(): boolean;
  };
}

/* ---- transform helpers ---------------------------------------------------------------------- */

interface Piece {
  /** Lower-case function name, '' for stray text. */
  name: string;
  args: string;
  raw: string;
}

/** Splits a transform into its top-level functions (balanced parentheses; stray text is kept). */
function pieces(transform: string): Piece[] {
  const out: Piece[] = [];
  const s = (transform ?? '').trim();
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i]!)) {
      i++;
      continue;
    }
    const start = i;
    while (i < s.length && !/[\s(]/.test(s[i]!)) i++;
    const name = s.slice(start, i);
    if (s[i] !== '(') {
      out.push({ name: '', args: '', raw: name });
      continue;
    }
    let depth = 0;
    const argsStart = i + 1;
    for (; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) break;
    }
    out.push({ name: name.toLowerCase(), args: s.slice(argsStart, i), raw: s.slice(start, i + 1) });
    i++;
  }
  return out.filter((p) => !(p.name === '' && p.raw.toLowerCase() === 'none'));
}

/** A length in px (a bare `0` too); undefined for anything else (%, em, calc(), var()…). */
function px(value: string): number | undefined {
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))(px)?\s*$/i.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] || n === 0 ? n : undefined;
}

/** `translate`-family piece made only of px values -> its offset; undefined otherwise. */
function pxOffset(p: Piece): { x: number; y: number } | undefined {
  const args = p.args.split(',');
  if (p.name === 'translate' && args.length <= 2) {
    const x = px(args[0]!);
    const y = args[1] === undefined ? 0 : px(args[1]);
    return x === undefined || y === undefined ? undefined : { x, y };
  }
  if (args.length !== 1) return undefined;
  if (p.name === 'translatex') {
    const x = px(args[0]!);
    return x === undefined ? undefined : { x, y: 0 };
  }
  if (p.name === 'translatey') {
    const y = px(args[0]!);
    return y === undefined ? undefined : { x: 0, y };
  }
  return undefined;
}

/**
 * The px translation of a `transform` value (every `translate`, `translateX` and `translateY` made
 * of px values, summed) and `rest`: the other functions, untouched. Missing / `none` -> 0, 0.
 */
export function parseTranslate(transform: string): { x: number; y: number; rest: string } {
  let x = 0;
  let y = 0;
  const rest: string[] = [];
  for (const p of pieces(transform)) {
    const off = pxOffset(p);
    if (off) {
      x += off.x;
      y += off.y;
    } else rest.push(p.raw);
  }
  return { x, y, rest: rest.join(' ') };
}

const num = (n: number) => `${Number(n.toFixed(2))}px`;

/**
 * `transform` moved by (dx, dy). The offset is written as `translateX(..) translateY(..)` (the form
 * GrapesJS reads back), in the slot of the first existing translate, else in front of the other
 * functions; those are preserved.
 */
export function withTranslate(transform: string, dx: number, dy: number): string {
  const { x, y } = parseTranslate(transform);
  const move = `translateX(${num(x + dx)}) translateY(${num(y + dy)})`;
  const out: string[] = [];
  let placed = false;
  for (const p of pieces(transform)) {
    if (pxOffset(p)) {
      if (!placed) out.push(move);
      placed = true;
    } else out.push(p.raw);
  }
  if (!placed) out.unshift(move);
  return out.join(' ');
}

/* ---- decisions ------------------------------------------------------------------------------ */

const isEditable = (el: Element | null | undefined) =>
  !!el?.closest?.('[contenteditable=""],[contenteditable="true"]');

/** The component a click/press landed on (walks up the DOM to the first element with a view). */
export function modelOfElement(start: EventTarget | null): Component | undefined {
  for (let n = start as Element | null; n; n = n.parentElement) {
    const model = (n as unknown as { __gjsv?: { model?: Component } }).__gjsv?.model;
    if (model) return model;
  }
  return undefined;
}

/** True when `c` can be moved at all (not the wrapper, draggable, not locked, not being edited). */
function isMovable(editor: Editor, c: Component, isLocked?: (c: Component) => boolean): boolean {
  if (c === editor.getWrapper() || !c.get('draggable')) return false;
  if (isLocked?.(c)) return false;
  if (editor.getModel().isEditing() || isEditable(c.getEl())) return false;
  return true;
}

/**
 * What a press on `model` would move: the SELECTED component, when the pointer is on it or inside
 * it (a recognized e-Cidade component is a unit whose parts are locked, so a press on one of its
 * parts moves the selected unit root). Undefined when nothing must start: not selected yet (the first click only selects),
 * the wrapper, not draggable, locked, or text being edited.
 */
export function dragTargetFor(
  editor: Editor,
  model: Component | undefined,
  opts: ComponentMoveOptions = {},
): Component | undefined {
  const all = editor.getSelectedAll();
  const selected = editor.getSelected();
  if (!model || !selected) return undefined;
  const isIn = (root: Component) => {
    for (let p: Component | undefined = model; p; p = p.parent()) if (p === root) return true;
    return false;
  };
  if (all.length > 1) {
    // free layout: a press on any of several selected units moves them all (each by its wrapper)
    const hit = opts.freeTarget && all.find(isIn);
    const movable = (c: Component) => opts.freeTarget?.(c) && isMovable(editor, c, opts.isLocked);
    return hit && all.every(movable) ? hit : undefined;
  }
  if (!isIn(selected)) return undefined;
  return isMovable(editor, selected, opts.isLocked) ? selected : undefined;
}

/** Components an arrow key would nudge (empty when the keys must be left alone). */
function nudgeTargets(editor: Editor, opts: ComponentMoveOptions): Component[] {
  const all = editor.getSelectedAll();
  if (!all.length || all.some((c) => !isMovable(editor, c, opts.isLocked))) return [];
  return all;
}

/** Arrow keys that belong to a text field, a menu or other widget of the page, not to the canvas. */
function keyBelongsToPage(ev: KeyboardEvent, canvasDoc?: Document | null): boolean {
  const t = ev.target as Element | null;
  // inside the canvas the inputs and buttons are prototype content (a click focuses them): only
  // the text editor owns the keys there, and that is `isEditing`
  if (canvasDoc && t?.ownerDocument === canvasDoc) return !!t.closest?.('[contenteditable="true"]');
  if (t?.closest?.(TEXT_FIELD) || t?.closest?.(ARROW_OWNERS)) return true;
  const active = t?.ownerDocument?.activeElement;
  return !!(active && (active.matches?.(TEXT_FIELD) || active.closest?.(ARROW_OWNERS)));
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Moves `c` by (dx, dy) px (one undo step). */
function nudge(c: Component, dx: number, dy: number): void {
  const current = String(c.getStyle()?.transform ?? '');
  c.addStyle({ transform: withTranslate(current, dx, dy) });
}

/** Does `c` have a non-zero px translation (what Alt+drag / the arrow keys leave)? */
export function hasOffset(c: Component): boolean {
  const { x, y } = parseTranslate(String(c.getStyle()?.transform ?? ''));
  return x !== 0 || y !== 0;
}

/**
 * Drops the px translation of `c`, keeping any other transform function; the `transform` property
 * goes away when nothing else remains. One undo step; false when there was no offset.
 */
export function resetOffset(c: Component): boolean {
  const style = { ...(c.getStyle() ?? {}) } as Record<string, unknown>;
  const { x, y, rest } = parseTranslate(String(style.transform ?? ''));
  if (x === 0 && y === 0) return false;
  if (rest) style.transform = rest;
  else delete style.transform;
  c.setStyle(style as never);
  return true;
}

const isElementNode = (c: Component) => !c.is('textnode') && c.get('type') !== 'comment';

/**
 * Moves the selected component one position among its ELEMENT siblings (text nodes and comments
 * between them are skipped), keeping it selected. No-op for the wrapper, a multiple selection, the
 * first / last element, a component that cannot be dragged, or a locked one. One undo step.
 */
export function moveSibling(
  editor: Editor,
  dir: -1 | 1,
  isLocked?: (c: Component) => boolean,
): boolean {
  const sel = editor.getSelected();
  const parent = sel?.parent();
  if (!sel || !parent || sel === editor.getWrapper() || editor.getSelectedAll().length > 1)
    return false;
  if (!sel.get('draggable') || isLocked?.(sel)) return false;
  const siblings = (parent.components() as unknown as { models: Component[] }).models;
  const elements = siblings.filter(isElementNode);
  const neighbour = elements[elements.indexOf(sel) + dir];
  if (!neighbour) return false;
  // `Component.move` reads `at` before the removal: after the neighbour = its index + 1
  sel.move(parent, { at: siblings.indexOf(neighbour) + (dir > 0 ? 1 : 0) });
  if (editor.getSelected() !== sel) editor.select(sel);
  return true;
}

/* ---- wiring --------------------------------------------------------------------------------- */

type Evt = MouseEvent & { _parentEvent?: Event };
interface Pending {
  startX: number;
  startY: number;
  event: MouseEvent;
  /** What `tlb-move` drags: one component, or several wrappers (the one under the pointer last). */
  target: Component | Component[];
  /** `tlb-move` mode: flow (reorder), translate (Alt) or absolute (free layout wrapper). */
  mode: string;
}

export function installComponentMove(
  editor: Editor,
  opts: ComponentMoveOptions = {},
): { destroy(): void } {
  let doc: Document | null = null;
  let pending: Pending | null = null;
  let noSelect = false;
  /**
   * A drag of several wrappers: GrapesJS moves the last one, the others follow by the same
   * distance. Armed by `tlb-move` (it knows every target), started and ended by the drag events.
   */
  let armed: Component[] | null = null;
  let mirror: {
    lead: Component;
    left: number;
    top: number;
    rest: { wrapper: Component; left: number; top: number }[];
  } | null = null;

  const frameDoc = () => editor.Canvas.getDocument() ?? null;

  const cancelPending = () => {
    pending = null;
    doc?.removeEventListener('mousemove', onMove, true);
  };

  /** No text selection while the element follows the pointer. */
  const onSelectStart = (ev: Event) => {
    if (noSelect) ev.preventDefault();
  };
  const setNoSelect = (on: boolean) => {
    noSelect = on;
    if (on) doc?.getSelection?.()?.removeAllRanges();
  };

  const onMouseDown = (raw: Event) => {
    const ev = raw as MouseEvent;
    cancelPending();
    // GrapesJS flags the end of an absolute drag (`_cmpDrag`) to swallow the click that follows. That
    // click arrives while its select command is still stopped (`tlb-move` restarts it in a timeout),
    // or never reaches the canvas (released over a toolbar, outside the frame): the flag is not
    // consumed and the NEXT real click would be ignored. Every new press starts clean.
    editor.getModel().set('_cmpDrag' as never, undefined as never);
    // Shift / Ctrl / ⌘ + click is multi-selection; Alt picks the free (translate) move
    if (ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
    const target = dragTargetFor(editor, modelOfElement(ev.target), opts);
    if (!target) return;
    const wrapper = opts.freeTarget?.(target);
    let dragged: Component | Component[] = wrapper ?? target;
    const all = editor.getSelectedAll();
    if (wrapper && all.length > 1) {
      // several wrappers: the one under the pointer is dragged by GrapesJS, so it goes last
      const others = [...new Set(all.map((c) => opts.freeTarget?.(c)))].filter(
        (w): w is Component => !!w && w !== wrapper,
      );
      dragged = [...others, wrapper];
    }
    pending = {
      startX: ev.clientX,
      startY: ev.clientY,
      event: ev,
      target: dragged,
      mode: wrapper ? ABSOLUTE_MODE : ev.altKey ? MOVE_DRAG_MODE : FLOW_MODE,
    };
    doc?.addEventListener('mousemove', onMove, true);
  };

  const onMove = (raw: Event) => {
    const ev = raw as MouseEvent;
    if (!pending) return;
    if (ev.buttons === 0) return cancelPending(); // released outside the window
    if (Math.hypot(ev.clientX - pending.startX, ev.clientY - pending.startY) < DRAG_THRESHOLD)
      return;
    const { target, event, mode } = pending;
    cancelPending();
    startDrag(target, event, mode);
  };

  /** GrapesJS only reads `translateX(..) translateY(..)` back: rewrite other forms before dragging. */
  const normalizeTransform = (c: Component) => {
    const current = String(c.getStyle()?.transform ?? '');
    if (!/translate/i.test(current)) return;
    const next = withTranslate(current, 0, 0);
    if (next !== current) c.addStyle({ transform: next }, { avoidStore: true } as never);
  };

  const startDrag = (target: Component | Component[], event: MouseEvent, mode: string) => {
    if (mode === MOVE_DRAG_MODE && !Array.isArray(target)) normalizeTransform(target);
    setNoSelect(true);
    // The sorter of the flow mode binds `mousemove` / `mouseup` to the document of the element it
    // sorts, i.e. the canvas frame, where this press started: no coordinate conversion needed.
    // The press position (not the current one): a free move follows the pointer from where it was.
    editor.runCommand('tlb-move', { target, event, mode });
  };

  /**
   * We start every drag ourselves (pointer events), so the browser's own HTML5 drag, with its ghost
   * image, is always suppressed inside the canvas.
   */
  const onDragStart = (ev: Event) => {
    if (editor.getModel().isEditing()) return;
    if (!modelOfElement(ev.target)) return;
    ev.preventDefault();
    ev.stopPropagation();
  };

  /** Ctrl+G / Ctrl+Shift+G / Esc of the free layout; true when the key was consumed. */
  const handleCommandKey = (
    ev: KeyboardEvent,
    keys: NonNullable<ComponentMoveOptions['keys']>,
  ): boolean => {
    const mod = ev.ctrlKey || ev.metaKey;
    const group = mod && ev.key.toLowerCase() === 'g';
    const leave = !mod && !ev.shiftKey && ev.key === 'Escape';
    if (!group && !leave) return false;
    if (keyBelongsToPage(ev, doc) || editor.getModel().isEditing()) return false;
    const done = leave ? keys.leave() : ev.shiftKey ? keys.ungroup() : keys.group();
    if (done) ev.preventDefault();
    return done;
  };

  const onKeyDown = (raw: Event) => {
    const ev = raw as KeyboardEvent & { _parentEvent?: Event };
    // the canvas forwards its keys to the top document: the iframe listener already handled them
    if (ev._parentEvent || ev.defaultPrevented) return;
    if (opts.keys && !ev.altKey && handleCommandKey(ev, opts.keys)) return;
    const step = ARROWS[ev.key];
    if (!step || ev.altKey) return;
    // Ctrl/⌘ + ArrowUp/Down: one position up/down among the siblings
    if (ev.ctrlKey || ev.metaKey) {
      if (ev.shiftKey || step[1] === 0 || keyBelongsToPage(ev, doc)) return;
      if (editor.getModel().isEditing()) return;
      const dir = step[1] < 0 ? -1 : 1;
      const sel = editor.getSelected();
      const wrapper =
        sel && editor.getSelectedAll().length === 1 ? opts.freeTarget?.(sel) : undefined;
      if (wrapper) {
        if (!opts.isLocked?.(wrapper) && moveZ(wrapper, dir === -1 ? 1 : -1)) ev.preventDefault();
        return;
      }
      if (moveSibling(editor, dir, opts.isLocked)) ev.preventDefault();
      return;
    }
    if (keyBelongsToPage(ev, doc)) return;
    const targets = nudgeTargets(editor, opts);
    if (!targets.length) return;
    ev.preventDefault();
    const size = ev.shiftKey ? NUDGE_SHIFT : NUDGE;
    // free layout: the wrapper of each target moves (once, even when two targets share one)
    const moved = new Set<Component>();
    targets.forEach((c) => {
      const wrapper = opts.freeTarget?.(c);
      if (!wrapper) return nudge(c, step[0] * size, step[1] * size);
      if (moved.has(wrapper)) return;
      moved.add(wrapper);
      nudgeFree(wrapper, step[0] * size, step[1] * size);
    });
  };

  /**
   * Toolbar move icon (and any other `tlb-move` without a mode): respect locks; the move reorders
   * in the flow, with Alt it translates. The event is `command:run:before:<id>`; the
   * `run:tlb-move:before` GrapesJS' own preview code listens to is never fired.
   */
  const onBeforeMove = (payload: { options?: Record<string, unknown> }) => {
    const o = payload?.options;
    if (!o) return;
    const raw = o.target;
    let targets = (Array.isArray(raw) ? raw : raw ? [raw] : editor.getSelectedAll()) as Component[];
    // free layout: the toolbar move icon moves the wrapper, freely
    const wrappers = targets.map((c) => opts.freeTarget?.(c));
    if (!o.mode && wrappers.length && wrappers.every(Boolean)) {
      targets = [...new Set(wrappers as Component[])];
      o.target = targets.length === 1 ? targets[0] : targets;
      o.mode = ABSOLUTE_MODE;
    }
    armed = null;
    if (targets.some((c) => opts.isLocked?.(c))) {
      o.abort = true;
      return;
    }
    if (o.mode === ABSOLUTE_MODE && targets.length > 1) armed = targets;
    if (o.mode) return;
    // the toolbar passes a plain-object copy of the press (no `altKey`): use the one we recorded
    const alt = (o.event as MouseEvent | undefined)?.altKey || altOnPress;
    o.mode = alt ? MOVE_DRAG_MODE : FLOW_MODE;
  };

  /** Alt state of the last press in the top document (where the toolbar lives). */
  let altOnPress = false;
  const onTopMouseDown = (ev: MouseEvent) => {
    altOnPress = ev.altKey;
  };

  /**
   * The Dragger of `core:component-drag` reads pointer positions from whatever event it gets. Ours
   * start inside the canvas iframe (iframe coordinates); events of the top document (the pointer
   * left the frame) are converted to the same space, and the copies the canvas forwards to the top
   * document are replaced by the original event.
   */
  const patchDragger = () => {
    const cmd = editor.Commands.get('core:component-drag') as unknown as {
      dragger?: { setOptions(o: Record<string, unknown>): void };
    };
    cmd?.dragger?.setOptions({
      getPointerPosition: (raw: Event) => {
        const ev = ((raw as Evt)._parentEvent ?? raw) as MouseEvent & {
          touches?: ArrayLike<MouseEvent>;
        };
        const p = ev.touches?.[0] ?? ev;
        const inFrame = (ev.target as Node | null)?.ownerDocument === frameDoc();
        const el = editor.Canvas.getFrameEl();
        if (inFrame || !el) return { x: p.clientX, y: p.clientY };
        const r = el.getBoundingClientRect();
        const mlt = editor.Canvas.getZoomMultiplier();
        return { x: (p.clientX - r.left) * mlt, y: (p.clientY - r.top) * mlt };
      },
    });
  };
  const onDragModeStart = () => patchDragger();

  /** The other wrappers of a multiple drag follow the lead one, by the distance it has moved. */
  const follow = (end: boolean) => {
    if (!mirror) return;
    const dx = leftOf(mirror.lead) - mirror.left;
    const dy = topOf(mirror.lead) - mirror.top;
    for (const o of mirror.rest) {
      o.wrapper.addStyle(
        { left: `${o.left + dx}px`, top: `${o.top + dy}px`, __p: !end } as never,
        { avoidStore: !end } as never,
      );
    }
  };
  const onGroupDragStart = () => {
    const targets = armed;
    armed = null;
    const lead = targets?.[targets.length - 1];
    if (!targets || !lead) return;
    const at = (w: Component) => ({ wrapper: w, left: leftOf(w), top: topOf(w) });
    mirror = { lead, left: leftOf(lead), top: topOf(lead), rest: targets.slice(0, -1).map(at) };
  };
  const onGroupDrag = () => follow(false);
  const onDragModeEnd = () => setNoSelect(false);
  /** The flow sorter has no `dmode:end`: `component:drag:end` closes both kinds of move. */
  const onDragEnd = () => {
    follow(true); // the final position, stored (one undo step with the lead's)
    mirror = null;
    setNoSelect(false);
  };

  /* ---- bind / unbind -------------------------------------------------------------------- */
  const onMouseUp = () => {
    cancelPending();
    setNoSelect(false);
  };
  const bindDoc = () => {
    // the canvas document is replaced while the editor loads: bind to the current one, once
    if (doc && doc === frameDoc()) return;
    unbindDoc();
    doc = frameDoc();
    if (!doc) return;
    doc.addEventListener('mousedown', onMouseDown, true);
    doc.addEventListener('mouseup', onMouseUp, true);
    doc.addEventListener('dragstart', onDragStart, true);
    doc.addEventListener('selectstart', onSelectStart, true);
    doc.addEventListener('keydown', onKeyDown);
  };
  const unbindDoc = () => {
    cancelPending();
    if (!doc) return;
    doc.removeEventListener('mousedown', onMouseDown, true);
    doc.removeEventListener('mouseup', onMouseUp, true);
    doc.removeEventListener('dragstart', onDragStart, true);
    doc.removeEventListener('selectstart', onSelectStart, true);
    doc.removeEventListener('keydown', onKeyDown);
    doc = null;
  };

  bindDoc();
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onTopMouseDown, true);
  editor.on('canvas:frame:load', bindDoc);
  // `canvas:frame:load` may fire before this module is installed (the frame model exists only
  // once the editor finished loading), so the final document is bound on `load` too
  editor.on('load', bindDoc);
  editor.on('command:run:before:tlb-move', onBeforeMove);
  editor.on('dmode:start', onDragModeStart);
  editor.on('dmode:end', onDragModeEnd);
  editor.on('component:drag:start', onGroupDragStart);
  editor.on('component:drag', onGroupDrag);
  editor.on('component:drag:end', onDragEnd);

  return {
    destroy() {
      unbindDoc();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('mousedown', onTopMouseDown, true);
      editor.off('canvas:frame:load', bindDoc);
      editor.off('load', bindDoc);
      editor.off('command:run:before:tlb-move', onBeforeMove);
      editor.off('dmode:start', onDragModeStart);
      editor.off('dmode:end', onDragModeEnd);
      editor.off('component:drag:start', onGroupDragStart);
      editor.off('component:drag', onGroupDrag);
      editor.off('component:drag:end', onDragEnd);
      noSelect = false;
      armed = mirror = null;
    },
  };
}
