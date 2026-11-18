import type { Page } from 'playwright-core';
import type { ChromiumBrowser } from '../../reports/infrastructure/chromium/chromium-browser';
import type {
  DecomposedLayer,
  PrototypeBlockOutcome,
  PrototypeDecomposeOutcome,
  PrototypeFailure,
  PrototypeFreeLayoutOutcome,
  PrototypeRenderer,
  PrototypeRenderOutcome,
} from '../domain/ports';
import { FREE_LAYOUT_SCRIPT } from './free-layout-script';

const RENDER_TIMEOUT_MS = 30_000;
/** Cutting a screen into up to 500 images takes longer than one PNG. */
const DECOMPOSE_TIMEOUT_MS = 120_000;
/** Images and fonts that are still loading after this are drawn as they are. */
const SETTLE_TIMEOUT_MS = 5_000;

/**
 * Inserts the rule that hides every layer root right after the doctype (layout is untouched).
 * With `showContainerDepth`, the containers of that depth are shown again: their layer image is
 * the container itself, without any layer inside (`visibility` is inherited, but an explicit
 * `visible` on the container wins over a hidden ancestor).
 */
export const hideLayers = (document: string, showContainerDepth?: number): string => {
  const show =
    showContainerDepth === undefined
      ? ''
      : `[data-tf-container="${showContainerDepth}"]{visibility:visible!important}`;
  const rule = `<style>[data-tf-layer]{visibility:hidden!important}${show}</style>`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(document)?.[0] ?? '';
  return `${doctype}${rule}${document.slice(doctype.length)}`;
};

/**
 * Belt and braces for the one render that runs JavaScript (`freeLayout`): a CSP right after the
 * doctype forbids every script of the page itself. Our own `page.evaluate` is not subject to it.
 */
const noScripts = (document: string): string => {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(document)?.[0] ?? '';
  const meta = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; connect-src 'none'">`;
  return `${doctype}${meta}${document.slice(doctype.length)}`;
};

const failure = (error: string, unavailable: boolean): PrototypeFailure => ({
  ok: false,
  error,
  unavailable,
});

/**
 * Prototype -> PNG with the shared headless Chromium: JavaScript off (except `freeLayout`), no network (only `data:`
 * URLs load), `setContent` only. The screenshot is the viewport, so it is exactly `width`×`height`
 * (times the device scale factor).
 */
export class ChromiumPrototypeRenderer implements PrototypeRenderer {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly browser: ChromiumBrowser) {}

  render(input: Parameters<PrototypeRenderer['render']>[0]): Promise<PrototypeRenderOutcome> {
    return this.enqueue(() =>
      this.withPage(
        input,
        RENDER_TIMEOUT_MS,
        async (page, blockedRequests): Promise<PrototypeRenderOutcome> => {
          const png = await page.screenshot({
            type: 'png',
            animations: 'disabled',
            caret: 'initial',
          });
          return {
            ok: true,
            png: new Uint8Array(png),
            width: input.width * input.scale,
            height: input.height * input.scale,
            blockedRequests: blockedRequests(),
          };
        },
      ),
    );
  }

  /**
   * Leaf layers first (a clipped screenshot of each marked element's box, nothing hidden), then the
   * containers one nesting depth at a time (the page loaded again with every layer hidden except
   * the containers of that depth), then the background (every layer hidden). Reloading with the
   * rule in the markup keeps it working with JavaScript off (anything that injects a script, like
   * `addStyleTag`, hangs); element handles, boxes and screenshots go through the protocol.
   */
  decompose(
    input: Parameters<PrototypeRenderer['decompose']>[0],
  ): Promise<PrototypeDecomposeOutcome> {
    return this.enqueue(() =>
      this.withPage(
        input,
        DECOMPOSE_TIMEOUT_MS,
        async (page): Promise<PrototypeDecomposeOutcome> => {
          const layers: DecomposedLayer[] = [];
          const depths = new Set<number>();
          for (const handle of await page.$$('[data-tf-container]')) {
            const depth = Number(await handle.getAttribute('data-tf-container'));
            if (Number.isInteger(depth) && depth >= 0) depths.add(depth);
          }
          await cutLayers(page, input, '[data-tf-layer]:not([data-tf-container])', layers);
          for (const depth of [...depths].sort((a, b) => a - b)) {
            await reload(page, hideLayers(input.document, depth));
            await cutLayers(page, input, `[data-tf-container="${depth}"]`, layers);
          }
          await reload(page, hideLayers(input.document));
          const background = await page.screenshot({
            type: 'png',
            animations: 'disabled',
            caret: 'initial',
          });
          layers.sort((a, b) => a.n - b.n);
          return { ok: true, background: new Uint8Array(background), layers };
        },
      ),
    );
  }

  /**
   * The screen as a free layout (see `PrototypeRenderer.freeLayout`). This is the only render with
   * JavaScript on, and the only script is ours (`page.evaluate`): the markup is sanitized, a CSP
   * blocks anything inline, and the context has no network but `data:`.
   */
  freeLayout(
    input: Parameters<PrototypeRenderer['freeLayout']>[0],
  ): Promise<PrototypeFreeLayoutOutcome> {
    return this.enqueue(() =>
      this.withPage(
        { ...input, document: noScripts(input.document), scale: 1, javaScriptEnabled: true },
        DECOMPOSE_TIMEOUT_MS,
        async (page): Promise<PrototypeFreeLayoutOutcome> => {
          const html: unknown = await page.evaluate(FREE_LAYOUT_SCRIPT);
          if (typeof html !== 'string' || !html)
            return failure('A conversão não gerou HTML.', false);
          return { ok: true, html };
        },
      ),
    );
  }

  renderBlock(
    input: Parameters<PrototypeRenderer['renderBlock']>[0],
  ): Promise<PrototypeBlockOutcome> {
    return this.enqueue(() =>
      this.withPage(
        { ...input, scale: 1 },
        RENDER_TIMEOUT_MS,
        async (page): Promise<PrototypeBlockOutcome> => {
          const block = await page.$('[data-tf-block]');
          const box = await block?.boundingBox();
          if (!block || !box) return failure('O bloco não ficou visível.', false);
          const png = await block.screenshot({
            type: 'png',
            animations: 'disabled',
            caret: 'initial',
          });
          return {
            ok: true,
            png: new Uint8Array(png),
            width: Math.ceil(box.width),
            height: Math.ceil(box.height),
          };
        },
      ),
    );
  }

  /** One page at a time keeps memory low on small servers. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Opens `document` in an isolated context (JavaScript off, no network, `setContent` only) with a
   * viewport of `width`×`height`, runs `work` on it and always closes the context. A launch failure
   * is "unavailable"; any other error is a plain failure.
   */
  private async withPage<T>(
    input: {
      document: string;
      width: number;
      height: number;
      scale: 1 | 2;
      /** Only `freeLayout` turns it on; every other render has no JavaScript at all. */
      javaScriptEnabled?: boolean;
    },
    timeoutMs: number,
    work: (page: Page, blockedRequests: () => number) => Promise<T>,
  ): Promise<T | PrototypeFailure> {
    try {
      return await this.browser.use(async (browser) => {
        const context = await this.browser.newIsolatedContext(browser, {
          javaScriptEnabled: input.javaScriptEnabled ?? false,
          viewport: { width: input.width, height: input.height },
          deviceScaleFactor: input.scale,
        });
        let timer: NodeJS.Timeout | undefined;
        try {
          const job = (async (): Promise<T> => {
            const page = await context.newPage();
            let blockedRequests = 0;
            page.on('requestfailed', (request) => {
              if (!request.url().startsWith('data:')) blockedRequests += 1;
            });
            await page.setContent(input.document, {
              waitUntil: 'load',
              timeout: SETTLE_TIMEOUT_MS * 2,
            });
            await settle(page);
            return work(page, () => blockedRequests);
          })();
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Tempo esgotado ao gerar a imagem.')),
              timeoutMs,
            );
          });
          return await Promise.race([job, timeout]);
        } finally {
          if (timer) clearTimeout(timer);
          await context.close().catch(() => undefined);
        }
      });
    } catch (err) {
      const message = (err as Error).message.split('\n')[0] ?? 'falha desconhecida';
      // a launch failure (missing browser) is "unavailable"; anything else is a render failure
      const unavailable = /Chromium|renderizador|launch|executable/i.test(message);
      return failure(message, unavailable);
    }
  }
}

/** Loads another document in the page and waits for it to settle. */
async function reload(page: Page, document: string): Promise<void> {
  await page.setContent(document, { waitUntil: 'load', timeout: SETTLE_TIMEOUT_MS * 2 });
  await settle(page);
}

/** Screenshots the box of every `selector` match (visible, inside the page) into `layers`. */
async function cutLayers(
  page: Page,
  input: { width: number; height: number; layerCount: number },
  selector: string,
  layers: DecomposedLayer[],
): Promise<void> {
  for (const handle of await page.$$(selector)) {
    const n = Number(await handle.getAttribute('data-tf-layer'));
    const box = await handle.boundingBox();
    if (!box || !Number.isInteger(n) || n < 1 || n > input.layerCount) continue;
    // whole CSS pixels, clipped to the page: what is outside the screen is not captured
    const x = Math.max(0, Math.floor(box.x));
    const y = Math.max(0, Math.floor(box.y));
    const width = Math.min(input.width, Math.ceil(box.x + box.width)) - x;
    const height = Math.min(input.height, Math.ceil(box.y + box.height)) - y;
    if (width < 1 || height < 1) continue;
    const png = await page.screenshot({
      type: 'png',
      animations: 'disabled',
      caret: 'initial',
      clip: { x, y, width, height },
    });
    layers.push({ n, x, y, width, height, png: new Uint8Array(png) });
  }
}

/** Waits (bounded) for web fonts and images; with JavaScript off the page is poked via CDP. */
async function settle(page: Page): Promise<void> {
  const wait = page
    .evaluate(async () => {
      const doc = (
        globalThis as unknown as {
          document: {
            fonts?: { ready: Promise<unknown> };
            images: ArrayLike<{ complete: boolean; decode(): Promise<void> }>;
          };
        }
      ).document;
      await doc.fonts?.ready;
      await Promise.all(Array.from(doc.images).map((img) => img.decode().catch(() => undefined)));
    })
    .catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, SETTLE_TIMEOUT_MS);
  });
  try {
    await Promise.race([wait, limit]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
