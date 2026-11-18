import type { Browser, Page } from 'playwright-core';
import type {
  DiagramRenderer,
  DiagramRenderResult,
  RendererStatus,
} from '../../domain/render-ports';
import type { ChromiumBrowser } from './chromium-browser';
import { loadMermaidSource } from './mermaid-asset';

const RENDER_TIMEOUT_MS = 10_000;
const MAX_CODE_CHARS = 8_000;

interface Session {
  page: Page;
  close(): Promise<void>;
}

/** Mermaid rendered by the real engine: the only faithful validator of the syntax. */
export class ChromiumDiagramRenderer implements DiagramRenderer {
  private session: Promise<Session> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly browser: ChromiumBrowser,
    private readonly loadSource: () => string = loadMermaidSource,
  ) {}

  status(): Promise<RendererStatus> {
    return this.browser.status();
  }

  render(code: string, signal?: AbortSignal): Promise<DiagramRenderResult> {
    const run = this.chain.then(() => this.renderNow(code, signal));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async renderNow(code: string, signal?: AbortSignal): Promise<DiagramRenderResult> {
    if (signal?.aborted) return { ok: false, error: 'cancelado', unavailable: true };
    if (code.length > MAX_CODE_CHARS)
      return { ok: false, error: `Diagrama maior que ${MAX_CODE_CHARS} caracteres.` };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.browser.use(async (browser) => {
          const session = await this.ensureSession(browser);
          return await this.evaluate(session.page, code);
        });
      } catch (err) {
        await this.reset();
        if (attempt === 1) {
          return { ok: false, error: (err as Error).message, unavailable: true };
        }
      }
    }
    return { ok: false, error: 'falha desconhecida', unavailable: true };
  }

  private async evaluate(page: Page, code: string): Promise<DiagramRenderResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Tempo esgotado ao renderizar o diagrama.')),
        RENDER_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([
        page.evaluate(async (source: string): Promise<DiagramRenderResult> => {
          const page = globalThis as unknown as { mermaid: MermaidApi; document: PageDocument };
          const m = page.mermaid;
          const id = `mmd${Math.random().toString(36).slice(2, 10)}`;
          try {
            await m.parse(source);
            const { svg } = await m.render(id, source);
            return { ok: true, svg };
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { ok: false, error: message.slice(0, 1000) };
          } finally {
            page.document.getElementById(id)?.remove();
            page.document.getElementById(`d${id}`)?.remove();
          }
        }, code),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private ensureSession(browser: Browser): Promise<Session> {
    this.session ??= (async () => {
      const context = await this.browser.newIsolatedContext(browser, { javaScriptEnabled: true });
      try {
        const page = await context.newPage();
        await page.setContent('<!doctype html><html><body></body></html>');
        await page.addScriptTag({ content: this.loadSource() });
        await page.evaluate(() => {
          const m = (globalThis as unknown as { mermaid: MermaidApi }).mermaid;
          m.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'neutral',
            htmlLabels: false,
            flowchart: { htmlLabels: false },
            fontFamily: 'Arial, sans-serif',
            suppressErrorRendering: true,
          });
        });
        page.on('crash', () => void this.reset());
        context.on('close', () => void this.reset());
        return { page, close: () => context.close().catch(() => undefined) };
      } catch (err) {
        await context.close().catch(() => undefined);
        throw err;
      }
    })();
    const current = this.session;
    current.catch(() => {
      if (this.session === current) this.session = null;
    });
    return current;
  }

  private async reset(): Promise<void> {
    const current = this.session;
    this.session = null;
    const session = await current?.catch(() => null);
    await session?.close();
  }

  async close(): Promise<void> {
    await this.reset();
  }
}

/** The slice of the page's DOM used to clean up (the server has no DOM typings). */
interface PageDocument {
  getElementById(id: string): { remove(): void } | null;
}

/** The slice of the Mermaid API used inside the page. */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  parse(source: string): Promise<unknown>;
  render(id: string, source: string): Promise<{ svg: string }>;
}
