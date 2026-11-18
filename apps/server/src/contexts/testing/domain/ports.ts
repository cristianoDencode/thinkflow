import type {
  PrototypeCaptureResultDto,
  RecordingMode,
  TestDefinition,
  TestViewport,
} from '@thinkflow/shared';
import type { ObjectStream } from '../../../shared/kernel/object-store';
import type { CapturedDownload, DownloadFilter, TestDownload } from './download';
import type { EventPage, RecorderEvent } from './recorder-events';
import type { SettleReading } from './settle';
import type { TestEvidence, TestRun, TestSession } from './session';

export interface TestSessionRepository {
  list(): Promise<TestSession[]>;
  find(id: string): Promise<TestSession | null>;
  save(session: TestSession): Promise<void>;
  /** Only `updated_at` (safe while the recorder saves steps). */
  touch(id: string, at: number): Promise<void>;
  /** Cascades to the step images and runs. */
  delete(id: string): Promise<void>;
  count(): Promise<number>;

  evidences(sessionId: string): Promise<TestEvidence[]>;
  findEvidence(id: string): Promise<TestEvidence | null>;
  saveEvidence(evidence: TestEvidence): Promise<void>;
  deleteEvidence(id: string): Promise<void>;
  /** sessionId → steps with a print, for the list. */
  evidenceCounts(): Promise<Map<string, number>>;

  runs(sessionId: string, limit: number): Promise<TestRun[]>;
  findRun(id: string): Promise<TestRun | null>;
  saveRun(run: TestRun): Promise<void>;
  runsWithStatus(status: TestRun['status']): Promise<TestRun[]>;
  /** The `seq` the next run of the session takes. */
  nextRunSeq(sessionId: string): Promise<number>;
  /** run id → `seq`, for every run of the session. */
  runNumbers(sessionId: string): Promise<Map<string, number>>;
  /** sessionId → latest run, for the list. */
  lastRuns(): Promise<Map<string, TestRun>>;

  /** Newest first. */
  downloads(sessionId: string, filter?: DownloadFilter): Promise<TestDownload[]>;
  findDownload(id: string): Promise<TestDownload | null>;
  saveDownload(download: TestDownload): Promise<void>;
  deleteDownload(id: string): Promise<void>;
  countDownloads(sessionId: string): Promise<number>;
}

/** Images and downloaded files of the sessions (`tests/` namespace of the ObjectStore). */
export interface TestImageStore {
  /** `maxBytes` overrides the store-wide object limit for this write. */
  put(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    options?: { maxBytes?: number },
  ): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** The caller must consume the body or call `abort()`. Null when the key does not exist. */
  stream(key: string): Promise<ObjectStream | null>;
  delete(key: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** Throws `ObjectStoreUnavailableError` while the storage is known to be down. */
  assertWritable(): Promise<void>;
}

/** Whether this server can open a browser window (host with a screen, not a container). */
export interface DisplaySupport {
  canOpenWindow(): boolean;
}

/** Opaque id of a page (tab/popup) of the recorded browser. */
export type RecordedPageId = string;

export interface RecorderListener {
  onEvent(event: RecorderEvent, page: EventPage, pageId: RecordedPageId): void;
  /** Toolbar "Capturar" / Ctrl+Shift+S inside the recorded browser (mode "Só prints"). */
  onCaptureRequest(pageId: RecordedPageId): void;
  /**
   * A page (tab or popup) started a download. Never blocks the recording: `download.file` settles
   * when the browser finished it.
   */
  onDownload(download: CapturedDownload, pageId: RecordedPageId): void;
  /** Pause toggled from the toolbar. */
  onPauseToggle(paused: boolean): void;
  /** Toolbar "Verificar": a full-window checkpoint of the page the user is on. */
  onCheckpointRequest(pageId: RecordedPageId): void;
  /** Toolbar "Protótipo" (mode "Só prints" only): the screen the user is on becomes a prototype. */
  onPrototypeRequest(pageId: RecordedPageId): void;
  /** The user closed the window (or the browser crashed). */
  onClosed(): void;
}

export interface Screenshot {
  bytes: Uint8Array;
  width: number;
  height: number;
  page: EventPage;
}

/** A screen as serialized in the recorded browser (see `prototype-script.ts`). */
export interface ScreenSnapshot {
  /** `<body>…</body>` with the form state as attributes. */
  html: string;
  css: string;
  /** Viewport of the captured frame. */
  width: number;
  height: number;
  /** Address of the captured frame (with query). */
  url: string;
  title: string;
  /** Frames inlined in the HTML (`div[data-tf-frame]`) and frames left as empty boxes. */
  flattenedFrames?: number;
  blankFrames?: number;
}

/** Where a captured screen goes (the prototypes context); keeps `testing` free of its internals. */
export interface PrototypeSink {
  capture(input: {
    sessionId: string;
    stepId: string | null;
    menuPath: string | null;
    keepData: boolean;
    screen: ScreenSnapshot;
  }): Promise<PrototypeCaptureResultDto>;
}

export interface RecordingHandle {
  /** Inner size of the browser window when it opened (maximized windows: the monitor's). */
  readonly viewport?: TestViewport | null;
  /**
   * PNG of the page at its real window size. `pageId` null = the page the user is on now. Null
   * result when the page is gone.
   */
  screenshot(
    pageId: RecordedPageId | null,
    options: { maskCss: string[] },
  ): Promise<Screenshot | null>;
  /**
   * The screen the user is on, as standalone HTML/CSS: the e-Cidade window they work in (the
   * wrapper frame of its routine, title bar included; the window in front when they last used the
   * desktop itself), else the innermost visible routine frame they last interacted with, else the
   * main page. Same-origin nested frames are flattened into `div[data-tf-frame]`. Not sanitized
   * nor scrubbed. Null when the page is gone.
   */
  capturePrototype(pageId: RecordedPageId | null): Promise<ScreenSnapshot | null>;
  /** What the page is doing now (loading, requests, DOM changes); null when it is gone. */
  settleReading(pageId: RecordedPageId | null): Promise<SettleReading | null>;
  /** URL and title of the page the user is on now (null when every page is closed). */
  currentPage(): Promise<EventPage | null>;
  /** Pushes the state to the toolbar of every page. */
  setState(state: { paused?: boolean; mode?: RecordingMode }): Promise<void>;
  close(): Promise<void>;
}

/** Opens a visible browser and reports what the user does in it. */
export interface RecorderBrowser {
  start(
    options: { url: string; viewport: TestViewport; maxDownloadBytes?: number },
    listener: RecorderListener,
  ): Promise<RecordingHandle>;
}

export interface RunStepOutcome {
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  /** pt-BR, for people. */
  error: string | null;
  /** Index of the locator that found the element. */
  locatorUsed: number | null;
  /** PNG of the page when the step failed. */
  screenshot: Uint8Array | null;
}

export interface TestRunInput {
  definition: TestDefinition;
  /** parameter id → value of the data set being run. */
  values: Record<string, string>;
  headed: boolean;
  maskCss: string[];
  signal: AbortSignal;
  /** Bigger downloads are reported as skipped (never read into memory). */
  maxDownloadBytes: number;
  /** A download started; `stepId` is the step being executed (null before the first one). */
  onDownload: (download: CapturedDownload, stepId: string | null) => void;
}

/** Replays a recorded session in a browser. Throws only when the browser cannot start. */
export interface TestRunner {
  run(
    input: TestRunInput,
    onStep: (stepId: string, outcome: RunStepOutcome) => Promise<void>,
  ): Promise<void>;
}
