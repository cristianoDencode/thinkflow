import type { Component, Editor } from 'grapesjs';

/*
 * Layer lock: a component locked from the "Camadas" panel cannot be picked, dragged or edited in the
 * canvas (GrapesJS' native `locked` prop adds a no-pointer class to it and its children). The lock
 * is persisted in the prototype markup as `data-tf-locked`, so it survives saving/reloading; the
 * attribute change goes through the UndoManager, the `locked` prop is derived from it.
 */

export const LOCK_ATTR = 'data-tf-locked';

const attrs = (c: Component): Record<string, unknown> => c.getAttributes() ?? {};
const children = (c: Component): Component[] =>
  (c.components() as unknown as { models: Component[] }).models;
const isWrapper = (c: Component): boolean => !c.parent();

export const isLocked = (c: Component): boolean => attrs(c)[LOCK_ATTR] !== undefined;

/** `c` or any of its ancestors is locked. */
export function isLockedDeep(c: Component): boolean {
  for (let p: Component | undefined = c; p; p = p.parent()) if (isLocked(p)) return true;
  return false;
}

/** Reconciles the native `locked` prop with the attribute of one component. */
function syncProp(c: Component): void {
  const want = isLocked(c);
  if ((c.get('locked') === true) !== want) c.set('locked', want, { avoidStore: true } as never);
}

/** Every component with the attribute gets `locked: true`; stale `locked` flags are cleared. Idempotent. */
export function applyLocks(root: Component): void {
  const visit = (node: Component) => {
    syncProp(node);
    children(node).forEach(visit);
  };
  visit(root);
}

/** Locks / unlocks a component (never the wrapper); a selection inside it is dropped. */
export function toggleLock(editor: Editor, component: Component): void {
  if (isWrapper(component)) return;
  if (isLocked(component)) component.removeAttributes(LOCK_ATTR);
  else component.addAttributes({ [LOCK_ATTR]: '1' });
  syncProp(component);
  const locked = isLocked(component);
  if (locked) {
    for (const sel of editor.getSelectedAll()) {
      for (let p: Component | undefined = sel; p; p = p.parent()) {
        if (p === component) {
          editor.selectRemove(sel);
          break;
        }
      }
    }
  }
}

/** Markup without the lock attribute (a component saved as a reusable block is not born locked). */
export const stripLockAttr = (html: string): string =>
  html.replace(/\sdata-tf-locked(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/g, '');

const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
export const ICON_LOCKED = `<svg ${SVG_ATTRS}><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
export const ICON_UNLOCKED = `<svg ${SVG_ATTRS}><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;

/** Layer rows rendered by GrapesJS (re-rendering replaces the element, so the latest one is kept). */
const rows = new WeakMap<Component, HTMLElement>();
const listened = new WeakSet<Component>();

function paint(component: Component, el: HTMLElement): void {
  const locked = isLocked(component);
  const item = el.querySelector<HTMLElement>(':scope > .gjs-layer-item') ?? el;
  item.classList.toggle('tf-layer-locked', locked);
  el.classList.toggle('tf-layer-locked', locked);
  const btn = item.querySelector<HTMLButtonElement>('[data-tf-lock]');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(locked));
  btn.setAttribute('aria-label', locked ? 'Desbloquear camada' : 'Bloquear camada');
  btn.title = locked ? 'Desbloquear camada' : 'Bloquear camada';
  btn.innerHTML = locked ? ICON_LOCKED : ICON_UNLOCKED;
}

/** `layerManager.onRender` for `grapesjs.init`: adds the lock button before the move icon of each row. */
export function layerLockOnRender(
  editor: Editor,
): (opts: { component: Component; el: HTMLElement }) => void {
  return ({ component, el }) => {
    if (isWrapper(component)) return;
    rows.set(component, el);
    if (!listened.has(component)) {
      listened.add(component);
      // deferred, like `installLayerLock`'s listener: a nested `set` with `avoidStore` inside the
      // attribute change would hide the lock from the UndoManager and the dirty check
      component.on(`change:attributes:${LOCK_ATTR}`, () =>
        queueMicrotask(() => {
          syncProp(component);
          const row = rows.get(component);
          if (row) paint(component, row);
        }),
      );
    }
    const right = el.querySelector<HTMLElement>(':scope > .gjs-layer-item .gjs-layer-item-right');
    if (right && !right.querySelector('[data-tf-lock]')) {
      const btn = el.ownerDocument.createElement('button');
      btn.type = 'button';
      btn.className = 'tf-layer-lock';
      btn.setAttribute('data-tf-lock', '');
      const stop = (ev: Event) => ev.stopPropagation();
      btn.addEventListener('mousedown', stop);
      btn.addEventListener('dblclick', stop);
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        toggleLock(editor, component);
      });
      right.insertBefore(btn, right.querySelector('.gjs-layer-move'));
    }
    paint(component, el);
  };
}

/* ---- floating toolbar (canvas) ------------------------------------------------------------ */

export const LOCK_COMMAND = 'tf:toggle-lock';
const TLB_MARK = 'data-tf-lock-tlb';

type ToolbarItem = { attributes?: Record<string, unknown>; command?: unknown; label?: string };

function lockToolbarItem(locked: boolean): ToolbarItem {
  const title = locked ? 'Desbloquear' : 'Bloquear';
  return {
    attributes: { [TLB_MARK]: '', title, 'aria-label': title },
    command: LOCK_COMMAND,
    label: locked ? ICON_LOCKED : ICON_UNLOCKED,
  };
}

const toolbarOf = (c: Component): ToolbarItem[] => (c.get('toolbar') as ToolbarItem[]) ?? [];
const isLockItem = (t: ToolbarItem): boolean => !!t.attributes && TLB_MARK in t.attributes;

/** Adds (or refreshes the icon of) the lock item of a component's toolbar, before the delete item. */
function syncToolbar(c: Component): void {
  if (isWrapper(c)) return;
  const current = toolbarOf(c);
  if (!current.length) return;
  const item = lockToolbarItem(isLocked(c));
  const existing = current.find(isLockItem);
  if (existing && existing.label === item.label) return;
  const rest = current.filter((t) => !isLockItem(t));
  const del = rest.findIndex((t) => t.command === 'tlb-delete');
  const next = [...rest];
  next.splice(del < 0 ? next.length : del, 0, item);
  c.set('toolbar', next as never, { avoidStore: true } as never);
}

/** Global wiring: keeps `locked` in step with the attribute for added, pasted or undone components. */
export function installLayerLock(editor: Editor): { destroy(): void } {
  const onAdd = (c: Component) => applyLocks(c);
  // Deferred: this runs INSIDE the attribute change, and Backbone fires the final `change` event
  // with the options of the last nested `set` — the `avoidStore` of `syncProp` would then hide the
  // lock from the UndoManager and from the dirty check
  const onAttrs = (c: Component) => queueMicrotask(() => syncProp(c));
  const onSelected = (c: Component) => syncToolbar(c);
  // The toolbar button does what the Camadas one does; locking drops the selection.
  editor.Commands.add(LOCK_COMMAND, {
    run(ed: Editor) {
      const sel = ed.getSelected();
      if (!sel) return;
      toggleLock(ed, sel);
      if (ed.getSelected() === sel) syncToolbar(sel);
    },
  });
  editor.on('component:add', onAdd);
  editor.on(`component:update:attributes`, onAttrs);
  editor.on('component:selected', onSelected);
  return {
    destroy() {
      editor.off('component:add', onAdd);
      editor.off('component:update:attributes', onAttrs);
      editor.off('component:selected', onSelected);
    },
  };
}
