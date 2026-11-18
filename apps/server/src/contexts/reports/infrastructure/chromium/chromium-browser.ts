import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import type { RendererStatus } from '../../domain/render-ports';

export interface ChromiumBrowserOptions {
  /** `reportSettings.chromiumPath`; '' = the browser Playwright installed. */
  executablePath?: () => string;
  /** `--no-sandbox` is only added inside containers (or as root), where the sandbox cannot start. */
  noSandbox?: () => boolean;
  idleMs?: number;
  /** How long a failed launch is remembered before trying again. */
  failureTtlMs?: number;
  now?: () => number;
}

const defaultNoSandbox = (): boolean =>
  process.env.CHROMIUM_NO_SANDBOX === '1' ||
  fs.existsSync('/.dockerenv') ||
  fs.existsSync('/run/.containerenv') ||
  process.getuid?.() === 0;

const installHint =
  'rode `pnpm --filter @thinkflow/web exec playwright install chromium` (ou informe o caminho do Chromium em Ajustes)';

/**
 * One headless Chromium shared by the diagram and PDF renderers. It starts on first use, closes
 * after `idleMs` without work and remembers a failed launch for a few minutes.
 */
export class ChromiumBrowser {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private active = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private failure: { at: number; path: string; message: string } | null = null;
  private closed = false;

  constructor(private readonly options: ChromiumBrowserOptions = {}) {}

  private configuredPath(): string {
    return (this.options.executablePath?.() ?? '').trim();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Path that would be launched (configured one, else Playwright's own). */
  resolvedPath(): string | null {
    const configured = this.configuredPath();
    if (configured) return configured;
    try {
      return chromium.executablePath();
    } catch {
      return null;
    }
  }

  async status(): Promise<RendererStatus> {
    const configured = this.configuredPath();
    if (configured && !fs.existsSync(configured)) {
      return {
        available: false,
        reason: `Chromium não encontrado em ${configured}; confira o caminho em Ajustes.`,
        executablePath: configured,
      };
    }
    try {
      await this.ensure();
      this.scheduleIdle();
      return { available: true, reason: null, executablePath: this.resolvedPath() };
    } catch (err) {
      return {
        available: false,
        reason: (err as Error).message,
        executablePath: this.resolvedPath(),
      };
    }
  }

  /** Runs `fn` with a live browser (relaunching it if it was closed meanwhile). */
  async use<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
    this.active += 1;
    this.cancelIdle();
    try {
      return await fn(await this.ensure());
    } finally {
      this.active -= 1;
      this.scheduleIdle();
    }
  }

  /** A context with no network at all: every request that is not `data:` is aborted. */
  async newIsolatedContext(
    browser: Browser,
    options: {
      javaScriptEnabled: boolean;
      /** Fixed page size (screenshots); default: the browser's own window size. */
      viewport?: { width: number; height: number };
      deviceScaleFactor?: number;
    },
  ): Promise<BrowserContext> {
    const context = await browser.newContext({
      ...(options.viewport ? { viewport: options.viewport } : {}),
      ...(options.deviceScaleFactor ? { deviceScaleFactor: options.deviceScaleFactor } : {}),
      offline: true,
      javaScriptEnabled: options.javaScriptEnabled,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await context.route('**/*', (route) =>
      route.request().url().startsWith('data:') ? route.continue() : route.abort(),
    );
    return context;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelIdle();
    const browser = this.browser;
    this.browser = null;
    this.launching = null;
    await browser?.close().catch(() => undefined);
  }

  private async ensure(): Promise<Browser> {
    if (this.closed) throw new Error('O renderizador foi encerrado.');
    if (this.browser?.isConnected()) return this.browser;
    const configured = this.configuredPath();
    if (
      this.failure &&
      this.failure.path === configured &&
      this.now() - this.failure.at < (this.options.failureTtlMs ?? 300_000)
    )
      throw new Error(this.failure.message);
    this.launching ??= this.launch(configured).finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async launch(configured: string): Promise<Browser> {
    try {
      const noSandbox = (this.options.noSandbox ?? defaultNoSandbox)();
      const browser = await chromium.launch({
        headless: true,
        ...(configured ? { executablePath: configured } : {}),
        args: [
          ...(noSandbox ? ['--no-sandbox'] : []),
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--font-render-hinting=none',
        ],
        timeout: 30_000,
      });
      browser.on('disconnected', () => {
        if (this.browser === browser) this.browser = null;
      });
      this.browser = browser;
      this.failure = null;
      return browser;
    } catch (err) {
      const path = configured || this.resolvedPath() || '(padrão)';
      const missing = /Executable doesn't exist|ENOENT|not found/i.test((err as Error).message);
      const message = missing
        ? `Chromium não encontrado em ${path}; ${installHint}.`
        : `Não foi possível iniciar o Chromium (${(err as Error).message.split('\n')[0]}).`;
      this.failure = { at: this.now(), path: configured, message };
      throw new Error(message, { cause: err });
    }
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    this.cancelIdle();
    if (!this.browser || this.active > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.active > 0) return;
      const browser = this.browser;
      this.browser = null;
      void browser?.close().catch(() => undefined);
    }, this.options.idleMs ?? 60_000);
    this.idleTimer.unref();
  }
}
