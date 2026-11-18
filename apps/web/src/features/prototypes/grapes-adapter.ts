import grapesjs, { type Component, type CssRule, type Editor } from 'grapesjs';
import parserPostCss from 'grapesjs-parser-postcss';
import 'grapesjs/dist/css/grapes.min.css';
import {
  FREE_WRAPPER_ATTR,
  type PrototypeBlockDto,
  type PrototypeSnapshot,
} from '@thinkflow/shared';
import type {
  EditorAdapter,
  EditorCommand,
  EditorMode,
  EditorMount,
  EditorState,
} from './editor-adapter';
import { frameCanvasCss, joinStoredCss, splitStoredCss } from './base-css';
import { cssSubsetFor } from './ec-css';
import {
  SCREEN_CATEGORY,
  buildScreenBlocks,
  componentMarkup,
  type ScreenBlock,
} from './ec-describe';
import {
  FAV_ATTR,
  favoriteTitle,
  isFavorite,
  scopeFavoriteCss,
  stripFavoriteAttr,
  unscopeFavoriteCss,
} from './favorites';
import { absorbRowWrapper, insertContent, isRowWrapperHtml, wrapperRows } from './ec-insert';
import { ecKindOf, escapeHtml, tagOf } from './ec-model';
import { applyUnits, enterPart, hideFreeSource, lockedChain } from './ec-units';
import {
  allFreeWrappers,
  freeUnitOf,
  freeWrapperOf,
  groupsAbove,
  inFreeSource,
  isFreeSource,
  isFreeWrapper,
  isGroup,
  isOpenGroup,
  leftOf,
  maxZ,
  nextFreeNumber,
  openAbove,
  pickedUnit,
  setDeepPick,
  setOpenGroup,
  topOf,
  wrapperOfUnit,
} from './free-layout';
import { groupWrappers, groupableWrappers, ungroupWrapper, ungroupableGroup } from './free-group';
import {
  BASIC_BLOCKS,
  ECIDADE_BLOCKS,
  ECIDADE_CATEGORY,
  blockContent,
  type BlockDef,
} from './ecidade-blocks';
import { registerEcidadeTypes } from './grapes-ecidade-types';
import { installCanvasNav, type CanvasNav } from './canvas-nav';
import {
  applyLocks,
  installLayerLock,
  isLockedDeep,
  layerLockOnRender,
  stripLockAttr,
} from './layer-lock';
import { hasOffset, installComponentMove, moveSibling, resetOffset } from './component-move';
import { prepareSnapshot, sanitizeCss, splitBody } from './sanitize';
import './editor-theme.css';

/*
 * GrapesJS implementation of EditorAdapter. Everything GrapesJS-specific stays in this file (and
 * `grapes-ecidade-types.ts`); it is loaded lazily, in its own chunk.
 */

const DEVICE = 'prototype';
const USER_CATEGORY = 'Meus blocos';
const DIRTY_DEBOUNCE_MS = 250;

const px = (n: number) => `${n}px`;

const UNITS_DEBOUNCE_MS = 120;

const STYLE_SECTORS = [
  {
    name: 'Tipografia',
    open: true,
    properties: [
      { extend: 'font-family', label: 'Fonte' },
      { extend: 'font-size', label: 'Tamanho' },
      { extend: 'font-weight', label: 'Peso' },
      { extend: 'color', label: 'Cor do texto' },
      { extend: 'text-align', label: 'Alinhamento' },
      { extend: 'line-height', label: 'Altura da linha' },
    ],
  },
  {
    name: 'Tamanho',
    open: false,
    properties: [
      { extend: 'width', label: 'Largura' },
      { extend: 'height', label: 'Altura' },
      { extend: 'min-height', label: 'Altura mínima' },
    ],
  },
  {
    name: 'Espaçamento',
    open: false,
    properties: [
      { extend: 'margin', label: 'Margem' },
      { extend: 'padding', label: 'Espaço interno' },
    ],
  },
  {
    name: 'Cores e fundo',
    open: false,
    properties: [{ extend: 'background-color', label: 'Cor de fundo' }],
  },
  {
    name: 'Bordas',
    open: false,
    properties: [
      { extend: 'border', label: 'Borda' },
      { extend: 'border-radius', label: 'Arredondamento' },
    ],
  },
  {
    name: 'Posição',
    open: false,
    properties: [
      { extend: 'display', label: 'Exibição' },
      { extend: 'position', label: 'Posição' },
      { extend: 'top', label: 'Topo' },
      { extend: 'left', label: 'Esquerda' },
    ],
  },
] as const;

/** HTML mode: the right / bottom handles (the left / top ones would need absolute positioning). */
const RESIZABLE = { tl: 0, tc: 0, tr: 0, cl: 0, cr: 1, bl: 0, bc: 1, br: 1 } as const;
/**
 * Free mode: all eight. `skipPositionUpdate`: GrapesJS must not write `top` / `left` on the
 * component (it sits in a wrapper; the handlers below move the WRAPPER instead).
 */
const FREE_RESIZABLE = {
  tl: 1,
  tc: 1,
  tr: 1,
  cl: 1,
  cr: 1,
  bl: 1,
  bc: 1,
  br: 1,
  skipPositionUpdate: true,
} as const;
/** Where a block inserted with a click lands: the centre of the visible area, minus this. */
const FREE_INSERT_OFFSET = { x: 80, y: 20 };

const tile = (b: { id: string; label: string; icon?: string }, favoritable = false) =>
  `<div class="proto-block" data-proto-block="${b.id}"><span class="proto-block-ico">${b.icon ?? '▫'}</span><span class="proto-block-name">${escapeHtml(b.label)}</span>${
    favoritable
      ? `<button type="button" class="proto-block-fav" data-proto-fav="${b.id}" title="Favoritar na paleta" aria-label="Favoritar na paleta: ${escapeHtml(b.label)}">⭐</button>`
      : ''
  }</div>`;

/** The markup the palette inserts: favorites carry their css scoped to the inserted component. */
const contentOf = (def: { html: string; css: string; scope?: string }) =>
  blockContent(def.scope ? { html: def.html, css: scopeFavoriteCss(def.css, def.scope) } : def);

export function createGrapesAdapter(mount: EditorMount): EditorAdapter {
  // the layer rows render during init, before `editor` is assigned: the hook is bound lazily
  let onLayerRender: ReturnType<typeof layerLockOnRender> | undefined;
  const editor: Editor = grapesjs.init({
    container: mount.canvas,
    height: '100%',
    width: 'auto',
    fromElement: false,
    storageManager: false,
    // keeps the CSS exactly as written (the default browser parser explodes shorthands)
    plugins: [parserPostCss],
    // our own React toolbar replaces the built-in panels
    panels: { defaults: [] },
    undoManager: { trackSelection: false },
    // output = exactly what the page contains; the PNG render uses the same html + css
    protectedCss: '',
    avoidInlineStyle: true,
    // never run anything coming from the server / the pasted HTML
    parser: {
      optionsHtml: { allowScripts: false, allowUnsafeAttr: false, allowUnsafeAttrValue: false },
    },
    canvas: { scripts: [], styles: [], infiniteCanvas: true },
    deviceManager: {
      // `widthMedia: ''`: the page is not a responsive "device", so Style Manager edits are plain
      // rules (by default GrapesJS would wrap them in `@media (max-width: <first width>)`, which
      // never applies once the prototype is wider than that)
      devices: [
        { id: DEVICE, name: 'Protótipo', width: px(1366), widthMedia: '', height: px(768) },
      ],
      default: DEVICE,
    },
    blockManager: { appendTo: mount.blocks },
    layerManager: {
      appendTo: mount.layers,
      // typed `() => void` by GrapesJS, but it receives `{ component, el }` (ItemView.__render)
      onRender: ((opts: Parameters<ReturnType<typeof layerLockOnRender>>[0]) =>
        (onLayerRender ??= layerLockOnRender(editor))(opts)) as never,
    },
    traitManager: { appendTo: mount.traits },
    selectorManager: { componentFirst: true, custom: true },
    styleManager: { appendTo: mount.styles, sectors: STYLE_SECTORS as never },
    richTextEditor: { actions: ['bold', 'italic', 'underline', 'strikethrough', 'link'] },
  });
  registerEcidadeTypes(editor);
  const layerLock = installLayerLock(editor);
  /** "Livre": a component inside a `data-tf-free` wrapper moves with the wrapper, with absolute drag. */
  let mode: EditorMode = 'html';
  // HTML: click-hold-drag on the selected element reorders, Alt+drag moves freely, arrows 1px /
  // Shift 10px. Free: the wrapper moves (left / top), the arrows too, Ctrl+↑/↓ = z-index
  const move = installComponentMove(editor, {
    isLocked: isLockedDeep,
    freeTarget: (c) => (mode === 'free' ? freeWrapperOf(c) : undefined),
    // Ctrl+G / Ctrl+Shift+G group / ungroup, Esc leaves the group being edited
    keys: { group: () => runGroup(), ungroup: () => runUngroup(), leave: () => leaveGroup() },
  });

  /* ---- blocks ---------------------------------------------------------------------------- */
  const blockDefs = new Map<string, BlockDef>();
  const addBlock = (def: BlockDef) => {
    blockDefs.set(def.id, def);
    return editor.Blocks.add(def.id, {
      label: tile(def),
      category: { id: def.category, label: def.category, open: def.category === ECIDADE_CATEGORY },
      content: contentOf(def),
      select: true,
      ...(def.title ? { attributes: { title: def.title } } : {}),
    });
  };
  [...ECIDADE_BLOCKS, ...BASIC_BLOCKS].forEach(addBlock);

  let userBlockIds: string[] = [];
  let screenBlockIds: string[] = [];
  /** The recognized component behind each "Desta tela" tile (what its ⭐ saves). */
  const screenComponents = new Map<string, Component>();

  /** The category element is created on first use: move it to the top; hide it when empty. */
  let screenCategoryEl: HTMLElement | null = null;
  const placeScreenCategory = () => {
    screenCategoryEl ??=
      mount.blocks
        .querySelector('[data-proto-block^="screen-"]')
        ?.closest<HTMLElement>('.gjs-block-category') ?? null;
    const parent = screenCategoryEl?.parentElement;
    if (!screenCategoryEl || !parent) return;
    if (parent.firstElementChild !== screenCategoryEl) parent.prepend(screenCategoryEl);
    screenCategoryEl.style.display = screenBlockIds.length ? '' : 'none';
  };

  /** "Desta tela": one block per distinct kind + structure among the recognized components. */
  const rebuildScreenBlocks = () => {
    screenBlockIds.forEach((id) => {
      editor.Blocks.remove(id);
      blockDefs.delete(id);
    });
    screenBlockIds = [];
    screenComponents.clear();
    const wrapper = editor.getWrapper();
    if (!wrapper) return;
    buildScreenBlocks(wrapper).forEach((screenDef: ScreenBlock, index) => {
      const { component, ...def } = screenDef;
      blockDefs.set(def.id, def);
      screenComponents.set(def.id, component);
      editor.Blocks.add(
        def.id,
        {
          label: tile(def, true),
          category: { id: SCREEN_CATEGORY, label: SCREEN_CATEGORY, open: true },
          content: blockContent(def),
          select: true,
        },
        { at: index },
      );
      screenBlockIds.push(def.id);
    });
    placeScreenCategory();
  };

  // a click on a palette tile inserts the block too (drag is the main way, this is the shortcut)
  const onBlockClick = (event: MouseEvent) => {
    const star = (event.target as Element).closest('[data-proto-fav]');
    if (star) {
      // the ⭐ of a tile saves the component as a favorite; it never inserts or drags
      event.stopPropagation();
      event.preventDefault();
      const component = screenComponents.get(star.getAttribute('data-proto-fav') ?? '');
      const block = component && blockOfComponent(component);
      if (block) mount.onFavorite?.(block);
      return;
    }
    const tileEl = (event.target as Element).closest('.gjs-block');
    const id = tileEl?.querySelector('[data-proto-block]')?.getAttribute('data-proto-block');
    const def = id ? blockDefs.get(id) : undefined;
    if (def) adapter.insertBlock(def, { before: event.shiftKey });
  };
  mount.blocks.addEventListener('click', onBlockClick);
  // a click on a row of the layers panel picks that exact wrapper, even inside a closed group
  let deepTimer: ReturnType<typeof setTimeout> | undefined;
  const onLayerClick = () => {
    setDeepPick(true);
    clearTimeout(deepTimer);
    deepTimer = setTimeout(() => setDeepPick(false), 0);
  };
  mount.layers.addEventListener('click', onLayerClick, true);

  /* ---- state ----------------------------------------------------------------------------- */
  const listeners = new Set<(s: EditorState) => void>();
  let baseline = '';
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  /** Content changes since the editor was created; the shell's auto-save debounces on it. */
  let revision = 0;
  let lastSerial = '';
  /** A drag / resize is running (the shell postpones its auto-save). */
  let gesture = 0;

  /** The complete `<body …>…</body>` element, like the server stores it. */
  const exportHtml = () => editor.getWrapper()?.toHTML() ?? '<body></body>';
  /** The captured css: read-only, lives in one <style> of the canvas (never in the CssComposer). */
  let baseCss = '';
  /** Only the rules made in the editor (Style Manager, blocks, AI additions). */
  const editsCss = () => editor.getCss() ?? '';
  const allCss = () => [baseCss, editsCss()].filter(Boolean).join('\n');

  /**
   * A component as a reusable block: its markup and only the rules of the screen's css (the
   * captured base + the editor's rules) that style it. A recognized component comes in its
   * exportable form (rows wrapped in a minimal table). Components that came from a favorite lose
   * their scope: the block is stored the way a capture would give it.
   */
  const blockOfComponent = (sel: Component): { label: string; html: string; css: string } => {
    const recognized = Boolean(ecKindOf(sel));
    const html = stripLockAttr(stripFavoriteAttr(recognized ? componentMarkup(sel) : sel.toHTML()));
    const css = unscopeFavoriteCss(allCss());
    const el = sel.getEl();
    const roots: Element[] = [];
    const selfOnly: Element[] = [];
    if (el && sel.parent()) {
      roots.push(el);
      const table =
        recognized && (tagOf(sel) === 'tr' || tagOf(sel) === 'td') ? el.closest('table') : null;
      if (table) selfOnly.push(table); // the minimal wrapper table keeps the original's look
    } else {
      // no live element (removed since the palette was built): match against the markup itself
      const holder = document.createElement('div');
      holder.innerHTML = html;
      roots.push(holder);
    }
    return { label: sel.getName(), html, css: cssSubsetFor(css, roots, selfOnly) };
  };

  /** Ties inserted favorite components to their scoped rules (`:where([data-ec-fav=…])`). */
  const markScope = (roots: Component[], scope: string) =>
    roots.forEach((root) => root.addAttributes({ [FAV_ATTR]: scope }));
  const serialize = () => JSON.stringify([exportHtml(), editsCss()]);

  const selectionLabel = (): string | null => {
    const sel = editor.getSelected();
    return sel && sel !== editor.getWrapper() ? sel.getName() : null;
  };

  const selectionKind = (): string | null => {
    const sel = editor.getSelected();
    return sel && sel !== editor.getWrapper() ? ecKindOf(sel) : null;
  };

  const selectionOffset = (): boolean => {
    const sel = editor.getSelected();
    return !!sel && sel !== editor.getWrapper() && hasOffset(sel);
  };

  /** Percent, 100 = real size (toolbar buttons and Ctrl+wheel both land here). */
  let zoom = 100;

  /** The wrappers Ctrl+G would group / the group Ctrl+Shift+G would open (free mode only). */
  const groupable = () =>
    mode === 'free' ? groupableWrappers(editor.getSelectedAll(), isLockedDeep) : undefined;
  const ungroupable = () =>
    mode === 'free' ? ungroupableGroup(editor.getSelectedAll(), isLockedDeep) : undefined;

  const state = (): EditorState => ({
    zoom,
    dirty,
    canUndo: editor.UndoManager.hasUndo(),
    canRedo: editor.UndoManager.hasRedo(),
    selection: selectionLabel(),
    selectionKind: selectionKind(),
    selectionOffset: selectionOffset(),
    canGroup: !!groupable(),
    canUngroup: !!ungroupable(),
    mode,
    revision,
  });

  let last = state();
  const emit = () => {
    if (destroyed) return;
    const next = state();
    if (
      next.dirty === last.dirty &&
      next.canUndo === last.canUndo &&
      next.canRedo === last.canRedo &&
      next.selection === last.selection &&
      next.selectionKind === last.selectionKind &&
      next.selectionOffset === last.selectionOffset &&
      next.canGroup === last.canGroup &&
      next.canUngroup === last.canUngroup &&
      next.mode === last.mode &&
      next.revision === last.revision &&
      next.zoom === last.zoom
    )
      return;
    last = next;
    listeners.forEach((l) => l(next));
  };

  const checkDirty = () => {
    timer = undefined;
    if (destroyed) return;
    const now = serialize();
    if (now !== lastSerial) {
      lastSerial = now;
      revision++;
    }
    dirty = now !== baseline;
    emit();
  };
  const scheduleDirtyCheck = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(checkDirty, DIRTY_DEBOUNCE_MS);
    emit(); // undo/redo availability right away
  };

  const resizableFor = (m: EditorMode) => (m === 'free' ? FREE_RESIZABLE : RESIZABLE);
  /** Sets (or, after a mode change, swaps) OUR handles; components with their own config keep it. */
  const ensureResizable = (c: Component) => {
    if (c === editor.getWrapper()) return;
    const have = c.get('resizable') as unknown;
    const want = resizableFor(mode);
    if (have === want) return;
    if (!have || have === RESIZABLE || have === FREE_RESIZABLE)
      c.set('resizable', want as never, { avoidStore: true } as never); // a selection is not an edit
  };

  /* ---- components as units ----------------------------------------------------------------- */
  // parts of a recognized component are locked (a click selects the whole component); a double
  // click enters the clicked part until the selection leaves it. Names follow the edited texts.
  let entered = new Set<Component>();
  let unitsTimer: ReturnType<typeof setTimeout> | undefined;
  const runUnits = () => {
    unitsTimer = undefined;
    const wrapper = editor.getWrapper();
    if (!destroyed && wrapper) applyUnits(wrapper, entered);
  };
  /** Right now (names must be right before the selection label is read). */
  const flushUnits = () => {
    if (unitsTimer) clearTimeout(unitsTimer);
    runUnits();
  };
  const scheduleUnits = () => {
    if (!unitsTimer) unitsTimer = setTimeout(runUnits, UNITS_DEBOUNCE_MS);
  };

  const modelOfElement = (start: EventTarget | null): Component | undefined => {
    for (let n = start as Element | null; n; n = n.parentElement) {
      const model = (n as unknown as { __gjsv?: { model?: Component } }).__gjsv?.model;
      if (model) return model;
    }
    return undefined;
  };
  let dblDoc: Document | null = null;
  const onCanvasDblClick = (event: MouseEvent) => {
    const model = modelOfElement(event.target);
    if (!model || !lockedChain(model).length) return;
    entered = enterPart(model);
    editor.select(model);
  };
  /** Double click on a closed group: enter it and pick what is under the pointer, one level down. */
  const onCanvasDblClickCapture = (event: MouseEvent) => {
    const model = mode === 'free' ? modelOfElement(event.target) : undefined;
    const closed = model && closedGroupOn(model);
    if (!model || !closed) return;
    setOpenGroup(closed, true);
    flushUnits();
    const inner = pickedUnit(model);
    if (inner) editor.select(inner);
    event.stopPropagation(); // no text editing of whatever sits under the pointer
    event.preventDefault();
  };
  /** Free mode: Shift + click toggles like Ctrl/⌘ + click (GrapesJS would only add, by sibling range). */
  const onCanvasClickCapture = (event: MouseEvent) => {
    if (mode !== 'free' || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    Object.defineProperty(event, 'ctrlKey', { value: true });
  };
  const bindCanvasDoc = () => {
    dblDoc?.removeEventListener('dblclick', onCanvasDblClick);
    dblDoc?.removeEventListener('dblclick', onCanvasDblClickCapture, true);
    dblDoc?.removeEventListener('click', onCanvasClickCapture, true);
    dblDoc = editor.Canvas.getDocument() ?? null;
    dblDoc?.addEventListener('dblclick', onCanvasDblClick);
    dblDoc?.addEventListener('dblclick', onCanvasDblClickCapture, true);
    dblDoc?.addEventListener('click', onCanvasClickCapture, true);
  };
  editor.on('canvas:frame:load', bindCanvasDoc);
  editor.on('load', bindCanvasDoc);

  /* ---- free layout ------------------------------------------------------------------------- */
  /** An empty absolutely positioned wrapper at the end of the body, above every other one. */
  const newFreeWrapper = (body: Component, left: number, top: number, at?: number): Component => {
    const [wrapper] = body.append(
      {
        tagName: 'div',
        attributes: { [FREE_WRAPPER_ATTR]: String(nextFreeNumber(body)) },
        style: {
          position: 'absolute',
          left: px(left),
          top: px(top),
          'z-index': String(maxZ(body) + 1),
        },
      },
      at === undefined ? {} : { at },
    );
    return wrapper!;
  };

  /* ---- groups ------------------------------------------------------------------------------ */
  /** The outermost group a click on `c` stops at (closed), if any: what a double click enters. */
  const closedGroupOn = (c: Component): Component | undefined => {
    const picked = pickedUnit(c);
    return picked && isGroup(picked) && !isOpenGroup(picked) && picked !== c ? picked : undefined;
  };

  /**
   * The groups above the selection are "open" (its inner wrappers are directly pickable); every
   * other group is closed again. Coalesced: a click swaps the selection in several steps.
   */
  let openSync = false;
  const syncOpenGroups = () => {
    openSync = false;
    if (destroyed) return;
    const body = editor.getWrapper();
    if (!body) return;
    const keep = new Set(editor.getSelectedAll().flatMap(groupsAbove));
    let changed = false;
    for (const g of allFreeWrappers(body).filter(isGroup)) {
      if (isOpenGroup(g) === keep.has(g)) continue;
      setOpenGroup(g, keep.has(g));
      changed = true;
    }
    if (changed) flushUnits();
  };
  const scheduleOpenSync = () => {
    if (openSync) return;
    openSync = true;
    queueMicrotask(syncOpenGroups);
  };

  /** Ctrl+G: the selected units into a new group (false when there is nothing to group). */
  const runGroup = (): boolean => {
    const wrappers = groupable();
    if (!wrappers) return false;
    const group = groupWrappers(wrappers);
    flushUnits(); // the group must be selectable and delegate before it is picked
    editor.select(group);
    scheduleDirtyCheck();
    return true;
  };

  /** Ctrl+Shift+G: the selected group dissolves, its children get selected. */
  const runUngroup = (): boolean => {
    const group = ungroupable();
    if (!group) return false;
    const kids = ungroupWrapper(group);
    kids.forEach(openAbove); // picked inside a closed outer group they would resolve to it
    flushUnits();
    const units = kids.map(freeUnitOf).filter((u): u is Component => !!u);
    editor.select(units.length ? units : (undefined as never));
    scheduleDirtyCheck();
    return true;
  };

  /** Esc: back out of the innermost group being edited (it becomes the selection). */
  const leaveGroup = (): boolean => {
    const sel = editor.getSelected();
    const group = sel && groupsAbove(sel).find(isOpenGroup);
    if (!group) return false;
    editor.select(group);
    return true;
  };

  /** Frame position (px) for a block inserted without a drop: the centre of the visible area. */
  const viewPoint = (): { x: number; y: number } => {
    let x = frame.width / 2;
    let y = frame.height / 2;
    const area = editor.Canvas.getElement() as HTMLElement | undefined;
    const page = area?.querySelector<HTMLElement>('.gjs-frame-wrapper')?.getBoundingClientRect();
    const view = area?.getBoundingClientRect();
    if (view && page && view.width > 0 && page.width > 0) {
      const z = zoom / 100;
      x = (view.left + view.width / 2 - page.left) / z;
      y = (view.top + view.height / 2 - page.top) / z;
    }
    const clamp = (n: number, max: number) =>
      Math.round(Math.min(Math.max(n, 0), Math.max(0, max)));
    return {
      x: clamp(x - FREE_INSERT_OFFSET.x, frame.width - 40),
      y: clamp(y - FREE_INSERT_OFFSET.y, frame.height - 40),
    };
  };

  /** A block dropped in absolute mode (left/top on its root): moves into a new wrapper at that spot. */
  const wrapDropped = (component: Component): Component | undefined => {
    const body = editor.getWrapper();
    if (!body || component.parent() !== body || isFreeWrapper(component)) return undefined;
    const left = leftOf(component);
    const top = topOf(component);
    const wrapper = newFreeWrapper(body, left, top, component.index());
    const rest = { ...(component.getStyle() ?? {}) } as Record<string, unknown>;
    delete rest.left;
    delete rest.top;
    delete rest.position;
    component.move(wrapper);
    component.setStyle(rest as never);
    return wrapper;
  };

  /** Free mode palette click: the block in a new wrapper at the centre of the visible area. */
  const insertFree = (block: { html: string; css: string; scope?: string }): void => {
    const body = editor.getWrapper();
    if (!body) return;
    const { x, y } = viewPoint();
    const wrapper = newFreeWrapper(body, x, y);
    const added = wrapper.append(contentOf(block));
    if (block.scope) markScope(added, block.scope);
    // a saved group is a wrapper already: it takes the place of the new one
    const [only] = added;
    const target = added.length === 1 && only && isGroup(only) ? only : wrapper;
    if (target !== wrapper) {
      const style = wrapper.getStyle() as Record<string, string>;
      only!.move(body, { at: wrapper.index() });
      only!.addStyle({
        position: 'absolute',
        left: style.left,
        top: style.top,
        'z-index': style['z-index'],
      });
      wrapper.remove();
    }
    flushUnits();
    const unit = freeUnitOf(target);
    if (unit) editor.select(unit);
  };

  /** Ctrl+D on a unit of a free layout: a copy of the whole wrapper, a little to the side and in front. */
  const duplicateFree = (wrapper: Component): void => {
    const parent = wrapper.parent();
    if (!parent) return;
    const [copy] = parent.append(wrapper.clone(), { at: (wrapper.index() ?? 0) + 1 });
    if (!copy) return;
    // fresh numbers for the copy and the wrappers inside it (a group keeps its `g`)
    let next = nextFreeNumber(editor.getWrapper() ?? parent);
    [copy, ...allFreeWrappers(copy)]
      .filter((w) => !isGroup(w))
      .forEach((w) => w.addAttributes({ [FREE_WRAPPER_ATTR]: String(next++) }));
    copy.addStyle({
      left: px(leftOf(wrapper) + 12),
      top: px(topOf(wrapper) + 12),
      'z-index': String(maxZ(parent) + 1),
    });
    flushUnits();
    const unit = freeUnitOf(copy);
    if (unit) editor.select(unit);
  };

  // the left / top handles of a resize move the WRAPPER (the unit itself keeps its place in it).
  // GrapesJS' resize rects are not in one coordinate space from start to update, so the shift is
  // derived from the handle and the size change only: a left handle moves the wrapper by the width
  // lost/gained, a top handle by the height; right/bottom handles never move it.
  let resizing: {
    wrapper: Component;
    left: number;
    top: number;
    w: number;
    h: number;
    handle: string;
  } | null = null;
  type ResizeEvent = {
    type?: string;
    component?: Component;
    event?: Event;
    rect?: { w?: number; h?: number };
    style?: Record<string, unknown>;
    partial?: boolean;
  };
  const handleOf = (e?: Event): string => {
    const target = e?.target as Element | null | undefined;
    return target?.closest?.('[data-gjs-handler]')?.getAttribute('data-gjs-handler') ?? '';
  };
  const onResize = (e: ResizeEvent) => {
    if (e.type === 'start') {
      gesture++;
      const wrapper = mode === 'free' && e.component ? freeWrapperOf(e.component) : undefined;
      const el = e.component?.getEl();
      resizing =
        wrapper && el
          ? {
              wrapper,
              left: leftOf(wrapper),
              top: topOf(wrapper),
              // the start rect has the size (the element's offset size as a fallback)
              w: e.rect?.w ?? el.offsetWidth,
              h: e.rect?.h ?? el.offsetHeight,
              handle: handleOf(e.event),
            }
          : null;
    } else if (e.type === 'end') {
      gesture = Math.max(0, gesture - 1);
      resizing = null;
    }
  };
  const onResizeUpdate = (e: ResizeEvent) => {
    if (!resizing || !e.rect) return;
    // the unit keeps its place inside the wrapper: never let GrapesJS write left/top on it
    if (e.style) {
      delete e.style.left;
      delete e.style.top;
    }
    const { handle } = resizing;
    const dx = handle.endsWith('l') && e.rect.w !== undefined ? resizing.w - e.rect.w : 0;
    const dy = handle.startsWith('t') && e.rect.h !== undefined ? resizing.h - e.rect.h : 0;
    const left = px(resizing.left + dx);
    const top = px(resizing.top + dy);
    if (
      leftOf(resizing.wrapper) === parseFloat(left) &&
      topOf(resizing.wrapper) === parseFloat(top)
    )
      return;
    resizing.wrapper.addStyle(
      { left, top, __p: Boolean(e.partial) } as never,
      {
        avoidStore: Boolean(e.partial),
      } as never,
    );
  };
  const onGestureStart = () => gesture++;
  const onGestureEnd = () => {
    gesture = Math.max(0, gesture - 1);
  };
  editor.on('component:resize', onResize);
  editor.on('component:resize:update', onResizeUpdate);
  editor.on('component:drag:start', onGestureStart);
  editor.on('component:drag:end', onGestureEnd);
  editor.on('dmode:start', onGestureStart);
  editor.on('dmode:end', onGestureEnd);

  // a dropped row block (wrapped in a minimal table) joins the table it was dropped in
  editor.on('block:drag:stop', (component?: Component, block?: { getId(): string }) => {
    if (!component) return;
    const added = absorbRowWrapper(component);
    const [first] = added;
    const scope = block ? blockDefs.get(String(block.getId()))?.scope : undefined;
    if (scope) markScope(added, scope);
    // free mode: the absolute drop left the block at left/top of the body; it goes in a wrapper
    const free = mode === 'free' && first ? wrapDropped(first) : undefined;
    flushUnits();
    emit();
    const target = free ? freeUnitOf(free) : first && (wrapperRows(first)[0] ?? first);
    if (target && target !== component) editor.select(target);
  });

  editor.on('update', () => {
    scheduleDirtyCheck();
    scheduleUnits();
  });
  editor.on('component:add', (c: Component) => {
    ensureResizable(c);
    // the hidden originals of a free layout are never pickable, not even for the 120ms before the pass
    if (isFreeSource(c) || inFreeSource(c)) hideFreeSource(c);
    scheduleUnits();
  });
  editor.on('component:selected', (c: Component) => {
    ensureResizable(c);
    if (entered.size && !entered.has(c)) {
      entered = new Set();
      scheduleUnits();
    }
    scheduleOpenSync();
    emit();
  });
  editor.on('component:deselected', () => {
    scheduleOpenSync();
    emit();
  });
  // a lock (or unlock) changes what can be grouped
  editor.on('component:update:attributes', emit);
  // nudges, free drags, "Restaurar posição" and undo/redo of them change the offset of the selection
  editor.on('component:styleUpdate', emit);
  editor.on('undo redo', scheduleDirtyCheck);

  /* ---- keyboard -------------------------------------------------------------------------- */
  const duplicate = () => {
    const sel = editor.getSelected();
    const parent = sel?.parent();
    if (!sel || !parent || sel === editor.getWrapper()) return;
    const wrapper = wrapperOfUnit(sel);
    if (wrapper) return duplicateFree(wrapper);
    const [copy] = parent.append(sel.clone(), { at: (sel.index() ?? 0) + 1 });
    if (copy) editor.select(copy);
  };
  editor.Keymaps.add('proto:save', '⌘+s, ctrl+s', () => mount.onSave(), { prevent: true });
  editor.Keymaps.add('proto:duplicate', '⌘+d, ctrl+d', duplicate, { prevent: true });

  /* ---- adapter --------------------------------------------------------------------------- */
  let frame = { width: 1366, height: 768 };

  /**
   * The canvas is "infinite" (pan/zoom), and GrapesJS then auto-sizes the frame to the content
   * height. With captured css like `html,body{height:100%}` or `100vh` that is a feedback loop (the
   * content follows the iframe, the iframe follows the content) and the frame grows forever. So
   * the frame ALWAYS has a fixed size, width x height of the prototype: auto height is switched
   * off on the frame model and the page scrolls inside the frame when it is taller.
   */
  const lockFrame = () => {
    const model = editor.Canvas.getFrame() as unknown as {
      hasAutoHeight: () => boolean;
      set: (attrs: Record<string, unknown>, opts?: Record<string, unknown>) => void;
      view?: { updateDim?: () => void; sizeObserver?: { disconnect(): void } };
    } | null;
    if (!model) return;
    model.hasAutoHeight = () => false;
    model.set({ width: px(frame.width), height: px(frame.height), minHeight: null });
    model.view?.sizeObserver?.disconnect();
    model.view?.updateDim?.();
  };

  /** Canvas-only css (not part of the saved css) + the read-only captured css, once. */
  const applyCanvasStyles = () => {
    const doc = editor.Canvas.getDocument();
    if (!doc) return;
    const put = (id: string, attr: string | null, css: string, first: boolean) => {
      let style = doc.getElementById(id) as HTMLStyleElement | null;
      if (!style) {
        style = doc.createElement('style');
        style.id = id;
        if (attr) style.setAttribute(attr, '');
        if (first) doc.head.prepend(style);
        else doc.head.appendChild(style);
      }
      if (style.textContent !== css) style.textContent = css;
    };
    // first in <head>: the rules made in the editor (later in the document) win over it
    put('tf-base', 'data-tf-base', baseCss, true);
    put('proto-frame', null, frameCanvasCss(frame.height), false);
  };
  const onFrameLoad = () => {
    lockFrame();
    applyCanvasStyles();
  };
  editor.on('canvas:frame:load', onFrameLoad);
  // the frame model exists only once the editor finished loading (it may be after the first load())
  editor.on('load', onFrameLoad);

  const applyFrame = () => {
    const device = editor.Devices.get(DEVICE);
    device?.set({ width: px(frame.width), height: px(frame.height) });
    editor.Devices.select(DEVICE);
    lockFrame();
    applyCanvasStyles();
    editor.Canvas.refresh?.();
    nav.refresh();
  };

  // scrollbars, Space / middle-button pan at any zoom, pan clamp, Ctrl+wheel zoom → toolbar
  const nav: CanvasNav = installCanvasNav(editor, {
    onZoom: (pct) => {
      if (pct === zoom) return;
      zoom = pct;
      emit();
    },
  });

  /** Zoom scales around the canvas centre: pan so the page sits centred (or top-left if bigger). */
  const place = () => {
    const area = editor.Canvas.getElement();
    if (!area) return;
    const w = area.clientWidth;
    const h = area.clientHeight;
    const z = zoom / 100;
    const left = Math.max(16, (w - frame.width * z) / 2);
    const top = Math.max(16, Math.min(40, (h - frame.height * z) / 2));
    editor.Canvas.setCoords(left - (w / 2) * (1 - z), top - (h / 2) * (1 - z));
    nav.refresh();
  };

  /**
   * GrapesJS' UndoManager remembers the "before" of a rule change that was NOT stored (every rule
   * created while loading) until the next STORED change of that rule, and the first edit after a
   * load would then undo to that empty "before": one Ctrl+Z on a moved / grouped component wiped
   * its whole rule (position included). A stored round trip of each rule consumes it; the stack
   * is cleared right after.
   */
  const refreshRuleUndo = () => {
    editor.Css.getAll().forEach((rule: CssRule) => {
      const style = rule.getStyle();
      if (!Object.keys(style).length) return;
      rule.setStyle({ ...style, '--tf-undo': '1' });
      rule.setStyle(style);
    });
  };

  const removeUserBlocks = () => {
    userBlockIds.forEach((id) => editor.Blocks.remove(id));
    userBlockIds = [];
  };

  const adapter: EditorAdapter = {
    load(snapshot: PrototypeSnapshot) {
      if (timer) clearTimeout(timer);
      const stored = splitStoredCss(snapshot.css);
      const prepared = prepareSnapshot(snapshot.html, stored.base);
      baseCss = prepared.css;
      frame = { width: snapshot.width, height: snapshot.height };
      applyFrame();
      editor.select(undefined as never);
      const { inner, attrs } = splitBody(prepared.html);
      // empty first: the new components are created BEFORE the old ones go away, and an id that
      // is still taken (a saved `#id` rule + `id="…"`) would be renamed, orphaning its rule
      editor.setComponents('');
      editor.setStyle(sanitizeCss(stored.edits));
      editor.setComponents(inner);
      // classes/ids/data-* of the captured <body> (css like `body.x .y` depends on them)
      const wrapper = editor.getWrapper();
      if (wrapper) {
        const { class: classes = '', ...rest } = attrs;
        wrapper.setClass(classes.split(/\s+/).filter(Boolean));
        wrapper.setAttributes(rest);
      }
      entered = new Set();
      if (wrapper) {
        applyLocks(wrapper);
        applyUnits(wrapper);
      }
      rebuildScreenBlocks();
      refreshRuleUndo();
      editor.UndoManager.clear();
      baseline = serialize();
      lastSerial = baseline;
      revision++;
      dirty = false;
      last = { ...state(), dirty: false };
      listeners.forEach((l) => l(last));
    },

    getSnapshot() {
      return { html: exportHtml(), css: joinStoredCss(baseCss, editsCss()) };
    },

    setFrameSize(width, height) {
      frame = { width, height };
      applyFrame();
    },

    setZoom(percent) {
      zoom = Math.min(400, Math.max(10, Math.round(percent)));
      editor.Canvas.setZoom(zoom);
      place();
      emit();
    },

    fitZoom() {
      const area = mount.canvas;
      const w = area.clientWidth - 64;
      const h = area.clientHeight - 64;
      if (w <= 0 || h <= 0) return 100;
      return Math.max(
        10,
        Math.min(100, Math.floor(Math.min(w / frame.width, h / frame.height) * 100)),
      );
    },

    setUserBlocks(blocks: PrototypeBlockDto[]) {
      removeUserBlocks();
      for (const b of blocks) {
        const id = `user-${b.id}`;
        // favorites join the built-in e-Cidade category (marked with a star); the rest stay apart
        const favorite = isFavorite(b);
        addBlock({
          id,
          label: b.name.replace(/[<>&]/g, ''),
          category: favorite ? ECIDADE_CATEGORY : b.category || USER_CATEGORY,
          icon: favorite ? '⭐' : '★',
          html: b.html,
          css: b.css,
          ...(favorite ? { scope: b.id, title: favoriteTitle(b) } : {}),
        });
        userBlockIds.push(id);
      }
    },

    insertBlock(block, opts) {
      const wrapper = editor.getWrapper();
      if (!wrapper) return;
      if (mode === 'free') return insertFree(block);
      const added = insertContent(
        wrapper,
        editor.getSelected(),
        contentOf(block),
        isRowWrapperHtml(block.html),
        opts,
      );
      if (block.scope) markScope(added, block.scope);
      flushUnits();
      const first = added[0];
      // a row that stayed in its wrapper table: select the row (the component), not the table
      if (first) editor.select(wrapperRows(first)[0] ?? first);
    },

    getSelectionAsBlock() {
      const sel = editor.getSelected();
      if (!sel || sel === editor.getWrapper()) return null;
      return blockOfComponent(sel);
    },

    getSelectionPath() {
      const sel = editor.getSelected();
      const wrapper = editor.getWrapper();
      if (!sel || !wrapper || sel === wrapper) return null;
      const isElement = (c: Component) => !c.is('textnode') && c.get('type') !== 'comment';
      const path: number[] = [];
      let node: Component | undefined = sel;
      while (node && node !== wrapper) {
        const parent: Component | undefined = node.parent();
        if (!parent) return null;
        const siblings = (parent.components() as unknown as { models: Component[] }).models;
        path.unshift(siblings.filter(isElement).indexOf(node));
        node = parent;
      }
      return { html: sel.toHTML(), path };
    },

    run(command: EditorCommand) {
      const sel = editor.getSelected();
      switch (command) {
        case 'undo':
          editor.UndoManager.undo();
          break;
        case 'redo':
          editor.UndoManager.redo();
          break;
        case 'duplicate':
          duplicate();
          break;
        case 'delete':
          // the unit of a free wrapper takes its wrapper along (no empty absolute div is left)
          if (sel && sel !== editor.getWrapper()) (wrapperOfUnit(sel) ?? sel).remove();
          break;
        case 'select-parent': {
          const parent = sel?.parent();
          if (parent && parent !== editor.getWrapper()) editor.select(parent);
          break;
        }
        case 'deselect':
          editor.select(undefined as never);
          break;
        case 'move-up':
        case 'move-down':
          moveSibling(editor, command === 'move-up' ? -1 : 1, isLockedDeep);
          break;
        case 'reset-offset':
          if (sel && sel !== editor.getWrapper() && !isLockedDeep(sel)) resetOffset(sel);
          break;
        case 'group':
          runGroup();
          break;
        case 'ungroup':
          runUngroup();
          break;
      }
      scheduleDirtyCheck();
    },

    markClean() {
      if (timer) clearTimeout(timer);
      baseline = serialize();
      lastSerial = baseline;
      dirty = false;
      rebuildScreenBlocks(); // components added since the screen was loaded
      emit();
    },

    setMode(next) {
      if (next === mode) return;
      mode = next;
      // GrapesJS' own absolute drag (guides; a block dropped from the palette gets left/top)
      editor.getModel().set('dmode', next === 'free' ? 'absolute' : '');
      const selected = editor.getSelectedAll();
      selected.forEach(ensureResizable);
      // the handles are read when a component is picked: pick it again
      if (selected.length === 1) {
        const [sel] = selected;
        editor.select(undefined as never);
        editor.select(sel);
      }
      emit();
    },

    isInteracting: () => gesture > 0 || editor.getModel().isEditing(),

    getState: state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      if (unitsTimer) clearTimeout(unitsTimer);
      editor.off('canvas:frame:load', onFrameLoad);
      editor.off('load', onFrameLoad);
      editor.off('component:resize', onResize);
      editor.off('component:resize:update', onResizeUpdate);
      editor.off('component:drag:start', onGestureStart);
      editor.off('component:drag:end', onGestureEnd);
      editor.off('dmode:start', onGestureStart);
      editor.off('dmode:end', onGestureEnd);
      dblDoc?.removeEventListener('dblclick', onCanvasDblClick);
      dblDoc?.removeEventListener('dblclick', onCanvasDblClickCapture, true);
      dblDoc?.removeEventListener('click', onCanvasClickCapture, true);
      listeners.clear();
      mount.blocks.removeEventListener('click', onBlockClick);
      mount.layers.removeEventListener('click', onLayerClick, true);
      clearTimeout(deepTimer);
      setDeepPick(false);
      nav.destroy();
      move.destroy();
      layerLock.destroy();
      // the select command refreshes the canvas through a debounce GrapesJS cannot cancel
      // (`bindAll` drops `.cancel`): leaving right after a pan would throw once the editor is gone
      (editor.getModel() as unknown as { refreshCanvas(): void }).refreshCanvas = () => {};
      editor.destroy();
    },
  };
  return adapter;
}
