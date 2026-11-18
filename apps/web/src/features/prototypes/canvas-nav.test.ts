import grapesjs, { type Editor } from 'grapesjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampShift,
  clampZoom,
  dragToCoordsDelta,
  installCanvasNav,
  scrollMetrics,
  thumbPixels,
  type CanvasNav,
} from './canvas-nav';

describe('scrollMetrics', () => {
  it('hides the bar when the page plus margin fits the viewport', () => {
    expect(scrollMetrics(1000, 100, 700, 48).visible).toBe(false);
    // exactly fitting still hides
    expect(scrollMetrics(1000, 48, 904, 48).visible).toBe(false);
  });

  it('shows the bar when the page is bigger than the viewport', () => {
    const m = scrollMetrics(1000, 0, 2000, 48);
    expect(m.visible).toBe(true);
    // extent: [-48, 2048] => 2096
    expect(m.extentStart).toBe(-48);
    expect(m.extentSize).toBe(2096);
    expect(m.thumbSize).toBeCloseTo(1000 / 2096);
    // viewport starts 48px into the extent
    expect(m.thumbStart).toBeCloseTo(48 / 2096);
  });

  it('moves the thumb when the page is panned', () => {
    // page scrolled left by 500: viewport is further right inside the extent
    const m = scrollMetrics(1000, -500, 2000, 48);
    expect(m.extentStart).toBe(-548);
    expect(m.thumbStart).toBeCloseTo(548 / m.extentSize);
    // the end of the extent is reached when the page end + margin hits the viewport end
    const end = scrollMetrics(1000, -1048, 2000, 48);
    expect(end.thumbStart + end.thumbSize).toBeCloseTo(1);
  });

  it('extends the extent to the viewport when the page sits off to one side', () => {
    const m = scrollMetrics(1000, 900, 400, 48); // sticks out on the right
    expect(m.visible).toBe(true);
    expect(m.extentStart).toBe(0);
    expect(m.extentSize).toBe(1348);
    expect(m.thumbStart).toBe(0);
  });

  it('is hidden for an empty viewport', () => {
    expect(scrollMetrics(0, 0, 100, 48).visible).toBe(false);
  });
});

describe('thumbPixels', () => {
  it('maps fractions to pixels', () => {
    const m = scrollMetrics(1000, 0, 2000, 48);
    const px = thumbPixels(m, 1000);
    expect(px.length).toBeCloseTo((1000 / 2096) * 1000);
    expect(px.offset).toBeCloseTo((48 / 2096) * 1000);
    expect(px.length + px.travel).toBeCloseTo(1000);
  });

  it('never makes the thumb thinner than the minimum and keeps it inside the track', () => {
    const m = scrollMetrics(1000, 0, 100000, 48);
    const px = thumbPixels(m, 1000, 24);
    expect(px.length).toBe(24);
    const end = scrollMetrics(1000, -(100000 + 48 - 1000), 100000, 48);
    const endPx = thumbPixels(end, 1000, 24);
    expect(endPx.offset + endPx.length).toBeCloseTo(1000);
  });
});

describe('dragToCoordsDelta', () => {
  it('dragging the thumb forward moves the content backwards, scaled by the extent', () => {
    // extent 2000 over a 1000 view: track 1000, thumb 500 => travel 500
    expect(dragToCoordsDelta(100, 2000, 1000, 500)).toBeCloseTo(-200);
    expect(dragToCoordsDelta(-50, 2000, 1000, 500)).toBeCloseTo(100);
  });

  it('a full travel scrolls the whole hidden part of the extent', () => {
    expect(dragToCoordsDelta(500, 2000, 1000, 500)).toBeCloseTo(-1000);
  });

  it('is 0 without travel', () => {
    expect(dragToCoordsDelta(40, 2000, 1000, 0)).toBe(0);
  });
});

describe('clampShift', () => {
  it('does nothing while enough of the page is visible', () => {
    expect(clampShift(1000, 100, 800, 80)).toBe(0);
    expect(clampShift(1000, -700, 800, 80)).toBe(0); // 100px still visible
    expect(clampShift(1000, 920, 800, 80)).toBe(0); // exactly 80px visible
  });

  it('brings the page back when it went off the left/top edge', () => {
    // page end at 30px: 80px must be visible => shift +50
    expect(clampShift(1000, -770, 800, 80)).toBe(50);
    expect(clampShift(1000, -5000, 800, 80)).toBe(80 + 4200);
  });

  it('brings the page back when it went off the right/bottom edge', () => {
    // page starts 40px from the end of the viewport => shift -40
    expect(clampShift(1000, 960, 800, 80)).toBe(-40);
    expect(clampShift(1000, 5000, 800, 80)).toBe(-(5000 - 920));
  });

  it('keeps only what the page has when it is smaller than the minimum', () => {
    // a 50px page needs 50px visible, not 80
    expect(clampShift(1000, -60, 50, 80)).toBe(60); // end at -10 => keep 50 => +60
    expect(clampShift(1000, 100, 50, 80)).toBe(0);
  });

  it('ignores empty rects (hidden canvas, jsdom)', () => {
    expect(clampShift(0, 0, 0, 80)).toBe(0);
    expect(clampShift(1000, 5000, 0, 80)).toBe(0);
  });
});

describe('clampZoom', () => {
  it('limits to 10-400', () => {
    expect(clampZoom(5)).toBe(10);
    expect(clampZoom(1000)).toBe(400);
    expect(clampZoom(133)).toBe(133);
  });
});

describe('installCanvasNav (real GrapesJS)', () => {
  let host: HTMLElement;
  let editor: Editor;
  let nav: CanvasNav;
  let onZoom: ReturnType<typeof vi.fn<(pct: number) => void>>;

  const canvasEl = () => editor.Canvas.getElement() as HTMLElement;
  const bar = (axis: 'x' | 'y') =>
    canvasEl().querySelector<HTMLElement>(`[data-canvas-scroll="${axis}"]`)!;
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  const key = (type: 'keydown' | 'keyup', target: EventTarget = document) => {
    const ev = new KeyboardEvent(type, {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(ev);
    return ev;
  };
  /** Stubs the layout jsdom does not have: viewport and page rects. */
  const stubLayout = (view: [number, number], page: [number, number, number, number]) => {
    canvasEl().getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: view[0],
        height: view[1],
        right: view[0],
        bottom: view[1],
      }) as DOMRect;
    let wrapper = canvasEl().querySelector('.gjs-frame-wrapper');
    if (!wrapper) {
      // the frame renders asynchronously: a bare wrapper is all the nav reads
      wrapper = document.createElement('div');
      wrapper.className = 'gjs-frame-wrapper';
      canvasEl().appendChild(wrapper);
    }
    (wrapper as HTMLElement).getBoundingClientRect = () =>
      ({
        left: page[0],
        top: page[1],
        width: page[2],
        height: page[3],
        right: page[0] + page[2],
        bottom: page[1] + page[3],
      }) as DOMRect;
  };

  let resizeCallbacks: (() => void)[];
  beforeEach(async () => {
    resizeCallbacks = [];
    // jsdom has no ResizeObserver (GrapesJS' frame needs one too)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resizeCallbacks.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = grapesjs.init({
      container: host,
      height: '100%',
      width: 'auto',
      fromElement: false,
      storageManager: false,
      panels: { defaults: [] },
      canvas: { scripts: [], styles: [], infiniteCanvas: true },
    });
    onZoom = vi.fn<(pct: number) => void>();
    nav = installCanvasNav(editor, { onZoom });
    // GrapesJS renders its frame wrapper asynchronously: let it exist so the stubs hit the real one
    await vi.waitFor(() => expect(canvasEl().querySelector('.gjs-frame-wrapper')).not.toBeNull());
  });
  afterEach(() => {
    nav.destroy();
    // GrapesJS' select command refreshes the canvas 150ms after a container change, through a
    // debounce it cannot cancel (`bindAll` drops `.cancel`): neutralize it, or it fires after
    // `destroy` and throws
    (editor.getModel() as unknown as { refreshCanvas(): void }).refreshCanvas = () => {};
    editor.destroy();
    host.remove();
    vi.unstubAllGlobals();
  });

  it('recomputes the bars when the canvas element is resized', async () => {
    stubLayout([1000, 600], [100, 60, 700, 400]);
    nav.refresh();
    await frame();
    expect(bar('x').hidden).toBe(true);
    stubLayout([500, 600], [100, 60, 700, 400]); // narrower viewport: the page overflows
    resizeCallbacks.forEach((cb) => cb());
    await frame();
    expect(bar('x').hidden).toBe(false);
  });

  it('renders both bars inside the canvas, hidden until the page overflows', async () => {
    expect(canvasEl().contains(bar('x'))).toBe(true);
    expect(canvasEl().contains(bar('y'))).toBe(true);
    stubLayout([1000, 600], [100, 60, 700, 400]);
    nav.refresh();
    await frame();
    expect(bar('x').hidden).toBe(true);
    expect(bar('y').hidden).toBe(true);
  });

  it('shows a bar on the axis where the page overflows and sizes the thumb', async () => {
    stubLayout([1000, 600], [0, 60, 2000, 400]);
    nav.refresh();
    await frame();
    expect(bar('x').hidden).toBe(false);
    expect(bar('y').hidden).toBe(true);
    const thumb = bar('x').querySelector<HTMLElement>('.tf-cnav__thumb')!;
    expect(parseFloat(thumb.style.width)).toBeCloseTo((1000 / 2096) * 1000, 0);
  });

  it('dragging the thumb pans the canvas', async () => {
    stubLayout([1000, 600], [0, 60, 2000, 400]);
    editor.Canvas.setCoords(0, 0);
    nav.refresh();
    await frame();
    const thumb = bar('x').querySelector<HTMLElement>('.tf-cnav__thumb')!;
    const fire = (type: string, clientX: number) =>
      thumb.dispatchEvent(
        new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true }),
      );
    fire('pointerdown', 100);
    fire('pointermove', 150); // thumb forward => content moves back
    expect(editor.Canvas.getCoords().x).toBeLessThan(0);
    fire('pointerup', 150);
    const after = editor.Canvas.getCoords().x;
    fire('pointermove', 400); // not dragging any more
    expect(editor.Canvas.getCoords().x).toBe(after);
  });

  it('clicking the empty track pages towards the click', async () => {
    stubLayout([1000, 600], [0, 60, 2000, 400]);
    editor.Canvas.setCoords(0, 0);
    nav.refresh();
    await frame();
    const thumb = bar('x').querySelector<HTMLElement>('.tf-cnav__thumb')!;
    thumb.getBoundingClientRect = () => ({ left: 50, top: 0, right: 100, bottom: 8 }) as DOMRect;
    // click after the thumb => viewport goes right => content (coords) goes left
    bar('x').dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 900, button: 0, bubbles: true, cancelable: true }),
    );
    expect(editor.Canvas.getCoords().x).toBeCloseTo(-900);
  });

  it('keeps 80px of the page visible after a pan', () => {
    stubLayout([1000, 600], [-1000, 20, 1010, 400]); // page ends 10px inside the viewport
    editor.Canvas.setCoords(-1000, 0);
    // the stub does not follow the coords, so it keeps reporting the same rects: one correction only
    expect(editor.Canvas.getCoords().x).toBe(70 - 1000);
  });

  it('does not touch coords that are in range', () => {
    stubLayout([1000, 600], [100, 60, 700, 400]);
    editor.Canvas.setCoords(10, 20);
    expect(editor.Canvas.getCoords()).toEqual({ x: 10, y: 20 });
  });

  it('reports the zoom and clamps it to 10-400', () => {
    editor.Canvas.setZoom(150);
    expect(onZoom).toHaveBeenLastCalledWith(150);
    onZoom.mockClear();
    editor.Canvas.setZoom(900);
    expect(editor.Canvas.getZoom()).toBe(400);
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onZoom).toHaveBeenLastCalledWith(400);
    editor.Canvas.setZoom(2);
    expect(editor.Canvas.getZoom()).toBe(10);
    expect(onZoom).toHaveBeenLastCalledWith(10);
  });

  it('rounds fractional zoom from Ctrl+wheel', () => {
    editor.Canvas.setZoom(123.6);
    expect(onZoom).toHaveBeenLastCalledWith(124);
  });

  it('turns a scroll of the canvas element (scrollIntoView, focus) into a pan', () => {
    stubLayout([1000, 600], [100, 60, 700, 400]);
    editor.Canvas.setCoords(10, 20);
    const canvasEl = editor.Canvas.getElement()!;
    canvasEl.scrollLeft = 145;
    canvasEl.scrollTop = 30;
    canvasEl.dispatchEvent(new Event('scroll'));
    expect(canvasEl.scrollLeft).toBe(0);
    expect(canvasEl.scrollTop).toBe(0);
    expect(editor.Canvas.getCoords()).toEqual({ x: 10 - 145, y: 20 - 30 });
  });

  it('Ctrl+wheel zooms about 10% per mouse notch (not straight to the minimum)', () => {
    stubLayout([1000, 600], [100, 60, 700, 400]);
    editor.Canvas.setZoom(100);
    const canvasEl = editor.Canvas.getElement()!;
    const wheel = (deltaY: number) => {
      const ev = new WheelEvent('wheel', {
        deltaY,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      canvasEl.dispatchEvent(ev);
      return ev;
    };
    expect(wheel(100).defaultPrevented).toBe(true);
    expect(editor.Canvas.getZoom()).toBeCloseTo(100 * Math.exp(-0.1), 3);
    expect(onZoom).toHaveBeenLastCalledWith(90);
    wheel(-100);
    expect(editor.Canvas.getZoom()).toBeCloseTo(100, 3);
    // a plain wheel (pan) is left to GrapesJS
    const before = editor.Canvas.getZoom();
    canvasEl.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }),
    );
    expect(editor.Canvas.getZoom()).toBe(before);
  });

  it('Space runs the pan command at 100% and Space keyup stops it', () => {
    expect(editor.Canvas.getZoom()).toBe(100);
    const down = key('keydown');
    expect(down.defaultPrevented).toBe(true);
    expect(editor.Commands.isActive('core:canvas-move')).toBe(true);
    key('keydown'); // key repeat: still one run
    expect(editor.Commands.isActive('core:canvas-move')).toBe(true);
    key('keyup');
    expect(editor.Commands.isActive('core:canvas-move')).toBe(false);
  });

  it('runs the pan command only once at zoom != 100% (no double run with GrapesJS)', () => {
    editor.Canvas.setZoom(50);
    const spy = vi.spyOn(editor, 'runCommand');
    key('keydown');
    key('keydown');
    expect(spy.mock.calls.filter(([id]) => id === 'core:canvas-move')).toHaveLength(1);
    key('keyup');
  });

  it('Space inside an input does not pan', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const ev = key('keydown', input);
    expect(ev.defaultPrevented).toBe(false);
    expect(editor.Commands.isActive('core:canvas-move')).toBe(false);
    input.remove();
  });

  it('Space inside a contenteditable does not pan', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    document.body.appendChild(div);
    const ev = key('keydown', div);
    expect(ev.defaultPrevented).toBe(false);
    expect(editor.Commands.isActive('core:canvas-move')).toBe(false);
    div.remove();
  });

  it('Space with a modifier is left alone', () => {
    const ev = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    document.dispatchEvent(ev);
    expect(editor.Commands.isActive('core:canvas-move')).toBe(false);
  });

  it('middle button drag pans by the pointer movement', () => {
    editor.Canvas.setCoords(10, 20);
    const down = new MouseEvent('mousedown', {
      button: 1,
      screenX: 100,
      screenY: 100,
      bubbles: true,
      cancelable: true,
    });
    canvasEl().dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(canvasEl().classList.contains('gjs-is__grabbing')).toBe(true);
    document.dispatchEvent(
      new MouseEvent('mousemove', { screenX: 130, screenY: 90, bubbles: true }),
    );
    expect(editor.Canvas.getCoords()).toEqual({ x: 40, y: 10 });
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(canvasEl().classList.contains('gjs-is__grabbing')).toBe(false);
    document.dispatchEvent(
      new MouseEvent('mousemove', { screenX: 500, screenY: 500, bubbles: true }),
    );
    expect(editor.Canvas.getCoords()).toEqual({ x: 40, y: 10 });
  });

  it('other buttons do not pan', () => {
    const down = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
    canvasEl().dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    expect(canvasEl().classList.contains('gjs-is__grabbing')).toBe(false);
  });

  it('destroy removes the DOM and every listener', async () => {
    nav.destroy();
    expect(canvasEl().querySelector('.tf-cnav')).toBeNull();
    onZoom.mockClear();
    editor.Canvas.setZoom(80);
    expect(onZoom).not.toHaveBeenCalled();
    key('keydown');
    expect(editor.Commands.isActive('core:canvas-move')).toBe(false);
    // a second destroy (adapter teardown order) is harmless
    expect(() => nav.destroy()).not.toThrow();
  });
});
