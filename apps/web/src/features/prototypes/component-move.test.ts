import grapesjs, { type Component, type Editor } from 'grapesjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dragTargetFor,
  hasOffset,
  installComponentMove,
  parseTranslate,
  resetOffset,
  withTranslate,
} from './component-move';

describe('parseTranslate', () => {
  it('reads nothing from empty / none', () => {
    expect(parseTranslate('')).toEqual({ x: 0, y: 0, rest: '' });
    expect(parseTranslate('none')).toEqual({ x: 0, y: 0, rest: '' });
    expect(parseTranslate('  ')).toEqual({ x: 0, y: 0, rest: '' });
  });

  it('reads translate(x, y), translate(x), translateX and translateY', () => {
    expect(parseTranslate('translate(10px, 5px)')).toEqual({ x: 10, y: 5, rest: '' });
    expect(parseTranslate('translate(10px,-5.5px)')).toEqual({ x: 10, y: -5.5, rest: '' });
    expect(parseTranslate('translate(10px)')).toEqual({ x: 10, y: 0, rest: '' });
    expect(parseTranslate('translate(0, 7px)')).toEqual({ x: 0, y: 7, rest: '' });
    expect(parseTranslate('translateX(-3px)')).toEqual({ x: -3, y: 0, rest: '' });
    expect(parseTranslate('translateY(4px)')).toEqual({ x: 0, y: 4, rest: '' });
    expect(parseTranslate('translateX(12px) translateY(-8px)')).toEqual({ x: 12, y: -8, rest: '' });
  });

  it('sums several translates and keeps every other function untouched', () => {
    expect(parseTranslate('translate(1px, 2px) translateX(3px)')).toEqual({ x: 4, y: 2, rest: '' });
    expect(parseTranslate('rotate(10deg) translateX(5px) scale(1.5, 2)')).toEqual({
      x: 5,
      y: 0,
      rest: 'rotate(10deg) scale(1.5, 2)',
    });
  });

  it('leaves non-px translates (%, em, calc, var) in rest', () => {
    expect(parseTranslate('translate(50%, 10px)')).toEqual({
      x: 0,
      y: 0,
      rest: 'translate(50%, 10px)',
    });
    expect(parseTranslate('translateX(calc(1px + 2px)) translateY(3px)')).toEqual({
      x: 0,
      y: 3,
      rest: 'translateX(calc(1px + 2px))',
    });
    expect(parseTranslate('var(--t)')).toEqual({ x: 0, y: 0, rest: 'var(--t)' });
  });
});

describe('withTranslate', () => {
  it('writes the form GrapesJS reads back (translateX/translateY)', () => {
    expect(withTranslate('', 1, 0)).toBe('translateX(1px) translateY(0px)');
    expect(withTranslate('none', -10, 10)).toBe('translateX(-10px) translateY(10px)');
    expect(withTranslate(undefined as unknown as string, 2, 3)).toBe(
      'translateX(2px) translateY(3px)',
    );
  });

  it('adds to the current offset, whatever form it had', () => {
    expect(withTranslate('translate(10px, 5px)', 1, -1)).toBe('translateX(11px) translateY(4px)');
    expect(withTranslate('translate(10px)', 0, 10)).toBe('translateX(10px) translateY(10px)');
    expect(withTranslate('translateX(3px) translateY(4px)', 10, 0)).toBe(
      'translateX(13px) translateY(4px)',
    );
    expect(withTranslate('translateY(4px)', 1, 0)).toBe('translateX(1px) translateY(4px)');
  });

  it('is a no-op shape for (0, 0) on the canonical form and rounds float noise', () => {
    const t = 'translateX(7px) translateY(-2px)';
    expect(withTranslate(t, 0, 0)).toBe(t);
    expect(withTranslate('translate(0.1px, 0px)', 0.2, 0)).toBe(
      'translateX(0.3px) translateY(0px)',
    );
  });

  it('preserves the other functions and the slot of the translate', () => {
    expect(withTranslate('rotate(45deg)', 1, 1)).toBe(
      'translateX(1px) translateY(1px) rotate(45deg)',
    );
    expect(withTranslate('rotate(45deg) translateX(2px)', 1, 0)).toBe(
      'rotate(45deg) translateX(3px) translateY(0px)',
    );
    expect(withTranslate('translate(50%, 0) translateX(2px)', 1, 0)).toBe(
      'translate(50%, 0) translateX(3px) translateY(0px)',
    );
  });
});

/* ---- editor ----------------------------------------------------------------------------- */

let host: HTMLElement;
let editor: Editor;
let move: { destroy(): void } | undefined;
let locked: Set<Component>;

const setup = async (html: string) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = grapesjs.init({
    container: host.appendChild(document.createElement('div')),
    fromElement: false,
    storageManager: false,
    panels: { defaults: [] },
    avoidInlineStyle: true,
    undoManager: { trackSelection: false },
    components: html,
  });
  await new Promise<void>((resolve) => {
    if (editor.Canvas.getDocument()) resolve();
    else editor.on('load', () => resolve());
  });
  locked = new Set();
  move = installComponentMove(editor, { isLocked: (c) => locked.has(c) });
};

beforeEach(async () => {
  await setup('<div id="a" class="box">A</div><p id="b">B</p><input id="i" />');
});
afterEach(async () => {
  await tick(); // GrapesJS finishes a drag on timers
  move?.destroy();
  editor.destroy();
  host.remove();
});

const byId = (id: string) => editor.getWrapper()!.find(`#${id}`)[0]!;
const key = (k: string, init: KeyboardEventInit = {}, on: EventTarget = document.body) => {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  on.dispatchEvent(ev);
  return ev;
};
const transformOf = (c: Component) => c.getStyle().transform as string | undefined;
/** Real key presses are separate ticks (the undo manager fuses what happens in one). */
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

describe('arrow keys nudge the selected component', () => {
  it('moves 1px (Shift: 10px) with transform, undoable', async () => {
    const a = byId('a');
    editor.select(a);
    const ev = key('ArrowRight');
    expect(ev.defaultPrevented).toBe(true);
    expect(transformOf(a)).toBe('translateX(1px) translateY(0px)');
    await tick();
    key('ArrowDown', { shiftKey: true });
    expect(transformOf(a)).toBe('translateX(1px) translateY(10px)');
    await tick();
    key('ArrowLeft', { shiftKey: true });
    await tick();
    key('ArrowUp');
    expect(transformOf(a)).toBe('translateX(-9px) translateY(9px)');
    // the flow is untouched: no position / left / top
    expect(a.getStyle()).not.toHaveProperty('left');
    expect(a.getStyle()).not.toHaveProperty('position');
    editor.UndoManager.undo();
    expect(transformOf(a)).toBe('translateX(-9px) translateY(10px)');
    editor.UndoManager.undo();
    editor.UndoManager.undo();
    editor.UndoManager.undo();
    expect(transformOf(a) ?? '').toBe('');
  });

  it('continues from a translate written elsewhere and keeps other functions', () => {
    const a = byId('a');
    a.addStyle({ transform: 'rotate(5deg) translate(10px, 5px)' });
    editor.select(a);
    key('ArrowRight');
    expect(transformOf(a)).toBe('rotate(5deg) translateX(11px) translateY(5px)');
  });

  it('does nothing with the wrapper selected or with nothing selected', () => {
    editor.select(editor.getWrapper()!);
    expect(key('ArrowRight').defaultPrevented).toBe(false);
    expect(editor.getWrapper()!.getStyle().transform).toBeUndefined();
    editor.select();
    expect(key('ArrowRight').defaultPrevented).toBe(false);
  });

  it('does nothing for a locked component (isLocked)', () => {
    const a = byId('a');
    editor.select(a);
    locked.add(a);
    const ev = key('ArrowRight');
    expect(ev.defaultPrevented).toBe(false);
    expect(transformOf(a)).toBeUndefined();
  });

  it('does nothing for a component that is not draggable', () => {
    const a = byId('a');
    a.set('draggable', false);
    editor.select(a);
    expect(key('ArrowRight').defaultPrevented).toBe(false);
    expect(transformOf(a)).toBeUndefined();
  });

  it('leaves the keys to inputs, textareas, selects, contenteditable and menus of the page', () => {
    const a = byId('a');
    editor.select(a);
    const field = (tag: string, attrs: Record<string, string> = {}) => {
      const el = document.body.appendChild(document.createElement(tag));
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      return el;
    };
    const input = field('input');
    input.focus();
    expect(key('ArrowRight', {}, input).defaultPrevented).toBe(false);
    // focus in the field, even when the event target is something else
    expect(key('ArrowRight', {}, document.body).defaultPrevented).toBe(false);
    input.remove();
    for (const [tag, attrs] of [
      ['textarea', {}],
      ['select', {}],
      ['div', { contenteditable: 'true' }],
      ['div', { role: 'menu' }],
    ] as const) {
      const el = field(tag, attrs);
      expect(key('ArrowRight', {}, el).defaultPrevented).toBe(false);
      el.remove();
    }
    expect(transformOf(a)).toBeUndefined();
    // back on the page body it works again
    expect(key('ArrowRight').defaultPrevented).toBe(true);
    expect(transformOf(a)).toBe('translateX(1px) translateY(0px)');
  });

  it('ignores other keys and modified arrows', () => {
    const a = byId('a');
    editor.select(a);
    expect(key('a').defaultPrevented).toBe(false);
    expect(key('ArrowRight', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key('ArrowRight', { altKey: true }).defaultPrevented).toBe(false);
    expect(transformOf(a)).toBeUndefined();
  });

  it('does not nudge while a component is being edited as text', () => {
    const b = byId('b');
    editor.select(b);
    editor.getModel().setEditing(b.view as never);
    expect(key('ArrowRight').defaultPrevented).toBe(false);
    expect(transformOf(b)).toBeUndefined();
  });

  it('stops listening after destroy', () => {
    const a = byId('a');
    editor.select(a);
    move!.destroy();
    expect(key('ArrowRight').defaultPrevented).toBe(false);
    expect(transformOf(a)).toBeUndefined();
  });
});

describe('dragTargetFor (the start decision of click-hold-drag)', () => {
  it('moves the selected component when the press is on it, not before it is selected', () => {
    const a = byId('a');
    expect(dragTargetFor(editor, a)).toBeUndefined(); // the first click only selects
    editor.select(a);
    expect(dragTargetFor(editor, a)).toBe(a);
  });

  it('a press inside the selected component (a part) moves the selected one', () => {
    editor.addComponents('<div id="w"><span id="s">x</span></div>');
    const w = byId('w');
    editor.select(w);
    expect(dragTargetFor(editor, byId('s'))).toBe(w);
  });

  it('ignores a press elsewhere, on the wrapper, on locked, undraggable or edited components', () => {
    const a = byId('a');
    const b = byId('b');
    editor.select(a);
    expect(dragTargetFor(editor, b)).toBeUndefined();
    expect(dragTargetFor(editor, undefined)).toBeUndefined();
    editor.select(editor.getWrapper()!);
    expect(dragTargetFor(editor, editor.getWrapper()!)).toBeUndefined();
    editor.select(a);
    expect(dragTargetFor(editor, a, { isLocked: (c) => c === a })).toBeUndefined();
    editor.getModel().setEditing(a.view as never);
    expect(dragTargetFor(editor, a)).toBeUndefined();
    editor.getModel().setEditing(false);
    a.set('draggable', false);
    expect(dragTargetFor(editor, a)).toBeUndefined();
  });

  it('does not start with several components selected', () => {
    editor.select([byId('a'), byId('b')]);
    expect(dragTargetFor(editor, byId('a'))).toBeUndefined();
  });
});

describe('native drag and toolbar move', () => {
  const doc = () => editor.Canvas.getDocument()!;
  const BEFORE = 'command:run:before:tlb-move';
  /** The modes `tlb-move` was asked to run in (registered after ours, so it sees the final mode). */
  const recordModes = () => {
    const modes: unknown[] = [];
    editor.on(BEFORE, (p: { options: { mode?: unknown } }) => modes.push(p.options.mode));
    return modes;
  };
  /** Ends a flow move left open (the sorter binds listeners to the canvas document). */
  const endFlow = () => {
    doc().dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  };

  it('always suppresses the browser drag (ghost image) in the canvas: we start drags on the pointer', () => {
    const el = byId('a').getEl()!;
    const modes = recordModes();
    const dragstart = (init: { altKey?: boolean }) => {
      const ev = Object.assign(new Event('dragstart', { bubbles: true, cancelable: true }), init);
      el.dispatchEvent(ev);
      return ev;
    };
    expect(dragstart({}).defaultPrevented).toBe(true);
    expect(dragstart({ altKey: true }).defaultPrevented).toBe(true);
    expect(modes).toEqual([]); // GrapesJS never saw it
  });

  it('the toolbar move icon reorders in the flow; with Alt it translates', () => {
    const modes = recordModes();
    editor.select(byId('a'));
    editor.runCommand('tlb-move', { target: byId('a') });
    endFlow();
    // the toolbar hands over a plain copy of the press: the Alt state comes from the last press
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, altKey: true }));
    editor.runCommand('tlb-move', { target: byId('a') });
    editor.stopCommand('core:component-drag');
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    editor.runCommand('tlb-move', { target: byId('a') });
    endFlow();
    expect(modes).toEqual(['flow', 'translate', 'flow']);
  });

  it('aborts the toolbar move of a locked component', () => {
    const a = byId('a');
    editor.select(a);
    locked.add(a);
    let ran = false;
    editor.on('command:run:tlb-move', () => (ran = true));
    editor.runCommand('tlb-move', { target: a });
    expect(ran).toBe(false);
    locked.clear();
    editor.runCommand('tlb-move', { target: a });
    expect(ran).toBe(true);
    endFlow();
  });

  // jsdom reports `which: 0` for synthetic mouse events, which the Dragger reads as "released"
  const mouse = (type: string, x: number, y: number, init: MouseEventInit = {}) => {
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      buttons: 1,
      ...init,
    });
    Object.defineProperty(ev, 'which', { value: 1 });
    return ev;
  };

  it('press, move past the threshold and release reorders in the flow (no transform)', async () => {
    const a = byId('a');
    editor.select(a);
    const el = a.getEl()!;
    const modes = recordModes();
    el.dispatchEvent(mouse('mousedown', 10, 10));
    el.dispatchEvent(mouse('mousemove', 12, 11)); // under the 4px threshold
    expect(modes).toEqual([]);
    el.dispatchEvent(mouse('mousemove', 30, 25)); // starts the drag
    expect(modes).toEqual(['flow']);
    // the GrapesJS sorter took over: the element is frozen, no translate dragger is running
    expect(a.get('status')).toBe('freezed-selected');
    expect(editor.Commands.isActive('core:component-drag')).toBe(false);
    doc().dispatchEvent(mouse('mousemove', 40, 30));
    doc().dispatchEvent(mouse('mouseup', 40, 30));
    expect(transformOf(a)).toBeUndefined();
    await tick(); // GrapesJS reselects on a timer after a drag
    expect(editor.getSelected()).toBe(a);
  });

  it('Alt + press, move and release translates the selected element', async () => {
    const a = byId('a');
    editor.select(a);
    const el = a.getEl()!;
    const modes = recordModes();
    el.dispatchEvent(mouse('mousedown', 10, 10, { altKey: true }));
    el.dispatchEvent(mouse('mousemove', 12, 11)); // under the 4px threshold
    expect(transformOf(a)).toBeUndefined();
    el.dispatchEvent(mouse('mousemove', 30, 25)); // starts the drag
    expect(modes).toEqual(['translate']);
    doc().dispatchEvent(mouse('mousemove', 40, 30));
    doc().dispatchEvent(mouse('mouseup', 40, 30));
    expect(transformOf(a)!.trim()).toBe('translateX(30px) translateY(20px)');
    expect(a.getStyle()).not.toHaveProperty('position');
    await tick();
  });

  it('a second Alt drag continues from the nudged / dragged offset', async () => {
    const a = byId('a');
    editor.select(a);
    key('ArrowRight', { shiftKey: true }); // translateX(10px) translateY(0px)
    const el = a.getEl()!;
    el.dispatchEvent(mouse('mousedown', 0, 0, { altKey: true }));
    el.dispatchEvent(mouse('mousemove', 6, 0));
    doc().dispatchEvent(mouse('mousemove', 20, 5));
    doc().dispatchEvent(mouse('mouseup', 20, 5));
    expect(transformOf(a)!.trim()).toBe('translateX(30px) translateY(5px)');
    await tick();
  });

  it('a translate written in another form is normalized before the Alt drag (no double offset)', async () => {
    const a = byId('a');
    a.addStyle({ transform: 'translate(10px, 5px)' });
    editor.select(a);
    const el = a.getEl()!;
    el.dispatchEvent(mouse('mousedown', 0, 0, { altKey: true }));
    el.dispatchEvent(mouse('mousemove', 6, 0));
    doc().dispatchEvent(mouse('mousemove', 40, 0));
    doc().dispatchEvent(mouse('mouseup', 40, 0));
    expect(transformOf(a)!.trim()).toBe('translateX(50px) translateY(5px)');
    await tick();
  });

  it('an unselected element is not moved by a press-drag (the first click selects)', () => {
    const b = byId('b');
    const el = b.getEl()!;
    const modes = recordModes();
    el.dispatchEvent(mouse('mousedown', 10, 10));
    el.dispatchEvent(mouse('mousemove', 50, 50));
    el.dispatchEvent(mouse('mouseup', 50, 50));
    el.dispatchEvent(mouse('mousedown', 10, 10, { altKey: true }));
    el.dispatchEvent(mouse('mousemove', 50, 50));
    el.dispatchEvent(mouse('mouseup', 50, 50));
    expect(modes).toEqual([]);
    expect(transformOf(b)).toBeUndefined();
  });

  it('Shift / Ctrl presses (multi-selection) never start a drag', () => {
    const a = byId('a');
    editor.select(a);
    const el = a.getEl()!;
    const modes = recordModes();
    for (const init of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      el.dispatchEvent(mouse('mousedown', 10, 10, init));
      el.dispatchEvent(mouse('mousemove', 50, 50));
      el.dispatchEvent(mouse('mouseup', 50, 50));
    }
    expect(modes).toEqual([]);
  });
});

describe('Ctrl/⌘ + ArrowUp / ArrowDown move the selection among its siblings', () => {
  const order = () =>
    (editor.getWrapper()!.components() as unknown as { models: Component[] }).models
      .map((c) => c.getId())
      .filter((id) => ['a', 'b', 'i'].includes(id));

  it('Ctrl+ArrowDown / Ctrl+ArrowUp swap with the neighbour, keep the selection, one undo step', async () => {
    const a = byId('a');
    editor.select(a);
    const ev = key('ArrowDown', { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(order()).toEqual(['b', 'a', 'i']);
    expect(editor.getSelected()).toBe(a);
    expect(transformOf(a)).toBeUndefined(); // not a nudge
    await tick();
    key('ArrowDown', { metaKey: true });
    expect(order()).toEqual(['b', 'i', 'a']);
    await tick();
    // at the end: nothing to do, the key is left alone
    expect(key('ArrowDown', { ctrlKey: true }).defaultPrevented).toBe(false);
    key('ArrowUp', { ctrlKey: true });
    expect(order()).toEqual(['b', 'a', 'i']);
    editor.UndoManager.undo();
    expect(order()).toEqual(['b', 'i', 'a']);
    editor.UndoManager.undo();
    expect(order()).toEqual(['b', 'a', 'i']);
    editor.UndoManager.undo();
    expect(order()).toEqual(['a', 'b', 'i']);
  });

  it('skips text nodes between sibling elements and ignores the wrapper, locks and other keys', () => {
    editor.setComponents('<div id="a">A</div> text <!-- c --><p id="b">B</p>');
    editor.select(byId('a'));
    key('ArrowDown', { ctrlKey: true });
    expect(order()).toEqual(['b', 'a']);
    key('ArrowUp', { ctrlKey: true });
    expect(order()).toEqual(['a', 'b']);
    // first element: no-op
    expect(key('ArrowUp', { ctrlKey: true }).defaultPrevented).toBe(false);
    // locked / wrapper / nothing selected / Shift or Alt variants
    locked.add(byId('a'));
    expect(key('ArrowDown', { ctrlKey: true }).defaultPrevented).toBe(false);
    locked.clear();
    expect(key('ArrowDown', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(key('ArrowDown', { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(key('ArrowRight', { ctrlKey: true }).defaultPrevented).toBe(false);
    editor.select(editor.getWrapper()!);
    expect(key('ArrowDown', { ctrlKey: true }).defaultPrevented).toBe(false);
    editor.select();
    expect(key('ArrowDown', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(order()).toEqual(['a', 'b']);
  });

  it('moves a table row among its rows, past text nodes', () => {
    editor.setComponents(
      '<table><tbody><tr id="r1"><td>1</td></tr><tr id="r2"><td>2</td></tr><tr id="r3"><td>3</td></tr></tbody></table>',
    );
    const rows = () =>
      (byId('r1').parent()!.components() as unknown as { models: Component[] }).models.map((c) =>
        c.getId(),
      );
    editor.select(byId('r2'));
    key('ArrowDown', { ctrlKey: true });
    expect(rows()).toEqual(['r1', 'r3', 'r2']);
    expect(editor.getSelected()).toBe(byId('r2'));
  });

  it('leaves the keys to inputs, menus and text editing', () => {
    editor.select(byId('a'));
    const input = document.body.appendChild(document.createElement('input'));
    input.focus();
    expect(key('ArrowDown', { ctrlKey: true }, input).defaultPrevented).toBe(false);
    input.remove();
    const menu = document.body.appendChild(document.createElement('div'));
    menu.setAttribute('role', 'menu');
    expect(key('ArrowDown', { ctrlKey: true }, menu).defaultPrevented).toBe(false);
    menu.remove();
    editor.getModel().setEditing(byId('a').view as never);
    expect(key('ArrowDown', { ctrlKey: true }).defaultPrevented).toBe(false);
    editor.getModel().setEditing(false);
    expect(order()).toEqual(['a', 'b', 'i']);
  });

  it('forwarded copies of a key (from the canvas) are not handled twice', () => {
    editor.select(byId('a'));
    const ev = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.assign(ev, { _parentEvent: new Event('keydown') });
    document.body.dispatchEvent(ev);
    expect(order()).toEqual(['a', 'b', 'i']);
  });
});

describe('resetOffset / hasOffset', () => {
  it('removes only the translate and drops the property when nothing is left', async () => {
    const a = byId('a');
    expect(hasOffset(a)).toBe(false);
    expect(resetOffset(a)).toBe(false);
    a.addStyle({ transform: 'translateX(5px) translateY(-3px)', color: 'red' });
    await tick(); // the undo manager fuses what happens in one tick
    expect(hasOffset(a)).toBe(true);
    expect(resetOffset(a)).toBe(true);
    expect(a.getStyle()).not.toHaveProperty('transform');
    expect(a.getStyle().color).toBe('red');
    expect(hasOffset(a)).toBe(false);
    editor.UndoManager.undo();
    expect(transformOf(a)).toBe('translateX(5px) translateY(-3px)');
  });

  it('keeps the other transform functions', () => {
    const a = byId('a');
    a.addStyle({ transform: 'rotate(5deg) translate(10px, 5px)' });
    expect(resetOffset(a)).toBe(true);
    expect(transformOf(a)).toBe('rotate(5deg)');
    expect(hasOffset(a)).toBe(false);
    // a zero offset is not an offset
    a.addStyle({ transform: 'translateX(0px) translateY(0px)' });
    expect(hasOffset(a)).toBe(false);
  });
});
