import { randomUUID } from 'node:crypto';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type Frame,
  type Page,
  type Request,
} from 'playwright-core';
import { TEST_LIMITS, type RecordingMode, type TestViewport } from '@thinkflow/shared';
import type { ElementFacts, EventPage, RecorderEvent } from '../../domain/recorder-events';
import type { SettleReading } from '../../domain/settle';
import type {
  RecordedPageId,
  RecorderBrowser,
  RecorderListener,
  RecordingHandle,
  Screenshot,
  ScreenSnapshot,
} from '../../domain/ports';
import { frameBaseCss, isolateTopCss, scopeCss, TOP_QUIRKS_CSS } from '../../domain/frame-css';
import {
  absolutizeCssUrls,
  isWindowFrameUrl,
  pickRoutineChild,
  pickWindowFrame,
  type FrameCandidate,
  type WindowCandidate,
} from '../../domain/prototype-capture';
import { DownloadWatcher } from './download-capture';
import {
  prototypeSerializerDefaults,
  prototypeSerializerExpression,
  prototypeSerializerOnElement,
  type RawCssPart,
  type RawPrototypeSnapshot,
} from './prototype-script';
import { RECORDER_BINDING, RECORDER_SCRIPT, SCREENSHOT_STYLE } from './recorder-script';

/** Pictures inlined as `data:` URIs in a captured screen. */
const PROTOTYPE_IMAGE_LIMITS = {
  maxImageBytes: 2 * 1024 * 1024,
  maxTotalImageBytes: 9 * 1024 * 1024,
};
/** A stylesheet the page could not read is downloaded by the server; bigger ones are skipped. */
const MAX_FETCHED_CSS_BYTES = 2 * 1024 * 1024;
const PROTOTYPE_TIMEOUT_MS = 40_000;

/**
 * A function for `ElementHandle.evaluate` from source text `(el) => …`. A string would be taken as
 * an expression (not called with the element), and a compiled function could carry bundler helpers
 * into the page, so the function is built here from the text.
 */
export function pageFunction<R>(source: string): (el: unknown) => R {
  return new Function('el', `return (${source})(el)`) as unknown as (el: unknown) => R;
}

/**
 * Runs in the page with the `<iframe>` element: its size in the parent, whether it shows and
 * whether it is the one in front (nothing covers the middle of its visible part).
 */
const FRAME_BOX_FN = `(el) => {
  const rect = el.getBoundingClientRect();
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const style = view.getComputedStyle(el);
  const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 20 && rect.height > 20;
  let topmost = false;
  if (visible) {
    const x = Math.min(Math.max((Math.max(rect.left, 0) + Math.min(rect.right, view.innerWidth)) / 2, 0), view.innerWidth - 1);
    const y = Math.min(Math.max((Math.max(rect.top, 0) + Math.min(rect.bottom, view.innerHeight)) / 2, 0), view.innerHeight - 1);
    topmost = doc.elementFromPoint(x, y) === el;
  }
  return { area: rect.width * rect.height, visible, topmost };
}`;

/**
 * Runs in the page with a window's `<iframe>` element: the element that holds the window as the
 * person sees it. The e-Cidade desktop draws the title bar and buttons in the page around the
 * iframe, inside nested boxes (some of them with no height of their own). This climbs at most 6
 * levels and takes the outermost ancestor that is only a little bigger than the iframe (up to +90 px
 * tall, +40 px wide) and still covers it, ignoring boxes with no size; among those it prefers one
 * that looks like a window (`.dialog`, `[class*=window]`, a title inside). Null when there is none.
 */
export const WINDOW_CHROME_FN = `(el) => {
  const r = el.getBoundingClientRect();
  const doc = el.ownerDocument;
  const WINDOWISH = '.dialog,[class*=window],[class*=Window],[class*=dialog],[class*=Dialog]';
  const TITLE = '.title_window,[class*=title],[class*=Title]';
  const slack = 4;
  const found = [];
  let levels = 0;
  for (let p = el.parentElement; p && p !== doc.body && p !== doc.documentElement && levels < 6; p = p.parentElement, levels++) {
    const b = p.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    const covers = b.left <= r.left + slack && b.top <= r.top + slack && b.right >= r.right - slack && b.bottom >= r.bottom - slack;
    if (!covers || b.width > r.width + 40 || b.height > r.height + 90) break;
    found.push(p);
  }
  if (found.length === 0) return null;
  const looksLikeWindow = (p) => p.matches(WINDOWISH) || !!p.querySelector(TITLE);
  let best = null;
  for (const p of found) if (looksLikeWindow(p)) best = p;
  if (!best) best = found[found.length - 1];
  const b = best.getBoundingClientRect();
  return b.height - r.height < 8 && b.width - r.width < 8 ? null : best;
}`;

export interface PlaywrightRecorderOptions {
  /** `reportSettings.chromiumPath`; '' = the browser Playwright installed. */
  executablePath?: () => string;
  /** Tests run the recorder headless. */
  headless?: boolean;
  /** A navigation this long after the last action is treated as typed by the user (default 3 s). */
  navigationGraceMs?: number;
  /** Tests drive the recorded pages through this hook. */
  onPageOpened?: (page: Page) => void;
}

const INSTALL_HINT =
  'rode `pnpm --filter @thinkflow/web exec playwright install chromium` (ou informe o caminho do Chromium em Relatórios › Ajustes)';

/** pt-BR, secret-free message for a browser that failed to start. */
export function launchErrorMessage(err: unknown, path: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/Executable doesn't exist|ENOENT|not found/i.test(message))
    return `Chromium não encontrado em ${path}; ${INSTALL_HINT}.`;
  return `Não foi possível abrir o navegador (${message.split('\n')[0]}).`;
}

type Message =
  | { kind: 'hello' }
  | { kind: 'event'; event: Omit<RecorderEvent, 'at'> }
  | { kind: 'capture' }
  | { kind: 'pause'; paused: boolean }
  | { kind: 'stop' }
  | { kind: 'checkpoint' }
  | { kind: 'prototype' }
  | { kind: 'activity' };

/** Only what the page is allowed to report: everything else from the page is dropped. */
function parseEvent(raw: unknown): Omit<RecorderEvent, 'at'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const facts = e.facts as ElementFacts | null | undefined;
  const factsOk =
    !!facts &&
    typeof facts === 'object' &&
    Array.isArray(facts.candidates) &&
    typeof facts.tag === 'string';
  switch (e.type) {
    case 'click':
    case 'dblclick':
    case 'check':
    case 'uncheck':
      return factsOk ? ({ type: e.type, facts } as Omit<RecorderEvent, 'at'>) : null;
    case 'fill':
    case 'select':
      return factsOk && typeof e.value === 'string'
        ? ({ type: e.type, facts, value: e.value.slice(0, 10_000) } as Omit<RecorderEvent, 'at'>)
        : null;
    case 'press':
      return typeof e.key === 'string' && /^[A-Za-z]{1,20}$/.test(e.key)
        ? ({ type: 'press', facts: factsOk ? facts : null, key: e.key } as Omit<
            RecorderEvent,
            'at'
          >)
        : null;
    default:
      return null;
  }
}

/** Size of the screenshot of `page` in pixels (inner size of the window × the screen's scale). */
async function pageSize(page: Page): Promise<TestViewport> {
  const fixed = page.viewportSize();
  if (fixed) return fixed;
  // a string expression: no DOM types in the server's tsconfig
  const size = await page
    .evaluate<{ w: number; h: number; r: number }>(
      '({ w: innerWidth, h: innerHeight, r: devicePixelRatio || 1 })',
    )
    .catch(() => null);
  if (!size) return { width: 0, height: 0 };
  return { width: Math.round(size.w * size.r), height: Math.round(size.h * size.r) };
}

class PlaywrightRecording implements RecordingHandle {
  private readonly pages = new Map<RecordedPageId, Page>();
  private readonly ids = new WeakMap<Page, RecordedPageId>();
  private current: Page | null = null;
  /** Frame of each page where the user last clicked or typed. */
  private readonly activeFrames = new WeakMap<Page, Frame>();
  private lastActionAt = 0;
  private closed = false;
  /** Inner size (CSS pixels) of the window when it opened; null if it could not be read. */
  viewport: TestViewport | null = null;
  private state: { paused: boolean; mode: RecordingMode } = { paused: false, mode: 'record' };
  /** Requests in flight and when the network last changed (for "has the screen settled?"). */
  private readonly inflight = new Set<Request>();
  private lastNetworkAt = 0;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly listener: RecorderListener,
    private readonly graceMs: number,
    private readonly downloads: DownloadWatcher,
    private readonly onPageOpened?: (page: Page) => void,
  ) {}

  async init(url: string): Promise<void> {
    await this.context.exposeBinding(RECORDER_BINDING, (source, message: Message) =>
      this.onMessage(source.page, source.frame, message),
    );
    await this.context.addInitScript(RECORDER_SCRIPT);
    this.context.on('page', (page) => this.register(page));
    this.trackNetwork();
    this.browser.on('disconnected', () => this.finish());
    const page = await this.context.newPage();
    this.register(page);
    const inner = await page
      .evaluate<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })')
      .catch(() => null);
    if (inner && inner.w > 0 && inner.h > 0) this.viewport = { width: inner.w, height: inner.h };
    this.lastActionAt = Date.now(); // the first navigation is the recorded `goto`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {
      // a slow or failing page still leaves the window open for the user
    });
  }

  /**
   * Long-lived connections (event streams, media) would keep the screen "loading" forever: they
   * do not count as in-flight requests.
   */
  private trackNetwork(): void {
    const ignored = (r: Request) =>
      ['eventsource', 'websocket', 'media'].includes(r.resourceType());
    const done = (r: Request) => {
      if (this.inflight.delete(r)) this.lastNetworkAt = Date.now();
    };
    this.context.on('request', (r) => {
      if (ignored(r)) return;
      this.inflight.add(r);
      this.lastNetworkAt = Date.now();
    });
    this.context.on('requestfinished', done);
    this.context.on('requestfailed', done);
  }

  private register(page: Page): void {
    if (this.ids.has(page)) return;
    const id = randomUUID();
    this.ids.set(page, id);
    this.pages.set(id, page);
    this.current = page;
    this.onPageOpened?.(page);
    // tabs and popups alike: the file is taken out of the temporary folder right away
    this.downloads.attach(page, (capture) => {
      if (!this.closed) this.listener.onDownload(capture, id);
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || this.closed) return;
      if (Date.now() - this.lastActionAt < this.graceMs) return; // caused by a recorded action
      this.listener.onEvent(
        { type: 'navigate', url: frame.url(), at: Date.now() },
        this.pageInfoSync(page),
        id,
      );
    });
    page.on('close', () => {
      this.pages.delete(id);
      if (this.current === page) this.current = [...this.pages.values()].at(-1) ?? null;
      if (this.pages.size === 0) void this.close();
    });
  }

  private pageInfoSync(page: Page): EventPage {
    return { url: page.url(), title: '' };
  }

  private async pageInfo(page: Page): Promise<EventPage> {
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  private async onMessage(page: Page, frame: Frame, message: Message): Promise<unknown> {
    if (this.closed || !message || typeof message !== 'object') return null;
    const pageId = this.ids.get(page);
    if (!pageId) return null;
    this.current = page;
    switch (message.kind) {
      case 'hello':
        return this.state;
      case 'capture':
        this.listener.onCaptureRequest(pageId);
        return null;
      case 'pause':
        this.state.paused = Boolean(message.paused);
        this.listener.onPauseToggle(this.state.paused);
        await this.broadcast();
        return null;
      case 'stop':
        // "Parar" on the toolbar = closing the window; reply to the binding before the browser goes
        setTimeout(() => void this.close(), 0);
        return null;
      case 'checkpoint':
        this.listener.onCheckpointRequest(pageId);
        return null;
      case 'prototype':
        this.listener.onPrototypeRequest(pageId);
        return null;
      case 'activity':
        // the frame the user is working in: where "Protótipo" captures from
        this.activeFrames.set(page, frame);
        return null;
      case 'event': {
        if (this.state.paused || this.state.mode === 'capture') return null;
        const event = parseEvent(message.event);
        if (!event) return null;
        // iframes: the frame's own URL travels with the facts
        const facts = 'facts' in event ? (event.facts as ElementFacts | null) : null;
        if (facts && frame !== page.mainFrame()) {
          facts.frameUrl = frame.url();
          facts.bbox = null;
        }
        this.lastActionAt = Date.now();
        this.listener.onEvent(
          { ...event, at: Date.now() } as RecorderEvent,
          await this.pageInfo(page),
          pageId,
        );
        return null;
      }
      default:
        return null;
    }
  }

  private pageOf(pageId: RecordedPageId | null): Page | null {
    const page = (pageId ? this.pages.get(pageId) : this.current) ?? this.current;
    return page && !page.isClosed() ? page : null;
  }

  async settleReading(pageId: RecordedPageId | null): Promise<SettleReading | null> {
    const page = this.pageOf(pageId);
    if (!page) return null;
    const now = Date.now();
    // every frame of the page: a frame that is gone or navigating counts as not loaded yet
    const frames = await Promise.all(
      page.frames().map((frame) =>
        frame
          .evaluate<{ complete: boolean; quietMs: number } | null>(
            // a string expression: no DOM types in the server's tsconfig
            'window.__tfSettle ? window.__tfSettle() : { complete: document.readyState === "complete", quietMs: 1e9 }',
          )
          .catch(() => null),
      ),
    );
    const loaded = frames.every((f) => f?.complete === true);
    return {
      loaded,
      pendingRequests: this.inflight.size,
      networkQuietMs: this.lastNetworkAt === 0 ? 1e9 : now - this.lastNetworkAt,
      domQuietMs: frames.reduce((min, f) => Math.min(min, f?.quietMs ?? 0), 1e9),
    };
  }

  async screenshot(
    pageId: RecordedPageId | null,
    options: { maskCss: string[] },
  ): Promise<Screenshot | null> {
    const page = this.pageOf(pageId);
    if (!page) return null;
    // maximized windows have no fixed viewport: the size is read from the page itself
    const viewport = await pageSize(page);
    // PNG at the real window size and device scale: lossless text, and annotations never stack
    // JPEG artifacts on top of each other
    const bytes = await page.screenshot({
      type: 'png',
      scale: 'device',
      mask: options.maskCss.map((css) => page.locator(css)),
      maskColor: '#1f2937',
      animations: 'disabled',
      caret: 'hide',
      style: SCREENSHOT_STYLE,
      timeout: 10_000,
    });
    return {
      bytes: new Uint8Array(bytes),
      width: viewport.width,
      height: viewport.height,
      page: await this.pageInfo(page),
    };
  }

  /** Area of `frame` in its parent plus the visibility of its `<iframe>`; null when unknown. */
  private async frameBox(
    frame: Frame,
  ): Promise<{ area: number; visible: boolean; topmost: boolean } | null> {
    try {
      const handle = await frame.frameElement();
      return await handle.evaluate(
        pageFunction<{ area: number; visible: boolean; topmost: boolean }>(FRAME_BOX_FN),
      );
    } catch {
      return null;
    }
  }

  /** The frame where the user last clicked or typed (the main frame when unknown). */
  private startFrame(page: Page): Frame {
    const remembered = this.activeFrames.get(page);
    return remembered && !remembered.isDetached() && page.frames().includes(remembered)
      ? remembered
      : page.mainFrame();
  }

  /** The routine's frame: where the user last worked, then down into the frame that fills it. */
  private async routineFrame(page: Page): Promise<Frame> {
    return this.descend(this.startFrame(page));
  }

  /** From `start`, down into the biggest visible child that fills most of it, as deep as it goes. */
  private async descend(start: Frame): Promise<Frame> {
    let frame = start;
    for (let depth = 0; depth < 4; depth++) {
      const children = frame.childFrames();
      if (children.length === 0) break;
      const size = await frame
        .evaluate<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })')
        .catch(() => null);
      const candidates: (FrameCandidate & { frame: Frame })[] = [];
      for (const [index, child] of children.entries()) {
        const box = await this.frameBox(child);
        if (box) candidates.push({ index, frame: child, url: child.url(), ...box });
      }
      const next = pickRoutineChild(size ? size.w * size.h : 0, candidates);
      if (!next) break;
      frame = candidates.find((c) => c.index === next.index)!.frame;
    }
    return frame;
  }

  /**
   * The e-Cidade window the user is working in: from the frame they last used, up to the window
   * wrapper (`…/window/index/?action=…`); from the desktop itself, the window in front. `null`
   * when the page has no such window.
   */
  private async windowFrame(page: Page, start: Frame): Promise<Frame | null> {
    for (let f: Frame | null = start; f; f = f.parentFrame()) {
      if (!isWindowFrameUrl(f.url())) continue;
      const box = f === page.mainFrame() ? { visible: true } : await this.frameBox(f);
      if (box?.visible) return f;
      break;
    }
    // the desktop itself (or a frame outside any window): only the desktop picks "the window in front"
    if (start !== page.mainFrame()) return null;
    const candidates: (WindowCandidate & { frame: Frame })[] = [];
    for (const [index, frame] of page.frames().entries()) {
      if (frame === page.mainFrame() || frame.isDetached() || !isWindowFrameUrl(frame.url()))
        continue;
      const box = await this.frameBox(frame);
      if (box) candidates.push({ index, frame, url: frame.url(), ...box });
    }
    const front = pickWindowFrame(candidates);
    return front ? candidates.find((c) => c.index === front.index)!.frame : null;
  }

  /** Window title bar drawn around the window's iframe (in the parent page), when there is one. */
  private async windowChrome(win: Frame): Promise<ElementHandle | null> {
    try {
      const iframe = await win.frameElement();
      return (await iframe.evaluateHandle(pageFunction(WINDOW_CHROME_FN))).asElement();
    } catch {
      return null;
    }
  }

  async capturePrototype(pageId: RecordedPageId | null): Promise<ScreenSnapshot | null> {
    const page = this.pageOf(pageId);
    if (!page) return null;
    const win = await this.windowFrame(page, this.startFrame(page));
    const frame = win ?? (await this.routineFrame(page));
    const chrome = win ? await this.windowChrome(win) : null;
    const options = { ...PROTOTYPE_IMAGE_LIMITS, ...prototypeSerializerDefaults };
    const read = chrome
      ? chrome.evaluate(pageFunction<RawPrototypeSnapshot>(prototypeSerializerOnElement(options)))
      : frame.evaluate<RawPrototypeSnapshot>(prototypeSerializerExpression(options));
    const raw = await Promise.race([
      read,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Tempo esgotado ao ler a tela do navegador.')),
          PROTOTYPE_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
    // a window is the screen of the routine inside it: that frame names the screen
    const routine = win ? await this.descend(win) : frame;
    const title =
      routine === frame && !chrome
        ? raw.title
        : await routine
            .evaluate<string>('document.title')
            .then((t) => t || raw.title)
            .catch(() => raw.title);
    return {
      html: raw.html,
      css: await this.collectCss(raw),
      width: raw.width,
      height: raw.height,
      url: routine === frame && !chrome ? raw.url || frame.url() : routine.url(),
      title,
      flattenedFrames: raw.flattened,
      blankFrames: raw.blankFrames,
    };
  }

  /** The page's styles, then those of each flattened frame scoped to its `<div data-tf-frame>`. */
  private async collectCss(raw: RawPrototypeSnapshot): Promise<string> {
    // sheets the page could not read (other origin) are downloaded here, with the browser's cookies
    const resolve = async (parts: readonly RawCssPart[]): Promise<string> =>
      (
        await Promise.all(
          parts.map((part) => ('css' in part ? part.css : this.fetchStylesheet(part.href))),
        )
      )
        .filter(Boolean)
        .join('\n');
    const own = await resolve(raw.parts);
    const sheets = await Promise.all(raw.frames.map((f) => resolve(f.parts)));
    const seenFontFaces = new Set<string>();
    const out: string[] = [];
    if (raw.quirks) out.push(TOP_QUIRKS_CSS);
    // the captured document's own rules never reach into the flattened frames (nor do a frame's into its children)
    out.push(raw.frames.length > 0 ? isolateTopCss(own, { seenFontFaces }) : own);
    raw.frames.forEach((f, i) => {
      const hasChildFrames = raw.frames.some((other) => other.parent === f.id);
      out.push(frameBaseCss(f.id, { quirks: f.quirks, topQuirks: raw.quirks, hasChildFrames }));
      out.push(scopeCss(sheets[i]!, f.id, { seenFontFaces, hasChildFrames }));
    });
    return out.filter(Boolean).join('\n');
  }

  private async fetchStylesheet(href: string): Promise<string> {
    try {
      const res = await this.context.request.get(href, { timeout: 10_000, maxRedirects: 3 });
      if (!res.ok()) return '';
      const body = await res.body();
      if (body.byteLength > MAX_FETCHED_CSS_BYTES) return '';
      return absolutizeCssUrls(body.toString('utf8'), href);
    } catch {
      return ''; // the screen is captured without that sheet
    }
  }

  async currentPage(): Promise<EventPage | null> {
    const page = this.current;
    return page && !page.isClosed() ? this.pageInfo(page) : null;
  }

  async setState(state: { paused?: boolean; mode?: RecordingMode }): Promise<void> {
    if (state.paused !== undefined) this.state.paused = state.paused;
    if (state.mode !== undefined) this.state.mode = state.mode;
    await this.broadcast();
  }

  private async broadcast(): Promise<void> {
    const state = this.state;
    await Promise.all(
      [...this.pages.values()].flatMap((page) =>
        page.frames().map((frame) =>
          frame
            // a string expression: no DOM types in the server's tsconfig
            .evaluate(`window.__tfSetState && window.__tfSetState(${JSON.stringify(state)})`)
            .catch(() => undefined),
        ),
      ),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // closing the context deletes Playwright's temporary files: let the downloads finish first
    await this.downloads.drain();
    await this.browser.close().catch(() => undefined);
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.listener.onClosed();
  }
}

export class PlaywrightRecorderBrowser implements RecorderBrowser {
  constructor(private readonly options: PlaywrightRecorderOptions = {}) {}

  async start(
    options: { url: string; viewport: TestViewport; maxDownloadBytes?: number },
    listener: RecorderListener,
  ): Promise<RecordingHandle> {
    const configured = (this.options.executablePath?.() ?? '').trim();
    const headless = this.options.headless ?? false;
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless,
        ...(configured ? { executablePath: configured } : {}),
        // a visible window opens at the full monitor size (the user may shrink it)
        ...(headless ? {} : { args: ['--start-maximized'] }),
        timeout: 30_000,
      });
    } catch (err) {
      let path = configured;
      if (!path) {
        try {
          path = chromium.executablePath();
        } catch {
          path = '(padrão)';
        }
      }
      throw new Error(launchErrorMessage(err, path), { cause: err });
    }
    try {
      // headed: no fixed viewport (follows the maximized window; `deviceScaleFactor` cannot be set
      // then). Headless has no window to follow, so it keeps the configured size.
      const context = await browser.newContext(
        headless
          ? {
              viewport: options.viewport,
              deviceScaleFactor: 1,
              locale: 'pt-BR',
              acceptDownloads: true,
            }
          : { viewport: null, locale: 'pt-BR', acceptDownloads: true },
      );
      const recording = new PlaywrightRecording(
        browser,
        context,
        listener,
        this.options.navigationGraceMs ?? 3000,
        new DownloadWatcher(options.maxDownloadBytes ?? TEST_LIMITS.maxDownloadBytes),
        this.options.onPageOpened,
      );
      await recording.init(options.url);
      return recording;
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw err;
    }
  }
}
