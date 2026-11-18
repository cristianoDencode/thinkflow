import { isReplayableStep, type TestViewport } from '@thinkflow/shared';
import type {
  RecorderBrowser,
  RecorderListener,
  RecordingHandle,
  RunStepOutcome,
  Screenshot,
  ScreenSnapshot,
  TestRunInput,
  TestRunner,
} from '../../src/contexts/testing/domain/ports';
import type {
  ElementFacts,
  RecorderEvent,
} from '../../src/contexts/testing/domain/recorder-events';
import type { CapturedDownload, DownloadFile } from '../../src/contexts/testing/domain/download';
import type { ScreenSettler } from '../../src/contexts/testing/domain/settle';

/** Settles at once: the suite never waits for a screen to settle. */
export const instantSettler: ScreenSettler = { settle: async () => 'settled' };

/** 1x1 PNG. */
export const TINY_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** A download as the browser adapter reports it. */
export function fakeDownload(
  over: {
    fileName?: string;
    at?: number;
    url?: string;
    bytes?: Uint8Array;
    file?: DownloadFile;
  } = {},
): CapturedDownload {
  const bytes = over.bytes ?? new TextEncoder().encode('a;b\n1;2\n');
  return {
    at: over.at ?? 0,
    url: over.url ?? 'https://a.b/exportar',
    fileName: over.fileName ?? 'relatorio.csv',
    file: Promise.resolve(over.file ?? { status: 'ready', size: bytes.byteLength, bytes }),
  };
}

export function fieldFacts(label: string, over: Partial<ElementFacts> = {}): ElementFacts {
  const id = label.toLowerCase().replace(/[^a-z]/g, '');
  return {
    tag: 'input',
    inputType: 'text',
    role: 'textbox',
    name: label,
    label,
    fieldName: id,
    candidates: [
      { locator: { kind: 'role', role: 'textbox', name: label }, count: 1 },
      { locator: { kind: 'css', selector: `#${id}` }, count: 1 },
    ],
    secret: false,
    bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.05 },
    frameUrl: null,
    ...over,
  };
}

export function buttonFacts(name: string): ElementFacts {
  return {
    tag: 'button',
    inputType: null,
    role: 'button',
    name,
    label: name,
    fieldName: null,
    candidates: [{ locator: { kind: 'role', role: 'button', name }, count: 1 }],
    secret: false,
    bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.05 },
    frameUrl: null,
  };
}

/** In-memory "browser": tests push events as if the user acted in the window. */
export class FakeRecorderBrowser implements RecorderBrowser {
  listener: RecorderListener | null = null;
  started: { url: string; viewport: TestViewport }[] = [];
  screenshots: { maskCss: string[] }[] = [];
  states: unknown[] = [];
  failNextStart: string | null = null;
  page = { url: 'https://a.b/painel?aba=1', title: 'Painel' };
  closed = 0;
  /** Inner size of the (maximized) window, as the real browser reports it. */
  windowSize: TestViewport | null = null;
  /** What "Protótipo" reads from the page (null = the page is gone). */
  screen: ScreenSnapshot | null = {
    html: '<body><h1>Consulta</h1></body>',
    css: 'h1{color:#123}',
    width: 1200,
    height: 700,
    url: 'https://a.b/w/1/emp1_empconsulta001.php?x=1',
    title: 'Consulta Empenho',
  };
  prototypeCaptures = 0;

  async start(
    options: { url: string; viewport: TestViewport },
    listener: RecorderListener,
  ): Promise<RecordingHandle> {
    if (this.failNextStart) {
      const message = this.failNextStart;
      this.failNextStart = null;
      throw new Error(message);
    }
    this.started.push(options);
    this.listener = listener;
    return {
      viewport: this.windowSize,
      screenshot: async (_pageId, opts): Promise<Screenshot> => {
        this.screenshots.push(opts);
        return {
          bytes: TINY_PNG,
          width: 1366,
          height: 768,
          page: { url: options.url, title: 'Entrar' },
        };
      },
      settleReading: async () => ({
        loaded: true,
        pendingRequests: 0,
        networkQuietMs: 1e9,
        domQuietMs: 1e9,
      }),
      capturePrototype: async () => {
        this.prototypeCaptures += 1;
        return this.screen;
      },
      currentPage: async () => this.page,
      setState: async (state) => {
        this.states.push(state);
      },
      close: async () => {
        this.closed += 1;
        this.listener?.onClosed();
        this.listener = null;
      },
    };
  }

  /** The user acted in the page. */
  emit(
    event: RecorderEvent,
    page = { url: 'https://a.b/login', title: 'Entrar' },
    pageId = 'page-1',
  ): void {
    this.listener?.onEvent(event, page, pageId);
  }

  /** A page of the browser started a download. */
  download(download: CapturedDownload, pageId = 'page-1'): void {
    this.listener?.onDownload(download, pageId);
  }

  /** Toolbar "Verificar" in the browser. */
  requestCheckpoint(): void {
    this.listener?.onCheckpointRequest('page-1');
  }

  /** "Capturar" / Ctrl+Shift+S in the browser. */
  requestCapture(): void {
    this.listener?.onCaptureRequest('page-1');
  }

  /** Toolbar "Protótipo" in the browser. */
  requestPrototype(): void {
    this.listener?.onPrototypeRequest('page-1');
  }

  /** The user closed the window. */
  userClosed(): void {
    const listener = this.listener;
    this.listener = null;
    listener?.onClosed();
  }
}

/** Runner that plays the steps without a browser; `failAt` makes a step fail. */
export class FakeRunner implements TestRunner {
  inputs: TestRunInput[] = [];
  failAt: string | null = null;
  /** Holds every step until released (cancel tests). */
  gate: Promise<void> | null = null;
  failToStart: string | null = null;
  /** step id → downloads the step starts while it runs. */
  downloads: Record<string, CapturedDownload[]> = {};

  async run(
    input: TestRunInput,
    onStep: (stepId: string, outcome: RunStepOutcome) => Promise<void>,
  ): Promise<void> {
    if (this.failToStart) throw new Error(this.failToStart);
    this.inputs.push(input);
    let failed = false;
    for (const step of input.definition.steps) {
      if (this.gate) await this.gate;
      const skip = failed || input.signal.aborted || !isReplayableStep(step);
      const fail = !skip && step.id === this.failAt;
      if (fail) failed = true;
      if (!skip) for (const d of this.downloads[step.id] ?? []) input.onDownload(d, step.id);
      await onStep(step.id, {
        status: skip ? 'skipped' : fail ? 'failed' : 'passed',
        durationMs: 1,
        error: fail ? 'Elemento não encontrado: botão "Entrar"' : null,
        locatorUsed: skip || fail || step.kind === 'checkpoint' ? null : 0,
        // a failed step and a checkpoint keep a screenshot, like the real runner
        screenshot: fail || (!skip && step.kind === 'checkpoint') ? TINY_PNG : null,
      });
    }
  }
}
