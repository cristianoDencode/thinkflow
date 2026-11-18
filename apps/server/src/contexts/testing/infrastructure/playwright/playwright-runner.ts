import { chromium, type Browser, type Frame, type Locator, type Page } from 'playwright-core';
import {
  isReplayableStep,
  type TestLocator,
  type TestStep,
  type TestTarget,
} from '@thinkflow/shared';
import { valueOf } from '../../domain/data';
import { frameMatchTier, rankFrameUrls } from '../../domain/frame-match';
import { isEmptySpaceTarget } from '../../domain/locators';
import type { RunStepOutcome, TestRunInput, TestRunner } from '../../domain/ports';
import { DownloadWatcher } from './download-capture';
import { launchErrorMessage } from './playwright-recorder';

export interface PlaywrightRunnerOptions {
  executablePath?: () => string;
  /** Per step (default 10 s). */
  stepTimeoutMs?: number;
  /** Navigation of a `goto` (default 45 s). */
  navigationTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The public Playwright locator for one recorded candidate (exact matching, like when recorded). */
export function buildLocator(scope: Page | Frame, l: TestLocator): Locator {
  switch (l.kind) {
    case 'testid':
      return scope.getByTestId(l.value);
    case 'role':
      return scope.getByRole(l.role as Parameters<Page['getByRole']>[0], {
        name: l.name,
        exact: true,
      });
    case 'label':
      return scope.getByLabel(l.text, { exact: true });
    case 'placeholder':
      return scope.getByPlaceholder(l.text, { exact: true });
    case 'alt':
      return scope.getByAltText(l.text, { exact: true });
    case 'title':
      return scope.getByTitle(l.text, { exact: true });
    case 'text':
      return scope.getByText(l.text, { exact: true });
    case 'css':
      return scope.locator(l.selector);
  }
}

class StepFailure extends Error {}

/** How long frames unrelated to the recorded one are ignored while looking for an element. */
const UNRELATED_FRAME_GRACE_MS = 1500;

/** After the last step: time for a tab it opened to start the download it was opened for. */
const TAIL_GRACE_MS = 400;

async function poll(
  deadline: number,
  signal: AbortSignal,
  check: () => Promise<boolean>,
): Promise<boolean> {
  for (;;) {
    if (signal.aborted) throw new StepFailure('Execução cancelada');
    if (await check().catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

class Run {
  private page: Page;
  /** The step being executed (the one a download is credited to). */
  currentStepId: string | null = null;
  /** The step that was running when a tab or popup opened: its downloads belong to it. */
  private readonly openedBy = new WeakMap<Page, string | null>();
  /** URL of a request → the step running when it was made (a download's own request). */
  private readonly requestSteps = new Map<string, string | null>();

  constructor(
    page: Page,
    private readonly input: TestRunInput,
    private readonly timeoutMs: number,
    private readonly navigationTimeoutMs: number,
    private readonly downloads: DownloadWatcher,
  ) {
    this.page = page;
    const watch = (p: Page) =>
      this.downloads.attach(p, (capture, download) => {
        // a download may be reported after the step that caused it ended: its request tells which
        const step = this.openedBy.has(p)
          ? this.openedBy.get(p)!
          : (this.requestSteps.get(download.url()) ?? this.currentStepId);
        input.onDownload(capture, step);
      });
    watch(page);
    page.context().on('request', (r) => {
      this.requestSteps.delete(r.url());
      this.requestSteps.set(r.url(), this.currentStepId);
      if (this.requestSteps.size > 500) {
        this.requestSteps.delete(this.requestSteps.keys().next().value!);
      }
    });
    // a click that opens a tab/popup: the steps that follow happen there
    page.context().on('page', (p) => {
      this.page = p;
      this.openedBy.set(p, this.currentStepId);
      watch(p);
      // a tab that closes itself (it only existed to download): back to the page it came from
      p.on('close', () => {
        if (this.page === p && !page.isClosed()) this.page = page;
      });
    });
  }

  /**
   * Where to look for the element, best first. Without a recorded frame: the page. With one: the
   * frames whose URL is the same, then the same ignoring the query, then the same ignoring numbered
   * window segments, and finally every other frame (the page's own document first).
   */
  private scopes(target: TestTarget): { scope: Page | Frame; related: boolean }[] {
    if (!target.frameUrl) return [{ scope: this.page, related: true }];
    const frames = this.page.frames(); // the page's own document comes first
    const recorded = target.frameUrl;
    return rankFrameUrls(
      recorded,
      frames.map((f) => f.url()),
    ).map((i) => ({
      scope: frames[i]!,
      related: frameMatchTier(recorded, frames[i]!.url()) !== null,
    }));
  }

  /** The first recorded locator that finds exactly one element (they are tried best first). */
  private async resolve(target: TestTarget): Promise<{ locator: Locator; index: number }> {
    const started = Date.now();
    const deadline = started + this.timeoutMs;
    if (target.frameUrl) {
      // frames still loading must not lose to the first unrelated frame that happens to match
      await this.page
        .waitForLoadState('load', { timeout: Math.min(this.timeoutMs, 5000) })
        .catch(() => undefined);
    }
    // unrelated frames are only a last resort: the related one may be about to appear
    const fallbackAt = started + Math.min(UNRELATED_FRAME_GRACE_MS, this.timeoutMs / 2);
    let found: { locator: Locator; index: number } | null = null;
    const ok = await poll(deadline, this.input.signal, async () => {
      for (const { scope, related } of this.scopes(target)) {
        if (!related && Date.now() < fallbackAt) continue;
        for (const [index, l] of target.locators.entries()) {
          const locator = buildLocator(scope, l);
          // a frame that navigates or detaches meanwhile just has no match this round
          const count = await locator.count().catch(() => 0);
          if (count === 1) {
            found = { locator, index };
            return true;
          }
        }
      }
      return false;
    });
    if (!ok || !found) throw new StepFailure(`Elemento não encontrado: ${target.description}`);
    return found;
  }

  async step(step: TestStep): Promise<number | null> {
    return this.perform(step);
  }

  /**
   * After the last step: a click that opens a tab starts that tab's download a moment later, and
   * the browser must not close before the tab had the chance to.
   */
  async settleTail(): Promise<void> {
    await sleep(TAIL_GRACE_MS);
    await Promise.all(
      this.page
        .context()
        .pages()
        .map((p) => p.waitForLoadState('load', { timeout: 5000 }).catch(() => undefined)),
    );
    await sleep(TAIL_GRACE_MS);
  }

  private async perform(step: TestStep): Promise<number | null> {
    const t = this.timeoutMs;
    const values = this.input.values;
    switch (step.kind) {
      case 'note':
      case 'capture':
      case 'usecase':
        return null;
      case 'goto':
        await this.page.goto(step.url!, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
        });
        return null;
      case 'assert':
        return this.check(step);
      case 'checkpoint':
        // nothing to interact with: let the page settle, the print is taken by the caller
        await this.page.waitForLoadState('load', { timeout: t }).catch(() => undefined);
        return null;
      default:
        break;
    }
    const press = step.kind === 'press' && !step.target;
    if (press) {
      await this.page.keyboard.press(step.key!);
      return null;
    }
    // old recordings: a click on the page background (html/body) is not an action to replay
    if ((step.kind === 'click' || step.kind === 'dblclick') && isEmptySpaceTarget(step.target!)) {
      return null;
    }
    const { locator, index } = await this.resolve(step.target!);
    switch (step.kind) {
      case 'click':
        await locator.click({ timeout: t });
        break;
      case 'dblclick':
        await locator.dblclick({ timeout: t });
        break;
      case 'fill':
        await locator.fill(valueOf(step.value!, values), { timeout: t });
        break;
      case 'select': {
        const value = valueOf(step.value!, values);
        await locator.selectOption({ label: value }, { timeout: t }).catch(async () => {
          await locator.selectOption(value, { timeout: t });
        });
        break;
      }
      case 'check':
        await locator.check({ timeout: t });
        break;
      case 'uncheck':
        await locator.uncheck({ timeout: t });
        break;
      case 'press':
        await locator.press(step.key!, { timeout: t });
        break;
    }
    // let the navigation a click/Enter started settle before the next step
    await this.page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => undefined);
    return index;
  }

  private async check(step: TestStep): Promise<number | null> {
    const a = step.assertion!;
    const deadline = Date.now() + this.timeoutMs;
    const signal = this.input.signal;
    switch (a.type) {
      case 'textVisible': {
        const ok = await poll(deadline, signal, () =>
          this.page.getByText(a.text, { exact: false }).first().isVisible(),
        );
        if (!ok) throw new StepFailure(`Texto não encontrado na página: "${a.text}"`);
        return null;
      }
      case 'urlContains': {
        const ok = await poll(deadline, signal, async () => this.page.url().includes(a.text));
        if (!ok) throw new StepFailure(`A URL "${this.page.url()}" não contém "${a.text}"`);
        return null;
      }
      case 'title': {
        let title = '';
        const ok = await poll(deadline, signal, async () => {
          title = await this.page.title();
          return title.includes(a.text);
        });
        if (!ok) throw new StepFailure(`Título da página "${title}" não contém "${a.text}"`);
        return null;
      }
      case 'visible': {
        const { locator, index } = await this.resolve(step.target!);
        const ok = await poll(deadline, signal, () => locator.isVisible());
        if (!ok) throw new StepFailure(`Elemento não está visível: ${step.target!.description}`);
        return index;
      }
      case 'value': {
        const expected = valueOf(a.value, this.input.values);
        const { locator, index } = await this.resolve(step.target!);
        let actual = '';
        const ok = await poll(deadline, signal, async () => {
          actual = await locator.evaluate((el) => {
            const e = el as unknown as {
              tagName: string;
              value: string;
              selectedOptions?: { label: string }[];
            };
            if (e.tagName === 'SELECT') return e.selectedOptions?.[0]?.label ?? e.value;
            return e.value ?? '';
          });
          return actual.trim() === expected.trim();
        });
        if (!ok) {
          throw new StepFailure(
            `Valor de ${step.target!.description} é "${actual}", esperado "${expected}"`,
          );
        }
        return index;
      }
    }
  }

  async screenshot(): Promise<Uint8Array | null> {
    try {
      const png = await this.page.screenshot({
        type: 'png',
        mask: this.input.maskCss.map((css) => this.page.locator(css)),
        maskColor: '#1f2937',
        animations: 'disabled',
        timeout: 10_000,
      });
      return new Uint8Array(png);
    } catch {
      return null;
    }
  }
}

/** pt-BR for the usual Playwright failures (timeouts, detached elements…). */
function friendly(err: unknown): string {
  if (err instanceof StepFailure) return err.message;
  const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
  if (/Timeout .*exceeded/i.test(message))
    return 'Tempo esgotado esperando a página ou o elemento.';
  if (/net::ERR_/i.test(message))
    return `Falha ao abrir a página (${message.match(/net::ERR_[A-Z_]+/)?.[0]}).`;
  return message.slice(0, 500);
}

export class PlaywrightRunner implements TestRunner {
  constructor(private readonly options: PlaywrightRunnerOptions = {}) {}

  async run(
    input: TestRunInput,
    onStep: (stepId: string, outcome: RunStepOutcome) => Promise<void>,
  ): Promise<void> {
    const configured = (this.options.executablePath?.() ?? '').trim();
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: !input.headed,
        ...(input.headed ? { args: ['--start-maximized'] } : {}),
        ...(configured ? { executablePath: configured } : {}),
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
    let downloads: DownloadWatcher | undefined;
    const abort = () => void browser.close().catch(() => undefined);
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      // headed: the window opens maximized and the user may resize it; headless keeps the recorded size
      const context = await browser.newContext(
        input.headed
          ? { viewport: null, locale: 'pt-BR', acceptDownloads: true }
          : {
              viewport: input.definition.viewport,
              deviceScaleFactor: 1,
              locale: 'pt-BR',
              acceptDownloads: true,
            },
      );
      downloads = new DownloadWatcher(input.maxDownloadBytes);
      const run = new Run(
        await context.newPage(),
        input,
        this.options.stepTimeoutMs ?? 10_000,
        this.options.navigationTimeoutMs ?? 45_000,
        downloads,
      );
      let failed = false;
      for (const step of input.definition.steps) {
        if (failed || input.signal.aborted || !isReplayableStep(step)) {
          await onStep(step.id, {
            status: 'skipped',
            durationMs: 0,
            error: null,
            locatorUsed: null,
            screenshot: null,
          });
          continue;
        }
        const started = Date.now();
        run.currentStepId = step.id;
        try {
          const locatorUsed = await run.step(step);
          await onStep(step.id, {
            status: 'passed',
            durationMs: Date.now() - started,
            error: null,
            locatorUsed,
            // "Verificar": the replay report shows the screen at that moment
            screenshot: step.kind === 'checkpoint' ? await run.screenshot() : null,
          });
        } catch (err) {
          failed = true;
          await onStep(step.id, {
            status: 'failed',
            durationMs: Date.now() - started,
            error: input.signal.aborted ? 'Execução cancelada' : friendly(err),
            locatorUsed: null,
            screenshot: input.signal.aborted ? null : await run.screenshot(),
          });
        }
      }
      if (!failed && !input.signal.aborted) await run.settleTail();
    } finally {
      input.signal.removeEventListener('abort', abort);
      // closing the browser deletes the temporary files: let the downloads finish first
      if (!input.signal.aborted) await downloads?.drain();
      await browser.close().catch(() => undefined);
    }
  }
}
