import grapesjs, { type Component, type Editor } from 'grapesjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorAdapter } from './editor-adapter';
import { enterPart } from './ec-units';
import { createGrapesAdapter } from './grapes-adapter';
import {
  allFreeWrappers,
  freeUnitOf,
  freeWrapperOf,
  freeWrappers,
  isFreeHtml,
  isFreeLayout,
  moveZ,
  wrapperOfUnit,
} from './free-layout';

/*
 * A free layout as the server delivers it: the originals stay in place hidden (`data-tf-free-src`),
 * and each component is copied into an absolutely positioned wrapper at the end of the body with
 * its computed styles inlined.
 */
const FREE_HTML = `<body class="tela" style="position:relative">
<table class="layout"><tbody>
<tr data-ec="field" data-tf-free-src="1" style="visibility:hidden"><td class="rotulo" data-ec-part="label"><b>Data Emissão:</b></td><td class="campo"><input data-ec-part="input" type="text" name="dt" /></td></tr>
</tbody></table>
<fieldset data-ec="fieldset" data-tf-free-src="2" style="visibility:hidden"><legend data-ec-part="legend">Consulta Empenho</legend></fieldset>
<input type="button" value="Limpar campos" data-tf-free-src="3" style="visibility:hidden" />
<div data-tf-free="1" style="position:absolute;left:40px;top:30px;z-index:1"><table style="border-collapse:collapse"><tbody><tr data-ec="field" style="height:22px"><td class="rotulo" data-ec-part="label" style="width:120px;color:rgb(0, 0, 102)"><b>Data Emissão:</b></td><td class="campo"><input data-ec-part="input" type="text" name="dt" style="width:80px" /></td></tr></tbody></table></div>
<div data-tf-free="2" style="position:absolute;left:200px;top:80px;z-index:2"><fieldset data-ec="fieldset" style="width:300px;height:120px"><legend data-ec-part="legend">Consulta Empenho</legend></fieldset></div>
<div data-tf-free="3" style="position:absolute;left:20px;top:300px;z-index:3"><input type="button" value="Limpar campos" style="width:90px" /></div>
</body>`;

const CSS = 'body.tela{margin:0}';

let host: HTMLElement;
let adapter: EditorAdapter;
let editor: Editor;

beforeEach(async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  const el = () => host.appendChild(document.createElement('div'));
  const init = vi.spyOn(grapesjs, 'init');
  adapter = createGrapesAdapter({
    canvas: el(),
    blocks: el(),
    layers: el(),
    styles: el(),
    traits: el(),
    onSave: () => {},
  });
  editor = init.mock.results[0]!.value as Editor;
  init.mockRestore();
  let frameLoaded = false;
  let settled = false;
  editor.once('canvas:frame:load', () => (frameLoaded = true));
  // the end of a frame (re)size: GrapesJS resumes its select command, then emits this
  editor.on('frame:updated', () => (settled = frameLoaded));
  await vi.waitFor(() => expect(editor.Canvas.getFrame()).toBeTruthy());
  adapter.load({ html: FREE_HTML, css: CSS, width: 1280, height: 720 });
  // The frame document loads asynchronously and replaces the first one: the pointer handlers
  // (selection, drag, Shift + click) are bound on `canvas:frame:load`. Rendering it, and sizing the
  // frame, pause GrapesJS' select command during a 350ms animation: wait until it is over.
  const animating = () => !!host.querySelector('.gjs-frame-wrapper--anim');
  const ready = () => {
    expect(settled).toBe(true);
    expect(animating()).toBe(false);
    expect(editor.Commands.isActive('select-comp')).toBe(true);
    expect(editor.getWrapper()!.getEl()?.ownerDocument).toBe(editor.Canvas.getDocument());
  };
  await vi.waitFor(ready, { timeout: 5000 });
  await tick(); // a size change still pending (debounced) would start another animation
  await vi.waitFor(ready, { timeout: 5000 });
  await tick();
});
afterEach(async () => {
  await tick();
  adapter.destroy();
  host.remove();
});

/** Fires a GrapesJS event with a partial payload (the real ones carry much more). */
const fire = (name: string, ...args: unknown[]) =>
  (editor as unknown as { trigger(n: string, ...a: unknown[]): void }).trigger(name, ...args);
const tick = () => new Promise<void>((r) => setTimeout(r, 5));
const body = () => editor.getWrapper()!;
const wrapperN = (n: number) =>
  allFreeWrappers(body()).find((w) => w.getAttributes()['data-tf-free'] === String(n))!;
const sources = () => all((c) => c.getAttributes()['data-tf-free-src'] !== undefined);
function all(pred: (c: Component) => boolean): Component[] {
  const out: Component[] = [];
  const visit = (c: Component) =>
    (c.components() as unknown as { models: Component[] }).models.forEach((child) => {
      if (pred(child)) out.push(child);
      visit(child);
    });
  visit(body());
  return out;
}
const descendants = (c: Component): Component[] =>
  (c.components() as unknown as { models: Component[] }).models.flatMap((child) => [
    child,
    ...descendants(child),
  ]);
const key = (k: string, init: KeyboardEventInit = {}) => {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(ev);
  return ev;
};
const style = (c: Component) => c.getStyle() as Record<string, string>;
const unitOf = (n: number) => freeUnitOf(wrapperN(n))!;
/** What the engine reports of a mouse event (jsdom has no `which`). */
const mouse = (type: string, x: number, y: number, init: MouseEventInit = {}) => {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    buttons: type === 'mouseup' ? 0 : 1,
    ...init,
  });
  Object.defineProperty(ev, 'which', { value: 1 });
  return ev;
};
/** jsdom has no layout: give a wrapper the size its content would have. */
const sized = (n: number, w: number, h: number) => {
  const el = wrapperN(n).getEl()!;
  Object.defineProperty(el, 'offsetWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: h, configurable: true });
};
/** Press, move past the threshold, drag, release (what the user does on `el`). */
const drag = (
  el: Element,
  from: [number, number],
  to: [number, number],
  init: MouseEventInit = {},
) => {
  const doc = editor.Canvas.getDocument()!;
  el.dispatchEvent(mouse('mousedown', from[0], from[1], init));
  el.dispatchEvent(mouse('mousemove', from[0] + 20, from[1] + 15, init));
  doc.dispatchEvent(mouse('mousemove', to[0], to[1], init));
  doc.dispatchEvent(mouse('mouseup', to[0], to[1], init));
};

describe('detection', () => {
  it('knows a free layout from plain html', () => {
    expect(isFreeLayout(body())).toBe(true);
    expect(isFreeHtml(adapter.getSnapshot().html)).toBe(true);
    expect(isFreeHtml('<body><div data-tf-free-src="1">x</div></body>')).toBe(false);
    expect(isFreeHtml('<body><p>x</p></body>')).toBe(false);
    adapter.load({ html: '<body><p>x</p></body>', css: '', width: 800, height: 600 });
    expect(isFreeLayout(body())).toBe(false);
  });

  it('the unit of a wrapper is the recognized component, or the loose control', () => {
    expect(unitOf(1).get('tagName')).toBe('tr');
    expect(unitOf(2).get('tagName')).toBe('fieldset');
    expect(unitOf(3).get('tagName')).toBe('input');
    expect(wrapperOfUnit(unitOf(1))).toBe(wrapperN(1));
    expect(wrapperOfUnit(wrapperN(1))).toBeUndefined();
  });
});

describe('hidden originals and units', () => {
  it('the originals (and everything inside) are out of selection, hover, layers and dragging', () => {
    const originals = sources();
    expect(originals).toHaveLength(3);
    const flat = originals.flatMap((o) => [o, ...descendants(o)]);
    for (const o of flat.filter((c) => !c.is('textnode'))) {
      expect(o.get('selectable')).toBe(false);
      expect(o.get('hoverable')).toBe(false);
      expect(o.get('layerable')).toBe(false);
      expect(o.get('draggable')).toBe(false);
    }
    // the cells of the hidden row too
    const row = originals[0]!;
    const cells = (row.components() as unknown as { models: Component[] }).models;
    expect(cells.length).toBeGreaterThan(0);
    cells.forEach((c) => expect(c.get('selectable')).toBe(false));
  });

  it('a component added later with the attribute is hidden right away, and applyUnits does not flip it back', async () => {
    const added = body().append('<div data-tf-free-src="9"><p>x</p></div>')[0]!;
    expect(added.get('selectable')).toBe(false); // synchronously, before the debounced pass
    await new Promise((r) => setTimeout(r, 400));
    expect(added.get('selectable')).toBe(false);
    expect(added.components().at(0).get('layerable')).toBe(false);
  });

  it('the wrapper is not selectable; the recognized component inside is, and so is the loose control', () => {
    expect(wrapperN(1).get('selectable')).toBe(false);
    expect(wrapperN(1).get('hoverable')).toBe(false);
    expect(wrapperN(1).get('draggable')).toBe(true);
    // the table around a copied row is not pickable either
    const table = (wrapperN(1).components() as unknown as { models: Component[] }).models[0]!;
    expect(table.get('selectable')).toBe(false);
    expect(unitOf(1).get('selectable')).toBe(true);
    expect(unitOf(3).get('selectable')).toBe(true);
    // clicks on the wrapper / its table land on the unit (GrapesJS delegate)
    editor.getModel().setSelected(wrapperN(1), { useValid: true });
    expect(editor.getSelected()).toBe(unitOf(1));
    editor.select(undefined as never);
    editor.getModel().setSelected(table, { useValid: true });
    expect(editor.getSelected()).toBe(unitOf(1));
    editor.select(undefined as never);
    editor.getModel().setSelected(wrapperN(3), { useValid: true });
    expect(editor.getSelected()).toBe(unitOf(3));
  });

  it('the layers show one row per wrapper, named after its unit (the unit has none)', () => {
    expect(wrapperN(1).get('layerable')).toBe(true);
    expect(wrapperN(1).getName()).toBe(unitOf(1).getName());
    expect(unitOf(1).get('layerable')).toBe(false);
  });

  it('Delete removes the wrapper with its unit (no empty absolute div is left)', () => {
    editor.select(unitOf(3));
    editor.runCommand('core:component-delete');
    expect(freeWrappers(body())).toHaveLength(2);
    adapter.load({ html: FREE_HTML, css: CSS, width: 1280, height: 720 });
    editor.select(unitOf(2));
    adapter.run('delete');
    expect(freeWrappers(body())).toHaveLength(2);
    expect(adapter.getSnapshot().html).not.toContain('Consulta Empenho</legend></fieldset></div>');
  });

  it('Ctrl+D copies the whole wrapper, in front and a bit to the side', () => {
    editor.select(unitOf(3));
    key('d', { ctrlKey: true });
    adapter.run('duplicate');
    const ws = freeWrappers(body());
    expect(ws).toHaveLength(4);
    const copy = ws[3]!;
    expect(style(copy).left).toBe('32px');
    expect(style(copy).top).toBe('312px');
    expect(Number(style(copy)['z-index'])).toBeGreaterThan(3);
    expect(copy.getAttributes()['data-tf-free']).toBe('4');
    expect(editor.getSelected()).toBe(freeUnitOf(copy));
    // the original keeps its own rule (the clone does not share it)
    expect(style(wrapperN(3)).left).toBe('20px');
  });
});

describe('free mode', () => {
  beforeEach(() => adapter.setMode('free'));

  it('reports the mode and switches the global drag mode', () => {
    expect(adapter.getState().mode).toBe('free');
    expect(editor.getModel().get('dmode')).toBe('absolute');
    adapter.setMode('html');
    expect(adapter.getState().mode).toBe('html');
    expect(editor.getModel().get('dmode')).toBe('');
  });

  it('selecting is not an edit: no undo step (the resize handles are set out of the history)', () => {
    editor.UndoManager.clear();
    const unit = freeUnitOf(wrapperN(3))!;
    unit.set('resizable', undefined as never, { avoidStore: true } as never);
    editor.select(unit);
    editor.select(freeUnitOf(wrapperN(1))!);
    expect(unit.get('resizable')).toBeTruthy();
    expect(editor.UndoManager.hasUndo()).toBe(false);
  });

  it('the arrows move the wrapper (left / top), 1px or 10px with Shift, not a translate', () => {
    editor.select(unitOf(1));
    key('ArrowRight');
    expect(style(wrapperN(1)).left).toBe('41px');
    key('ArrowDown', { shiftKey: true });
    expect(style(wrapperN(1)).top).toBe('40px');
    key('ArrowLeft', { shiftKey: true });
    expect(style(wrapperN(1)).left).toBe('31px');
    expect(style(unitOf(1)).transform).toBeUndefined();
    expect(adapter.getState().selectionOffset).toBe(false);
  });

  it('a locked wrapper does not move', () => {
    wrapperN(1).addAttributes({ 'data-tf-locked': '1' });
    editor.select(unitOf(1));
    key('ArrowRight');
    expect(style(wrapperN(1)).left).toBe('40px');
  });

  it('Ctrl+↑ brings the wrapper forward, Ctrl+↓ sends it back (z-index among wrappers)', () => {
    editor.select(unitOf(1));
    key('ArrowUp', { ctrlKey: true });
    expect(style(wrapperN(1))['z-index']).toBe('2');
    expect(style(wrapperN(2))['z-index']).toBe('1');
    expect(editor.getSelected()).toBe(unitOf(1));
    key('ArrowUp', { ctrlKey: true });
    key('ArrowUp', { ctrlKey: true }); // already in front: nothing
    expect(style(wrapperN(1))['z-index']).toBe('3');
    key('ArrowDown', { ctrlKey: true });
    expect(style(wrapperN(1))['z-index']).toBe('2');
    expect(style(wrapperN(3))['z-index']).toBe('3');
  });

  it('moveZ ranks equal z-indexes by document order', () => {
    wrapperN(2).addStyle({ 'z-index': '1' });
    wrapperN(3).addStyle({ 'z-index': '1' });
    expect(moveZ(wrapperN(1), 1)).toBe(true);
    expect(freeWrappers(body()).map((w) => style(w)['z-index'])).toEqual(['2', '1', '3']);
    expect(moveZ(wrapperN(3), 1)).toBe(false);
  });

  it('the toolbar move icon and a press-drag run an absolute move of the WRAPPER', () => {
    const calls: { target: unknown; mode: unknown }[] = [];
    editor.on(
      'command:run:before:tlb-move',
      (p: { options: { target?: unknown; mode?: unknown } }) =>
        calls.push({ target: p.options.target, mode: p.options.mode }),
    );
    editor.select(unitOf(1));
    editor.runCommand('tlb-move', { target: unitOf(1) });
    editor.stopCommand('core:component-drag');
    expect(calls[0]).toEqual({ target: wrapperN(1), mode: 'absolute' });
  });

  it('dragging the selected unit moves the wrapper by the pointer distance', async () => {
    const u = unitOf(3);
    editor.select(u);
    const el = u.getEl()!;
    const doc = editor.Canvas.getDocument()!;
    const mouse = (type: string, x: number, y: number) => {
      const ev = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        buttons: 1,
      });
      Object.defineProperty(ev, 'which', { value: 1 });
      return ev;
    };
    el.dispatchEvent(mouse('mousedown', 10, 10));
    el.dispatchEvent(mouse('mousemove', 30, 25));
    doc.dispatchEvent(mouse('mousemove', 50, 40));
    doc.dispatchEvent(mouse('mouseup', 50, 40));
    expect(style(wrapperN(3)).left).toBe('60px');
    expect(style(wrapperN(3)).top).toBe('330px');
    expect(style(u).left).toBeUndefined();
    await tick();
  });

  it('every component gets all eight resize handles, in px, without writing top/left', () => {
    editor.select(unitOf(2));
    const resizable = unitOf(2).get('resizable') as Record<string, unknown>;
    for (const h of ['tl', 'tc', 'tr', 'cl', 'cr', 'bl', 'bc', 'br'])
      expect(resizable[h]).toBeTruthy();
    expect(resizable.skipPositionUpdate).toBe(true);
    // a component picked later gets them too
    editor.select(unitOf(3));
    expect((unitOf(3).get('resizable') as Record<string, unknown>).tl).toBeTruthy();
  });

  it('the group can be stretched on X: its explicit width is what the resize writes', () => {
    editor.select(unitOf(2));
    expect(style(unitOf(2)).width).toBe('300px');
    unitOf(2).addStyle({ width: '420px' });
    expect(adapter.getSnapshot().css).toMatch(/width:\s*420px/);
  });

  it('a left / top handle moves the wrapper by the size change; right / bottom never move it', () => {
    const handle = (name: string) => {
      const el = document.createElement('div');
      el.setAttribute('data-gjs-handler', name);
      return { target: el } as unknown as Event;
    };
    editor.select(unitOf(2));
    const left0 = parseFloat(String(style(wrapperN(2)).left));
    const top0 = parseFloat(String(style(wrapperN(2)).top));
    // top-left handle: 30px wider and 10px taller → the wrapper moves 30px left and 10px up
    fire('component:resize', {
      type: 'start',
      component: unitOf(2),
      event: handle('tl'),
      rect: { w: 200, h: 40 },
    });
    const s1: Record<string, unknown> = { width: '230px', height: '50px', left: '9px', top: '9px' };
    fire('component:resize:update', { rect: { w: 230, h: 50 }, style: s1, partial: true });
    expect(style(wrapperN(2)).left).toBe(`${left0 - 30}px`);
    expect(style(wrapperN(2)).top).toBe(`${top0 - 10}px`);
    expect(s1).not.toHaveProperty('left'); // the unit itself never gets left / top
    fire('component:resize', { type: 'end' });
    // right-middle handle: only the width changes, the wrapper stays where it is
    fire('component:resize', {
      type: 'start',
      component: unitOf(2),
      event: handle('cr'),
      rect: { w: 230, h: 50 },
    });
    fire('component:resize:update', { rect: { w: 100, h: 50 }, style: {}, partial: true });
    expect(style(wrapperN(2)).left).toBe(`${left0 - 30}px`);
    expect(style(wrapperN(2)).top).toBe(`${top0 - 10}px`);
    fire('component:resize', { type: 'end' });
    fire('component:resize:update', { rect: { w: 1, h: 1 } });
    expect(style(wrapperN(2)).left).toBe(`${left0 - 30}px`); // no resize running: untouched
  });

  it('a click on a palette block inserts it in a NEW wrapper with left/top, in front, selected', () => {
    const before = freeWrappers(body()).length;
    const tile = Array.from(host.querySelectorAll<HTMLElement>('[data-proto-block]')).find(
      (t) => t.querySelector('.proto-block-name')?.textContent === 'Botão',
    );
    expect(tile).toBeTruthy();
    tile!.closest<HTMLElement>('.gjs-block')!.click();
    const ws = freeWrappers(body());
    expect(ws).toHaveLength(before + 1);
    const fresh = ws[ws.length - 1]!;
    expect(fresh.getAttributes()['data-tf-free']).toBe('4');
    expect(style(fresh).position).toBe('absolute');
    expect(style(fresh).left).toMatch(/^\d+px$/);
    expect(style(fresh).top).toMatch(/^\d+px$/);
    expect(Number(style(fresh)['z-index'])).toBe(4);
    expect(editor.getSelected()).toBe(freeUnitOf(fresh));
    expect(adapter.getSnapshot().html).toMatch(/<div data-tf-free="4"/);
  });

  it('a block with css keeps its rules when inserted in a wrapper', () => {
    adapter.insertBlock({ html: '<p class="nota">olá</p>', css: '.nota{color:#ff0000}' });
    expect(adapter.getSnapshot().css).toContain('.nota{color:#ff0000;}');
    const ws = freeWrappers(body());
    expect(ws[ws.length - 1]!.toHTML()).toContain('olá');
    expect(ws[ws.length - 1]!.toHTML()).not.toContain('<style');
  });

  it('a block dropped in absolute mode (left/top on its root) moves into a wrapper at that spot', () => {
    const dropped = body().append('<p id="solto">solto</p>')[0]!;
    dropped.addStyle({ position: 'absolute', left: '123px', top: '45px' });
    fire('block:drag:stop', dropped, undefined);
    const wrapper = freeWrapperOf(dropped)!;
    expect(wrapper).toBeTruthy();
    expect(wrapper).not.toBe(dropped);
    expect(style(wrapper).left).toBe('123px');
    expect(style(wrapper).top).toBe('45px');
    expect(style(wrapper).position).toBe('absolute');
    expect(style(dropped).left).toBeUndefined();
    expect(style(dropped).position).toBeUndefined();
  });

  it('the parts of a copied component stay locked until entered (as in the HTML mode)', () => {
    const label = (unitOf(1).components() as unknown as { models: Component[] }).models[0]!;
    expect(label.get('selectable')).toBe(false);
    const open = enterPart(label);
    expect(label.get('selectable')).toBe(true);
    expect(open.has(label)).toBe(true);
  });
});

describe('html mode', () => {
  it('keeps the flow behaviour: nudges are translates, Ctrl+↑ reorders siblings, handles are the 3 of before', () => {
    expect(adapter.getState().mode).toBe('html');
    editor.select(unitOf(3));
    key('ArrowRight');
    expect(style(unitOf(3)).transform).toBe('translateX(1px) translateY(0px)');
    expect(style(wrapperN(3)).left).toBe('20px');
    const resizable = unitOf(3).get('resizable') as Record<string, unknown>;
    expect(resizable.tl).toBeFalsy();
    expect(resizable.br).toBeTruthy();
  });

  it('switching modes swaps the handles of the selection', () => {
    editor.select(unitOf(3));
    expect((unitOf(3).get('resizable') as Record<string, unknown>).tl).toBeFalsy();
    adapter.setMode('free');
    expect((unitOf(3).get('resizable') as Record<string, unknown>).tl).toBeTruthy();
    expect(editor.getSelected()).toBe(unitOf(3));
    adapter.setMode('html');
    expect((unitOf(3).get('resizable') as Record<string, unknown>).tl).toBeFalsy();
  });

  it('a click on a block inserts in the flow, not in a wrapper', () => {
    const before = freeWrappers(body()).length;
    adapter.insertBlock({ html: '<p>fluxo</p>', css: '' });
    expect(freeWrappers(body())).toHaveLength(before);
  });
});

describe('style edits over the inlined styles of a copy', () => {
  it('the inline styles became component rules: the Style Manager edit replaces them (one rule, new value wins)', () => {
    const label = (unitOf(1).components() as unknown as { models: Component[] }).models[0]!;
    expect(style(label).color).toBe('rgb(0, 0, 102)');
    label.addStyle({ color: 'rgb(255, 0, 0)' });
    const { html, css } = adapter.getSnapshot();
    const id = label.getId();
    expect(html).not.toMatch(/style="[^"]*color/);
    const rules = css.match(new RegExp(`#${id}\\{[^}]*\\}`, 'g')) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('color:rgb(255, 0, 0)');
    expect(rules[0]).not.toContain('rgb(0, 0, 102)');
    expect(rules[0]).toContain('width:120px'); // the other inlined values are still there
  });

  it('survives a save and a reload: the edited value is what shows', () => {
    const label = (unitOf(1).components() as unknown as { models: Component[] }).models[0]!;
    label.addStyle({ color: 'rgb(1, 2, 3)' });
    const snapshot = adapter.getSnapshot();
    adapter.load({ ...snapshot, width: 1280, height: 720 });
    const again = (unitOf(1).components() as unknown as { models: Component[] }).models[0]!;
    expect(style(again).color).toBe('rgb(1, 2, 3)');
    expect(isFreeLayout(body())).toBe(true);
  });
});

describe('state', () => {
  it('revision grows with every content change, not with selection or mode', async () => {
    const start = adapter.getState().revision;
    editor.select(unitOf(3));
    adapter.setMode('free');
    await new Promise((r) => setTimeout(r, 700));
    expect(adapter.getState().revision).toBe(start);
    key('ArrowRight');
    await new Promise((r) => setTimeout(r, 700));
    expect(adapter.getState().revision).toBeGreaterThan(start);
    expect(adapter.getState().dirty).toBe(true);
  });

  it('is interacting while a resize or a drag runs', () => {
    expect(adapter.isInteracting?.()).toBe(false);
    fire('component:resize', { type: 'start' });
    expect(adapter.isInteracting?.()).toBe(true);
    fire('component:resize', { type: 'end' });
    expect(adapter.isInteracting?.()).toBe(false);
  });
});

describe('groups', () => {
  beforeEach(() => {
    adapter.setMode('free');
    sized(1, 100, 22);
    sized(2, 300, 120);
    sized(3, 90, 20);
  });
  const groups = () => allFreeWrappers(body()).filter((w) => w.getAttributes()['data-tf-group']);
  const group = () => groups()[0]!;
  const group12 = () => {
    editor.select([unitOf(1), unitOf(2)]);
    adapter.run('group');
    return group();
  };

  it('Group: one group wrapper at the union box, the children keep their place (relative left/top)', () => {
    editor.select([unitOf(1), unitOf(2)]);
    expect(adapter.getState().canGroup).toBe(true);
    expect(adapter.getState().canUngroup).toBe(false);
    adapter.run('group');
    const g = group();
    expect(groups()).toHaveLength(1);
    expect(g.getAttributes()['data-tf-free']).toBe('g');
    expect(g.parent()).toBe(body());
    // union of (40,30,100x22) and (200,80,300x120)
    expect(style(g)).toMatchObject({
      position: 'absolute',
      left: '40px',
      top: '30px',
      width: '460px',
      height: '170px',
    });
    expect(Number(style(g)['z-index'])).toBe(4); // above the three others
    expect(wrapperN(1).parent()).toBe(g);
    expect(wrapperN(2).parent()).toBe(g);
    expect(style(wrapperN(1))).toMatchObject({ left: '0px', top: '0px', 'z-index': '1' });
    expect(style(wrapperN(2))).toMatchObject({ left: '160px', top: '50px', 'z-index': '2' });
    expect(style(wrapperN(3)).left).toBe('20px'); // untouched
    expect(editor.getSelectedAll()).toEqual([g]);
    expect(adapter.getState().canGroup).toBe(false);
    expect(adapter.getState().canUngroup).toBe(true);
    expect(adapter.getSnapshot().html).toMatch(/<div data-tf-free="g" data-tf-group="1"/);
  });

  it('cannot group a single unit, a locked one, or units of different levels', () => {
    editor.select(unitOf(1));
    expect(adapter.getState().canGroup).toBe(false);
    adapter.run('group');
    expect(groups()).toHaveLength(0);
    wrapperN(2).addAttributes({ 'data-tf-locked': '1' });
    editor.select([unitOf(1), unitOf(3)]);
    expect(adapter.getState().canGroup).toBe(true);
    editor.select([unitOf(1), unitOf(2)]);
    expect(adapter.getState().canGroup).toBe(false);
    adapter.setMode('html');
    editor.select([unitOf(1), unitOf(3)]);
    expect(adapter.getState().canGroup).toBe(false); // only meaningful in the free mode
  });

  it('a click on any element inside selects the GROUP, and so does a layers-less select', () => {
    const g = group12();
    editor.select(undefined as never);
    editor.getModel().setSelected(unitOf(1), { useValid: true });
    expect(editor.getSelected()).toBe(g);
    editor.select(undefined as never);
    editor.getModel().setSelected(wrapperN(2), { useValid: true });
    expect(editor.getSelected()).toBe(g);
    const part = (unitOf(2).components() as unknown as { models: Component[] }).models[0]!;
    editor.getModel().setSelected(part, { useValid: true });
    expect(editor.getSelected()).toBe(g);
  });

  it("everything inside a closed group is out of hover (the highlight is the group's)", async () => {
    const g = group12();
    await tick(); // let the units pass settle
    expect(g.get('hoverable')).toBe(true);
    expect(g.get('selectable')).toBe(true);
    expect(g.get('layerable')).toBe(true);
    expect(unitOf(1).get('hoverable')).toBe(false);
    expect(unitOf(1).get('selectable')).toBe(true); // the layers panel can still reach it
    expect(wrapperN(1).get('hoverable')).toBe(false);
    expect(wrapperN(1).get('layerable')).toBe(true);
  });

  it('the layers show "Grupo" with the children rows (named after their units) nested in it', async () => {
    const g = group12();
    await tick();
    expect(g.getName()).toBe('Grupo');
    expect(wrapperN(1).getName()).toBe(unitOf(1).getName());
    expect(wrapperN(1).parent()).toBe(g);
    const row = host.querySelector(`[title="Grupo"], .gjs-layer-name`);
    expect(row).toBeTruthy();
  });

  it('dragging the group moves it; the children do not change', async () => {
    const g = group12();
    const el = g.getEl()!;
    drag(el, [10, 10], [50, 40]);
    expect(style(g).left).toBe('80px'); // 40 + 40
    expect(style(g).top).toBe('60px'); // 30 + 30
    expect(style(wrapperN(1))).toMatchObject({ left: '0px', top: '0px' });
    expect(style(wrapperN(2))).toMatchObject({ left: '160px', top: '50px' });
    expect(editor.getSelected()).toBe(g);
    await tick();
  });

  it('the arrows nudge the group, z-index works on it, Ctrl+D copies it with its children, Delete removes it', () => {
    const g = group12();
    key('ArrowRight');
    key('ArrowDown', { shiftKey: true });
    expect(style(g).left).toBe('41px');
    expect(style(g).top).toBe('40px');
    expect(style(wrapperN(1)).left).toBe('0px');
    // z-index: it is the front one, so Ctrl+↓ sends it back one step
    key('ArrowDown', { ctrlKey: true });
    expect(Number(style(g)['z-index'])).toBeLessThan(4);
    // duplicate
    key('d', { ctrlKey: true });
    adapter.run('duplicate');
    expect(groups()).toHaveLength(2);
    const copy = groups()[1]!;
    expect(style(copy).left).toBe('53px');
    expect(copy.getAttributes()['data-tf-group']).toBe('1');
    expect(freeWrappers(copy)).toHaveLength(2);
    expect(editor.getSelected()).toBe(copy);
    const nums = allFreeWrappers(body())
      .filter((w) => !w.getAttributes()['data-tf-group'])
      .map((w) => w.getAttributes()['data-tf-free']);
    expect(new Set(nums).size).toBe(nums.length); // fresh numbers inside the copy
    // delete takes the whole group
    adapter.run('delete');
    expect(groups()).toHaveLength(1);
    editor.select(g);
    editor.runCommand('core:component-delete');
    expect(groups()).toHaveLength(0);
    expect(allFreeWrappers(body())).toHaveLength(1);
  });

  it('a locked group does not move', () => {
    const g = group12();
    g.addAttributes({ 'data-tf-locked': '1' });
    editor.select(g);
    expect(adapter.getState().canUngroup).toBe(false);
    key('ArrowRight');
    expect(style(g).left).toBe('40px');
  });

  it('double click enters the group: the inner unit under the pointer is picked, Esc leaves', async () => {
    const g = group12();
    unitOf(2)
      .getEl()!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(editor.getSelected()).toBe(unitOf(2));
    expect(g.get('tfOpen' as never)).toBe(true);
    await tick();
    expect(wrapperN(2).get('hoverable')).toBe(false); // wrappers are never hovered
    expect(unitOf(1).get('hoverable')).toBe(true); // …but the inner units are now
    // inside the group a click picks the inner unit, and the arrows move its wrapper (relative)
    editor.getModel().setSelected(unitOf(1), { useValid: true });
    expect(editor.getSelected()).toBe(unitOf(1));
    key('ArrowRight', { shiftKey: true });
    expect(style(wrapperN(1)).left).toBe('10px');
    expect(style(g).left).toBe('40px');
    const esc = key('Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(editor.getSelected()).toBe(g);
    await tick();
    expect(g.get('tfOpen' as never)).toBe(false);
    expect(unitOf(1).get('hoverable')).toBe(false);
    editor.getModel().setSelected(unitOf(1), { useValid: true });
    expect(editor.getSelected()).toBe(g);
    expect(key('Escape').defaultPrevented).toBe(false); // nothing to leave
  });

  it('leaving by selecting something else closes the group too', async () => {
    const g = group12();
    unitOf(2)
      .getEl()!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(g.get('tfOpen' as never)).toBe(true);
    editor.select(unitOf(3));
    await tick();
    expect(g.get('tfOpen' as never)).toBe(false);
  });

  it('dragging inside an entered group moves the inner wrapper, not the group', async () => {
    const g = group12();
    unitOf(2)
      .getEl()!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    drag(unitOf(2).getEl()!, [10, 10], [40, 30]);
    expect(style(wrapperN(2))).toMatchObject({ left: '190px', top: '70px' });
    expect(style(g).left).toBe('40px');
    await tick();
  });

  it('a layers-panel click on a child row picks that child, not the group', async () => {
    const g = group12();
    await tick();
    const row = host.querySelector('.gjs-layer');
    expect(row).toBeTruthy();
    host.querySelector('.gjs-layers')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    editor.getModel().setSelected(wrapperN(1), { useValid: true });
    expect(editor.getSelected()).toBe(unitOf(1));
    await tick();
    expect(g.get('tfOpen' as never)).toBe(true); // the group above the selection is open
    await tick();
  });

  it('Ungroup: the children are back at their absolute positions, the group is gone, they are selected', () => {
    const g = group12();
    expect(adapter.getState().canUngroup).toBe(true);
    adapter.run('ungroup');
    expect(groups()).toHaveLength(0);
    expect(g.parent()).toBeUndefined();
    expect(wrapperN(1).parent()).toBe(body());
    expect(style(wrapperN(1))).toMatchObject({ left: '40px', top: '30px' });
    expect(style(wrapperN(2))).toMatchObject({ left: '200px', top: '80px' });
    expect(freeWrappers(body())).toHaveLength(3);
    expect(editor.getSelectedAll()).toEqual([unitOf(1), unitOf(2)]);
    expect(adapter.getState().canGroup).toBe(true);
    expect(adapter.getState().canUngroup).toBe(false);
    expect(adapter.getSnapshot().html).not.toContain('data-tf-group');
  });

  it('Ungroup keeps the stacking: the children take the slot of the group', () => {
    const g = group12();
    // other wrapper in front of the children but behind the group: 3 -> z 3, group on top (4)
    expect(Number(style(wrapperN(3))['z-index'])).toBe(3);
    editor.select(g);
    adapter.run('ungroup');
    const z = (n: number) => Number(style(wrapperN(n))['z-index']);
    expect(z(1)).toBeLessThan(z(2));
    expect(z(3)).toBeLessThan(z(1)); // the group was in front of 3: its children still are
  });

  it('Ctrl+G groups, Ctrl+Shift+G ungroups (and are ignored in a text field)', () => {
    editor.select([unitOf(1), unitOf(3)]);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }));
    expect(groups()).toHaveLength(0);
    input.remove();
    const ev = key('g', { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(groups()).toHaveLength(1);
    expect(key('G', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(groups()).toHaveLength(0);
    // the two units are selected again, so Ctrl+G groups once more; with nothing selected it is a no-op
    editor.select(undefined as never);
    expect(key('g', { ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it('a focused control of the prototype (a clicked button in the canvas) does not swallow Ctrl+G or the arrows', () => {
    editor.select([unitOf(1), unitOf(3)]);
    // <input type="button" value="Limpar campos">; grouping re-renders it, so it is looked up again
    const press = (k: string, init: KeyboardEventInit = {}) => {
      const button = unitOf(3).getEl() as HTMLInputElement;
      button.focus();
      expect(button.ownerDocument.activeElement).toBe(button);
      const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
      button.dispatchEvent(ev);
      return ev;
    };
    expect(press('g', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(groups()).toHaveLength(1);
    const g = groups()[0]!;
    const left = style(g).left;
    expect(press('ArrowRight').defaultPrevented).toBe(true);
    expect(style(g).left).toBe(`${parseFloat(String(left)) + 1}px`);
  });

  it('Group and Ungroup are each ONE undo step', async () => {
    const before = adapter.getSnapshot().html;
    const g = group12();
    expect(groups()).toHaveLength(1);
    editor.UndoManager.undo();
    expect(groups()).toHaveLength(0);
    expect(wrapperN(1).parent()).toBe(body());
    expect(style(wrapperN(1))).toMatchObject({ left: '40px', top: '30px' });
    expect(style(wrapperN(2))).toMatchObject({ left: '200px', top: '80px' });
    expect(freeWrappers(body())).toHaveLength(3);
    expect(editor.UndoManager.hasUndo()).toBe(false);
    expect(adapter.getSnapshot().html.replace(/\s+/g, '')).toBe(before.replace(/\s+/g, ''));
    editor.UndoManager.redo();
    expect(groups()).toHaveLength(1);
    expect(g.parent()).toBe(body());
    expect(style(group())).toMatchObject({ left: '40px', width: '460px' });
    await tick(); // a later gesture: the UndoManager fuses what runs in one call stack
    // ungroup, then undo it
    editor.select(group());
    adapter.run('ungroup');
    expect(groups()).toHaveLength(0);
    editor.UndoManager.undo();
    expect(groups()).toHaveLength(1);
    expect(wrapperN(2).parent()).toBe(group());
    expect(style(wrapperN(2))).toMatchObject({ left: '160px', top: '50px' });
    await tick();
  });

  it('a group counts as a change: revision grows and the document is dirty', async () => {
    const start = adapter.getState().revision;
    group12();
    await new Promise((r) => setTimeout(r, 700));
    expect(adapter.getState().revision).toBeGreaterThan(start);
    expect(adapter.getState().dirty).toBe(true);
  });

  it('nested groups: a group of a group and a unit; clicks pick the outer one, then one level per double click', async () => {
    const inner = group12();
    editor.select([inner, unitOf(3)]);
    adapter.run('group');
    expect(groups()).toHaveLength(2);
    const outer = groups().find((x) => x !== inner)!;
    expect(inner.parent()).toBe(outer);
    expect(wrapperN(3).parent()).toBe(outer);
    expect(style(inner)).toMatchObject({ left: '20px', top: '0px' }); // 40-20, 30-30
    expect(editor.getSelected()).toBe(outer);
    editor.select(undefined as never);
    editor.getModel().setSelected(unitOf(1), { useValid: true });
    expect(editor.getSelected()).toBe(outer);
    unitOf(1)
      .getEl()!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(editor.getSelected()).toBe(inner); // one level down
    unitOf(1)
      .getEl()!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(editor.getSelected()).toBe(unitOf(1));
    await tick();
    // ungroup the outer one: the inner group comes out at its absolute position
    editor.select(outer);
    adapter.run('ungroup');
    expect(groups()).toEqual([inner]);
    expect(style(inner)).toMatchObject({ left: '40px', top: '30px' });
    expect(editor.getSelectedAll()).toContain(inner);
  });

  it('a saved group inserted from the palette becomes a top-level group (no wrapper around it)', () => {
    const g = group12();
    const html = g.toHTML();
    adapter.insertBlock({ html, css: '' });
    const tops = freeWrappers(body());
    const last = tops[tops.length - 1]!;
    expect(last.getAttributes()['data-tf-group']).toBe('1');
    expect(last.parent()).toBe(body());
    expect(freeWrappers(last)).toHaveLength(2);
    expect(editor.getSelected()).toBe(last);
  });

  it('Group and Ungroup do nothing in the HTML mode', () => {
    adapter.setMode('html');
    editor.select([unitOf(1), unitOf(3)]);
    adapter.run('group');
    expect(groups()).toHaveLength(0);
    expect(key('g', { ctrlKey: true }).defaultPrevented).toBe(false);
  });
});

describe('multiple selection (free mode)', () => {
  beforeEach(() => {
    adapter.setMode('free');
    sized(1, 100, 22);
    sized(2, 300, 120);
    sized(3, 90, 20);
  });

  it('Ctrl/⌘ + click toggles a unit in the selection, Shift + click too', () => {
    const doc = editor.Canvas.getDocument()!;
    const click = (el: Element, init: MouseEventInit) =>
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    void doc;
    editor.select(unitOf(1));
    click(unitOf(3).getEl()!, { shiftKey: true });
    expect(editor.getSelectedAll()).toEqual([unitOf(1), unitOf(3)]);
    click(unitOf(2).getEl()!, { ctrlKey: true });
    expect(editor.getSelectedAll()).toHaveLength(3);
    click(unitOf(3).getEl()!, { shiftKey: true }); // toggles it off
    expect(editor.getSelectedAll()).toEqual([unitOf(1), unitOf(2)]);
    click(unitOf(1).getEl()!, { metaKey: true });
    expect(editor.getSelectedAll()).toEqual([unitOf(2)]);
  });

  it('a press-drag on any selected unit moves ALL the selected wrappers by the same distance (one undo step)', async () => {
    editor.select([unitOf(1), unitOf(3)]);
    drag(unitOf(3).getEl()!, [10, 10], [50, 40]);
    expect(style(wrapperN(3))).toMatchObject({ left: '60px', top: '330px' });
    expect(style(wrapperN(1))).toMatchObject({ left: '80px', top: '60px' });
    expect(style(wrapperN(2))).toMatchObject({ left: '200px', top: '80px' }); // not selected
    expect(editor.getSelectedAll()).toHaveLength(2);
    await tick();
    expect(editor.getSelectedAll()).toEqual(expect.arrayContaining([unitOf(1), unitOf(3)]));
    editor.UndoManager.undo();
    expect(style(wrapperN(3))).toMatchObject({ left: '20px', top: '300px' });
    expect(style(wrapperN(1))).toMatchObject({ left: '40px', top: '30px' });
  });

  it('dragging with the other one under the pointer works the same way', async () => {
    editor.select([unitOf(1), unitOf(3)]);
    drag(unitOf(1).getEl()!, [10, 10], [30, 30]);
    expect(style(wrapperN(1))).toMatchObject({ left: '60px', top: '50px' });
    expect(style(wrapperN(3))).toMatchObject({ left: '40px', top: '320px' });
    await tick();
  });

  it('a press on something that is not selected does not drag the selection', () => {
    editor.select([unitOf(1), unitOf(3)]);
    drag(unitOf(2).getEl()!, [10, 10], [50, 50]);
    expect(style(wrapperN(1)).left).toBe('40px');
    expect(style(wrapperN(3)).left).toBe('20px');
  });

  it('the arrows nudge every selected wrapper once', () => {
    editor.select([unitOf(1), unitOf(3)]);
    key('ArrowRight', { shiftKey: true });
    expect(style(wrapperN(1)).left).toBe('50px');
    expect(style(wrapperN(3)).left).toBe('30px');
    expect(style(wrapperN(2)).left).toBe('200px');
  });

  it('a locked one among them keeps the whole selection still', () => {
    wrapperN(3).addAttributes({ 'data-tf-locked': '1' });
    editor.select([unitOf(1), unitOf(3)]);
    key('ArrowRight');
    expect(style(wrapperN(1)).left).toBe('40px');
  });
});

describe('the first click after a drag', () => {
  beforeEach(() => {
    adapter.setMode('free');
    sized(1, 100, 22);
    sized(3, 90, 20);
  });

  it('selects the clicked element even when the click that ends the drag never reached the canvas', async () => {
    const em = editor.getModel();
    const click = (el: Element) =>
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    editor.select(unitOf(3));
    drag(unitOf(3).getEl()!, [10, 10], [50, 40]);
    // GrapesJS flags the end of an absolute drag so the click that follows is ignored. That click
    // comes while its select command is stopped (restarted in a timeout): the flag is never
    // consumed and would swallow the NEXT click. A new press starts clean, so that click selects.
    expect(em.get('_cmpDrag' as never)).toBeTruthy();
    await tick();
    const other = unitOf(1).getEl()!;
    other.dispatchEvent(mouse('mousedown', 5, 5));
    expect(em.get('_cmpDrag' as never)).toBeFalsy();
    other.dispatchEvent(mouse('mouseup', 5, 5));
    click(other);
    expect(editor.getSelected()).toBe(unitOf(1));
  });

  it('a Shift / Ctrl press starts clean too (the multi-selection click after a drag works)', async () => {
    const click = (el: Element, init: MouseEventInit) =>
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    editor.select(unitOf(3));
    drag(unitOf(3).getEl()!, [10, 10], [50, 40]);
    await tick();
    const other = unitOf(1).getEl()!;
    other.dispatchEvent(mouse('mousedown', 5, 5, { shiftKey: true }));
    other.dispatchEvent(mouse('mouseup', 5, 5, { shiftKey: true }));
    click(other, { shiftKey: true });
    expect(editor.getSelectedAll()).toEqual(expect.arrayContaining([unitOf(1), unitOf(3)]));
  });
});
