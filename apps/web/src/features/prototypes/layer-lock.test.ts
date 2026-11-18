import grapesjs, { type Editor } from 'grapesjs';
import { afterEach, describe, expect, it } from 'vitest';
import { applyUnits } from './ec-units';
import { all, ofKind } from './ec-test-utils';
import { registerEcidadeTypes } from './grapes-ecidade-types';
import { prepareSnapshot, splitBody } from './sanitize';
import {
  LOCK_ATTR,
  LOCK_COMMAND,
  applyLocks,
  installLayerLock,
  isLockedDeep,
  layerLockOnRender,
  stripLockAttr,
  toggleLock,
} from './layer-lock';

let host: HTMLElement;
let editor: Editor;
let handle: { destroy(): void };

function setup(html: string) {
  host = document.createElement('div');
  const canvas = host.appendChild(document.createElement('div'));
  const layers = host.appendChild(document.createElement('div'));
  document.body.appendChild(host);
  editor = grapesjs.init({
    container: canvas,
    storageManager: false,
    fromElement: false,
    protectedCss: '',
    layerManager: {
      appendTo: layers,
      onRender: (o: never) => editor && layerLockOnRender(editor)(o),
    },
  } as never);
  registerEcidadeTypes(editor);
  handle = installLayerLock(editor);
  const prepared = prepareSnapshot(`<body>${html}</body>`, '');
  editor.setComponents(splitBody(prepared.html).inner);
  applyLocks(editor.getWrapper()!);
  return layers;
}

afterEach(() => {
  handle?.destroy();
  editor?.destroy();
  host?.remove();
});

const HTML = '<div data-id="a"><p data-id="b">x</p></div><div data-id="c"></div>';
const byId = (id: string) => all(editor, (c) => c.getAttributes()['data-id'] === id)[0]!;

describe('layer lock', () => {
  it('toggleLock sets the attribute and locked, and undo reverts it', async () => {
    setup(HTML);
    const a = byId('a');
    editor.UndoManager.clear();
    toggleLock(editor, a);
    expect(a.get('locked')).toBe(true);
    expect(editor.getWrapper()!.toHTML()).toContain(LOCK_ATTR);
    editor.UndoManager.undo();
    expect(editor.getWrapper()!.toHTML()).not.toContain(LOCK_ATTR);
    await Promise.resolve(); // the deferred `locked` sync
    expect(a.get('locked')).toBeFalsy();
  });

  it('a lock through the attribute (Camadas / toolbar) is one undo step', async () => {
    setup(HTML);
    const a = byId('a');
    editor.UndoManager.clear();
    a.addAttributes({ [LOCK_ATTR]: '1' });
    await Promise.resolve(); // the deferred `locked` sync
    expect(a.get('locked')).toBe(true);
    expect(editor.UndoManager.hasUndo()).toBe(true);
    editor.UndoManager.undo();
    await Promise.resolve();
    expect(a.get('locked')).toBeFalsy();
  });

  it('deselects a locked selection and never locks the wrapper', () => {
    setup(HTML);
    const b = byId('b');
    editor.select(b);
    toggleLock(editor, byId('a'));
    expect(editor.getSelectedAll()).toHaveLength(0);
    toggleLock(editor, editor.getWrapper()!);
    expect(editor.getWrapper()!.getAttributes()[LOCK_ATTR]).toBeUndefined();
  });

  it('applyLocks restores locked from loaded markup, and is idempotent', () => {
    setup(`<div data-id="a" ${LOCK_ATTR}="1"><p data-id="b">x</p></div><div data-id="c"></div>`);
    expect(byId('a').get('locked')).toBe(true);
    expect(byId('c').get('locked')).toBeFalsy();
    applyLocks(editor.getWrapper()!);
    expect(byId('a').get('locked')).toBe(true);
  });

  it('isLockedDeep covers descendants', () => {
    setup(`<div data-id="a" ${LOCK_ATTR}="1"><p data-id="b">x</p></div><div data-id="c"></div>`);
    expect(isLockedDeep(byId('b'))).toBe(true);
    expect(isLockedDeep(byId('c'))).toBe(false);
  });

  it('stripLockAttr removes the attribute', () => {
    expect(
      stripLockAttr(`<div data-id="a" ${LOCK_ATTR}="1" class="x"><i ${LOCK_ATTR}></i></div>`),
    ).toBe('<div data-id="a" class="x"><i></i></div>');
  });

  it('applyUnits keeps a locked recognized component non-draggable', () => {
    setup('<div data-ec="lookup"><label>L</label><input type="text"></div>');
    const lookup = ofKind(editor, 'lookup');
    applyUnits(editor.getWrapper()!);
    expect(lookup.get('draggable')).not.toBe(false);
    toggleLock(editor, lookup);
    applyUnits(editor.getWrapper()!);
    expect(lookup.get('draggable')).toBe(false);
    expect(lookup.get('selectable')).not.toBe(false);
    toggleLock(editor, lookup);
    applyUnits(editor.getWrapper()!);
    expect(lookup.get('draggable')).not.toBe(false);
  });

  it('a layer-locked row stays non-draggable; unlocking restores the row rule (not `true`)', () => {
    setup('<table><tbody><tr data-ec="field"><td>a</td></tr></tbody></table>');
    const row = ofKind(editor, 'field');
    applyUnits(editor.getWrapper()!);
    expect(row.get('draggable')).toEqual(['tbody', 'thead', 'tfoot']);
    toggleLock(editor, row);
    applyUnits(editor.getWrapper()!);
    expect(row.get('draggable')).toBe(false);
    // the cells inside a locked row are locked deep too
    expect(row.components().models[0]!.get('draggable')).toBe(false);
    toggleLock(editor, row);
    applyUnits(editor.getWrapper()!);
    expect(row.get('draggable')).toEqual(['tbody', 'thead', 'tfoot']);
  });

  it('renders a lock button in the layer row and toggles on click', async () => {
    const layers = setup(HTML);
    const a = byId('a');
    (editor as unknown as { trigger(e: string): void }).trigger('load'); // the layers panel is rendered on load
    a.trigger('rerender:layer' as never);
    const btn = layers.querySelector<HTMLButtonElement>('[data-tf-lock]');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('aria-pressed')).toBe('false');
    btn!.click();
    expect(a.getAttributes()[LOCK_ATTR]).toBe('1');
    await Promise.resolve(); // the row is repainted after the attribute change
    expect(editor.UndoManager.hasUndo()).toBe(true);
    const again = layers.querySelectorAll('[data-tf-lock]');
    expect(Array.from(again).some((b) => b.getAttribute('aria-pressed') === 'true')).toBe(true);
    // one button per row, even after re-renders
    a.trigger('rerender:layer');
    const row = Array.from(layers.querySelectorAll('.gjs-layer')).find((r) =>
      r.classList.contains('tf-layer-locked'),
    );
    expect(row?.querySelectorAll(':scope > .gjs-layer-item [data-tf-lock]')).toHaveLength(1);
  });

  describe('toolbar lock item', () => {
    const lockItems = (c: ReturnType<typeof byId>) =>
      (c.get('toolbar') as { command: string; attributes: Record<string, string> }[]).filter(
        (t) => t.command === LOCK_COMMAND,
      );

    it('adds exactly one item before delete, none on the wrapper, no duplicates on reselect', () => {
      setup(HTML);
      const a = byId('a');
      editor.UndoManager.clear();
      editor.select(a);
      editor.select(byId('c'));
      editor.select(a);
      expect(lockItems(a)).toHaveLength(1);
      expect(lockItems(a)[0]!.attributes.title).toBe('Bloquear');
      const cmds = (a.get('toolbar') as { command: string }[]).map((t) => t.command);
      expect(cmds.indexOf(LOCK_COMMAND)).toBe(cmds.indexOf('tlb-delete') - 1);
      editor.select(editor.getWrapper()!);
      expect(lockItems(editor.getWrapper()!)).toHaveLength(0);
      expect(editor.UndoManager.hasUndo()).toBe(false);
    });

    it('the command locks (deselects, exported attribute) and unlocks when selected again', () => {
      setup(HTML);
      const a = byId('a');
      editor.select(a);
      editor.runCommand(LOCK_COMMAND);
      expect(a.getAttributes()[LOCK_ATTR]).toBeDefined();
      expect(editor.getSelectedAll()).toHaveLength(0);
      expect(editor.getHtml()).toContain(LOCK_ATTR);
      editor.select(a);
      expect(lockItems(a)).toHaveLength(1);
      expect(lockItems(a)[0]!.attributes.title).toBe('Desbloquear');
      editor.runCommand(LOCK_COMMAND);
      expect(a.getAttributes()[LOCK_ATTR]).toBeUndefined();
      expect(editor.getSelected()).toBe(a);
      expect(lockItems(a)[0]!.attributes.title).toBe('Bloquear');
    });
  });
});
