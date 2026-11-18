import type { Editor } from 'grapesjs';
import './canvas-nav.css';

/*
 * Navigation of the GrapesJS infinite canvas, which ships with wheel pan / Ctrl+wheel zoom only:
 *  - overlay scrollbars (the canvas has none);
 *  - pan at any zoom with Space+drag (GrapesJS only allows it when zoom != 100%) and with the
 *    middle mouse button;
 *  - a pan clamp so the page can never be lost off screen;
 *  - zoom clamping (10-400%) and a callback so the shell follows Ctrl+wheel zoom.
 * Coordinates: `Canvas.setCoords(x, y)` translates the frames by x/y SCREEN pixels at any zoom
 * (GrapesJS applies `scale(z) translate(x/z, y/z)`), so pixel deltas map 1:1 to coords deltas.
 */

export const MIN_ZOOM = 10;
export const MAX_ZOOM = 400;
/** Breathing room around the page that the scrollbars let the user reach. */
export const SCROLL_MARGIN = 48;
/** Minimum amount of the page (px) that must stay visible on an axis. */
export const MIN_VISIBLE = 80;
const MIN_THUMB = 24;
const MOVE_COMMAND = 'core:canvas-move';
const GRABBING = 'gjs-is__grabbing';

export interface ScrollMetrics {
  /** False when the page (+margin) fits the viewport on this axis: the bar is hidden. */
  visible: boolean;
  /** Extent = union of the viewport and the page + margin, relative to the viewport start. */
  extentStart: number;
  extentSize: number;
  /** Thumb length as a fraction of the track (0..1). */
  thumbSize: number;
  /** Thumb start as a fraction of the track (0..1 - thumbSize). */
  thumbStart: number;
}

/**
 * One axis of the scrollbar. `viewSize` is the viewport length, `pageStart`/`pageSize` the page
 * rectangle relative to the viewport start (all screen px).
 */
export function scrollMetrics(
  viewSize: number,
  pageStart: number,
  pageSize: number,
  margin = SCROLL_MARGIN,
): ScrollMetrics {
  const extentStart = Math.min(0, pageStart - margin);
  const extentEnd = Math.max(viewSize, pageStart + pageSize + margin);
  const extentSize = extentEnd - extentStart;
  if (viewSize <= 0 || extentSize <= viewSize + 0.5) {
    return { visible: false, extentStart: 0, extentSize: viewSize, thumbSize: 1, thumbStart: 0 };
  }
  const thumbSize = viewSize / extentSize;
  const thumbStart = Math.min(1 - thumbSize, Math.max(0, -extentStart / extentSize));
  return { visible: true, extentStart, extentSize, thumbSize, thumbStart };
}

/** Thumb length / offset in px for a track of `track` px (the thumb never gets thinner than MIN_THUMB). */
export function thumbPixels(m: ScrollMetrics, track: number, minThumb = MIN_THUMB) {
  const length = Math.min(track, Math.max(minThumb, m.thumbSize * track));
  const travel = Math.max(0, track - length);
  const span = 1 - m.thumbSize;
  const offset = span > 0 ? (m.thumbStart / span) * travel : 0;
  return { length, offset, travel };
}

/**
 * Dragging the thumb by `deltaPx` moves the viewport through the extent; the content (coords) moves
 * the opposite way. `extent`, `view` and `travel` must be the values frozen when the drag started.
 */
export function dragToCoordsDelta(deltaPx: number, extent: number, view: number, travel: number) {
  if (travel <= 0) return 0;
  return (-deltaPx * (extent - view)) / travel;
}

/**
 * Shift (px, to add to the coords) that keeps at least `minVisible` px of the page inside the
 * viewport on one axis. 0 when already in range.
 */
export function clampShift(
  viewSize: number,
  pageStart: number,
  pageSize: number,
  minVisible = MIN_VISIBLE,
): number {
  if (viewSize <= 0 || pageSize <= 0) return 0;
  const keep = Math.min(minVisible, pageSize, viewSize);
  const pageEnd = pageStart + pageSize;
  if (pageEnd < keep) return keep - pageEnd;
  if (pageStart > viewSize - keep) return viewSize - keep - pageStart;
  return 0;
}

export const clampZoom = (pct: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pct));

export interface CanvasNavOptions {
  /** Called with the (clamped, rounded) zoom percent whenever the canvas zoom changes. */
  onZoom(pct: number): void;
}

export interface CanvasNav {
  /** Recomputes the scrollbars (call after anything that moves/resizes the page). */
  refresh(): void;
  destroy(): void;
}

type Axis = 'x' | 'y';

interface Geometry {
  viewW: number;
  viewH: number;
  pageX: number;
  pageY: number;
  pageW: number;
  pageH: number;
}

const isTextTarget = (target: EventTarget | null) => {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(
    el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'),
  );
};

export function installCanvasNav(editor: Editor, opts: CanvasNavOptions): CanvasNav {
  const canvasEl = editor.Canvas.getElement() as HTMLElement | undefined;
  if (!canvasEl) return { refresh() {}, destroy() {} };
  let destroyed = false;

  /* ---- measuring ------------------------------------------------------------------------- */
  const measure = (): Geometry | null => {
    const wrapper = canvasEl.querySelector<HTMLElement>('.gjs-frame-wrapper');
    if (!wrapper) return null;
    const c = canvasEl.getBoundingClientRect();
    const p = wrapper.getBoundingClientRect();
    const viewW = c.width || canvasEl.clientWidth;
    const viewH = c.height || canvasEl.clientHeight;
    // a hidden canvas (inactive tab, not laid out yet) has no usable geometry
    if (viewW <= 0 || viewH <= 0 || p.width <= 0 || p.height <= 0) return null;
    return {
      viewW,
      viewH,
      pageX: p.left - c.left,
      pageY: p.top - c.top,
      pageW: p.width,
      pageH: p.height,
    };
  };

  /* ---- scrollbars ------------------------------------------------------------------------ */
  const root = document.createElement('div');
  root.className = 'tf-cnav';
  const makeBar = (axis: Axis) => {
    const bar = document.createElement('div');
    bar.className = `tf-cnav__bar tf-cnav__bar--${axis}`;
    bar.setAttribute('data-canvas-scroll', axis);
    bar.hidden = true;
    const thumb = document.createElement('div');
    thumb.className = 'tf-cnav__thumb';
    bar.appendChild(thumb);
    root.appendChild(bar);
    return { bar, thumb };
  };
  const bars = { x: makeBar('x'), y: makeBar('y') };
  const attach = () => {
    if (root.parentNode !== canvasEl) canvasEl.insertBefore(root, canvasEl.firstChild);
  };
  attach();

  const last: Record<Axis, { metrics: ScrollMetrics; view: number; track: number } | undefined> = {
    x: undefined,
    y: undefined,
  };

  const update = () => {
    raf = 0;
    if (destroyed) return;
    attach();
    const g = measure();
    const m = {
      x: g ? scrollMetrics(g.viewW, g.pageX, g.pageW) : undefined,
      y: g ? scrollMetrics(g.viewH, g.pageY, g.pageH) : undefined,
    };
    const both = Boolean(m.x?.visible && m.y?.visible);
    root.classList.toggle('tf-cnav--both', both);
    for (const axis of ['x', 'y'] as const) {
      const metrics = m[axis];
      const { bar, thumb } = bars[axis];
      if (!g || !metrics?.visible) {
        bar.hidden = true;
        last[axis] = undefined;
        continue;
      }
      bar.hidden = false;
      const view = axis === 'x' ? g.viewW : g.viewH;
      const track = Math.max(0, view - (both ? 8 : 0));
      const px = thumbPixels(metrics, track);
      if (axis === 'x') {
        thumb.style.width = `${px.length}px`;
        thumb.style.left = `${px.offset}px`;
      } else {
        thumb.style.height = `${px.length}px`;
        thumb.style.top = `${px.offset}px`;
      }
      last[axis] = { metrics, view, track };
    }
  };

  let raf = 0;
  const schedule = () => {
    if (destroyed || raf) return;
    raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(update)
        : (setTimeout(update, 16) as unknown as number);
  };
  const cancelSchedule = () => {
    if (!raf) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    else clearTimeout(raf);
    raf = 0;
  };

  const coordsNow = () => {
    const c = editor.Canvas.getCoords();
    return { x: c.x ?? 0, y: c.y ?? 0 };
  };

  /* thumb drag + track click */
  const cleanups: (() => void)[] = [];
  for (const axis of ['x', 'y'] as const) {
    const { bar, thumb } = bars[axis];
    const clientPos = (e: MouseEvent) => (axis === 'x' ? e.clientX : e.clientY);
    const setAxis = (value: number) => {
      const c = coordsNow();
      if (axis === 'x') editor.Canvas.setCoords(value, c.y);
      else editor.Canvas.setCoords(c.x, value);
    };

    let drag: {
      start: number;
      coord: number;
      extent: number;
      view: number;
      travel: number;
    } | null = null;
    const onThumbDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const info = last[axis];
      if (!info) return;
      e.preventDefault();
      e.stopPropagation();
      const px = thumbPixels(info.metrics, info.track);
      drag = {
        start: clientPos(e),
        coord: coordsNow()[axis],
        extent: info.metrics.extentSize,
        view: info.view,
        travel: px.travel,
      };
      thumb.setAttribute('data-dragging', '');
      try {
        if (typeof thumb.setPointerCapture === 'function' && e.pointerId !== undefined)
          thumb.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety: the pointer events still reach the thumb */
      }
    };
    const onThumbMove = (e: PointerEvent) => {
      if (!drag) return;
      setAxis(
        drag.coord +
          dragToCoordsDelta(clientPos(e) - drag.start, drag.extent, drag.view, drag.travel),
      );
    };
    const onThumbUp = (e: PointerEvent) => {
      if (!drag) return;
      drag = null;
      thumb.removeAttribute('data-dragging');
      try {
        if (typeof thumb.releasePointerCapture === 'function' && e.pointerId !== undefined)
          thumb.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    /** Click on the empty track: page by (almost) one viewport towards the click. */
    const onTrackDown = (e: PointerEvent) => {
      if (e.target !== bar || e.button !== 0) return;
      const info = last[axis];
      if (!info) return;
      e.preventDefault();
      const rect = thumb.getBoundingClientRect();
      const before = clientPos(e) < (axis === 'x' ? rect.left : rect.top);
      // viewport moves towards the click, the content (coords) the other way
      setAxis(coordsNow()[axis] + (before ? 1 : -1) * info.view * 0.9);
    };
    thumb.addEventListener('pointerdown', onThumbDown as EventListener);
    thumb.addEventListener('pointermove', onThumbMove as EventListener);
    thumb.addEventListener('pointerup', onThumbUp as EventListener);
    thumb.addEventListener('pointercancel', onThumbUp as EventListener);
    bar.addEventListener('pointerdown', onTrackDown as EventListener);
    cleanups.push(() => {
      thumb.removeEventListener('pointerdown', onThumbDown as EventListener);
      thumb.removeEventListener('pointermove', onThumbMove as EventListener);
      thumb.removeEventListener('pointerup', onThumbUp as EventListener);
      thumb.removeEventListener('pointercancel', onThumbUp as EventListener);
      bar.removeEventListener('pointerdown', onTrackDown as EventListener);
    });
  }

  let observer: ResizeObserver | undefined;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(schedule);
    observer.observe(canvasEl);
  }

  /* ---- pan clamp ------------------------------------------------------------------------- */
  let clamping = false;
  const clampPan = () => {
    if (clamping) return;
    const g = measure();
    if (!g) return;
    const dx = clampShift(g.viewW, g.pageX, g.pageW);
    const dy = clampShift(g.viewH, g.pageY, g.pageH);
    if (!dx && !dy) return;
    const c = coordsNow();
    clamping = true;
    try {
      editor.Canvas.setCoords(c.x + dx, c.y + dy);
    } finally {
      clamping = false;
    }
  };

  const onCoords = () => {
    clampPan();
    schedule();
  };

  /* ---- zoom sync ------------------------------------------------------------------------- */
  const onZoomEvent = () => {
    const raw = editor.Canvas.getZoom();
    if (!Number.isFinite(raw)) return;
    const clamped = clampZoom(raw);
    if (clamped !== raw) {
      editor.Canvas.setZoom(clamped); // fires `canvas:zoom` again, already in range
      return;
    }
    opts.onZoom(Math.round(clamped));
    schedule();
  };

  /*
   * Ctrl/⌘ + wheel. GrapesJS zooms by `deltaY` percent of the zoom, so one mouse-wheel notch
   * (deltaY ≈ 100) jumps straight to the minimum (or doubles it). Ours is proportional and smooth
   * (≈ 10% per notch, trackpad pinch included) and keeps the point under the pointer still. A
   * capture listener on the canvas runs before GrapesJS' own (it also gets the copies of the
   * iframe's wheel events the canvas forwards, carrying `_parentEvent`).
   */
  const onWheelZoom = (raw: Event) => {
    const ev = raw as WheelEvent & { _parentEvent?: WheelEvent };
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    ev._parentEvent?.preventDefault();
    ev.stopPropagation();
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
    const zoom = editor.Canvas.getZoom() / 100;
    const next = clampZoom(zoom * 100 * Math.exp(-ev.deltaY * unit * 0.001)) / 100;
    if (next === zoom) return;
    const c = canvasEl.getBoundingClientRect();
    let sx = ev.clientX - c.left;
    let sy = ev.clientY - c.top;
    const parent = ev._parentEvent;
    if (parent) {
      // iframe coordinates: scale them and offset by where the frame sits on screen
      const f = (ev.target as Element).getBoundingClientRect();
      sx = f.left - c.left + parent.clientX * zoom;
      sy = f.top - c.top + parent.clientY * zoom;
    }
    const px = sx - c.width / 2;
    const py = sy - c.height / 2;
    const { x, y } = coordsNow();
    const k = next / zoom;
    editor.Canvas.setZoom(next * 100);
    editor.Canvas.setCoords(px - (px - x) * k, py - (py - y) * k);
  };
  /*
   * The canvas element is `overflow: hidden`, but the browser still scrolls it to bring something
   * into view (focus inside the frame, `scrollIntoView` when a layer is picked in "Camadas"…).
   * GrapesJS assumes it never scrolls: once it does, the drop position of a drag, the toolbar and
   * the highlight are computed off by that amount. Any such scroll becomes a pan instead.
   */
  const onCanvasScroll = () => {
    const dx = canvasEl.scrollLeft;
    const dy = canvasEl.scrollTop;
    if (!dx && !dy) return;
    canvasEl.scrollLeft = 0;
    canvasEl.scrollTop = 0;
    const { x, y } = coordsNow();
    editor.Canvas.setCoords(x - dx, y - dy);
  };
  canvasEl.addEventListener('scroll', onCanvasScroll);
  cleanups.push(() => canvasEl.removeEventListener('scroll', onCanvasScroll));
  canvasEl.addEventListener('wheel', onWheelZoom, { capture: true, passive: false });
  cleanups.push(() => canvasEl.removeEventListener('wheel', onWheelZoom, { capture: true }));

  /* ---- pan: Space + drag at any zoom, middle button -------------------------------------- */
  let startedByUs = false;
  const typing = (ev: KeyboardEvent) =>
    isTextTarget(ev.target) ||
    Boolean(editor.getEditing()) ||
    Boolean(editor.Canvas.isInputFocused());
  const isSpace = (ev: KeyboardEvent) => ev.code === 'Space' || ev.key === ' ';

  const onKeyDown = (ev: KeyboardEvent) => {
    if (!isSpace(ev) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (typing(ev)) return;
    // cancelling keydown also cancels the `keypress` GrapesJS listens to (zoom != 100%): no double run
    ev.preventDefault();
    if (!editor.Commands.isActive(MOVE_COMMAND)) {
      startedByUs = true;
      editor.runCommand(MOVE_COMMAND);
    }
  };
  /** GrapesJS stops the command on a Space keyup of the TOP document only: cover the iframe too. */
  const stopMove = () => {
    if (editor.Commands.isActive(MOVE_COMMAND)) editor.stopCommand(MOVE_COMMAND);
    startedByUs = false;
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    if (isSpace(ev) && startedByUs) stopMove();
  };
  const onWindowBlur = () => {
    if (startedByUs) stopMove();
  };

  let middle: { sx: number; sy: number; x: number; y: number; doc?: Document } | null = null;
  const onMiddleMove = (ev: MouseEvent) => {
    if (!middle) return;
    editor.Canvas.setCoords(
      middle.x + (ev.screenX - middle.sx),
      middle.y + (ev.screenY - middle.sy),
    );
  };
  const endMiddle = () => {
    if (!middle) return;
    document.removeEventListener('mousemove', onMiddleMove);
    document.removeEventListener('mouseup', endMiddle);
    middle.doc?.removeEventListener('mousemove', onMiddleMove as EventListener);
    middle.doc?.removeEventListener('mouseup', endMiddle);
    middle = null;
    canvasEl.classList.remove(GRABBING);
  };
  const onMouseDown = (ev: MouseEvent) => {
    if (ev.button !== 1) return;
    ev.preventDefault(); // no browser autoscroll / X11 paste
    endMiddle();
    const c = coordsNow();
    const frameDoc = editor.Canvas.getDocument() ?? undefined;
    middle = { sx: ev.screenX, sy: ev.screenY, x: c.x, y: c.y, doc: frameDoc };
    // frames stop eating the mouse; the iframe keeps its implicit capture, so listen on both docs
    canvasEl.classList.add(GRABBING);
    document.addEventListener('mousemove', onMiddleMove);
    document.addEventListener('mouseup', endMiddle);
    frameDoc?.addEventListener('mousemove', onMiddleMove as EventListener);
    frameDoc?.addEventListener('mouseup', endMiddle);
  };

  const bound = new Set<Document>();
  const bindDoc = (doc: Document) => {
    if (bound.has(doc)) return;
    bound.add(doc);
    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('keyup', onKeyUp);
    // middle clicks: the canvas element covers the top document, only the iframe needs its own
    if (doc !== document) doc.addEventListener('mousedown', onMouseDown);
  };
  const unbindDoc = (doc: Document) => {
    doc.removeEventListener('keydown', onKeyDown);
    doc.removeEventListener('keyup', onKeyUp);
    doc.removeEventListener('mousedown', onMouseDown);
    bound.delete(doc);
  };
  const bindDocs = () => {
    if (destroyed) return;
    const frameDoc = editor.Canvas.getDocument();
    // an iframe reload replaces its document: drop the stale ones
    for (const doc of Array.from(bound)) if (doc !== document && doc !== frameDoc) unbindDoc(doc);
    bindDoc(document);
    if (frameDoc) bindDoc(frameDoc);
  };
  bindDocs();
  // the canvas element sees middle clicks outside the iframe (the gutter around the page)
  canvasEl.addEventListener('mousedown', onMouseDown);
  window.addEventListener('blur', onWindowBlur);

  const onFrameLoad = () => {
    bindDocs();
    schedule();
  };

  /* ---- wiring ---------------------------------------------------------------------------- */
  editor.on('canvas:coords', onCoords);
  editor.on('canvas:zoom', onZoomEvent);
  editor.on('canvas:frame:load', onFrameLoad);
  editor.on('canvas:update', schedule);
  editor.on('load', onFrameLoad);
  schedule();

  return {
    refresh: schedule,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelSchedule();
      observer?.disconnect();
      editor.off('canvas:coords', onCoords);
      editor.off('canvas:zoom', onZoomEvent);
      editor.off('canvas:frame:load', onFrameLoad);
      editor.off('canvas:update', schedule);
      editor.off('load', onFrameLoad);
      endMiddle();
      if (startedByUs) stopMove();
      for (const doc of Array.from(bound)) unbindDoc(doc);
      canvasEl.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('blur', onWindowBlur);
      cleanups.forEach((fn) => fn());
      root.remove();
    },
  };
}
