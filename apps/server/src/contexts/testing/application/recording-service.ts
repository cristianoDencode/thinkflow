import {
  isStructuralStep,
  SESSION_MODE_LABELS,
  sessionMode,
  stepSchema,
  TEST_LIMITS,
  type PrototypeCaptureResultDto,
  type RecordingMode,
  type TestDefinition,
  type TestSessionMode,
  type TestSessionState,
  type TestStep,
  type TestStepKind,
  type TestViewport,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { DomainError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import { NotFoundError } from '../../../shared/kernel/errors';
import { ObjectStoreUnavailableError } from '../../../shared/kernel/object-store';
import {
  DOWNLOAD_DRAIN_MS,
  linkCandidates,
  type CapturedDownload,
  type StepMark,
} from '../domain/download';
import type {
  DisplaySupport,
  RecordedPageId,
  RecorderBrowser,
  PrototypeSink,
  RecordingHandle,
  TestImageStore,
  TestSessionRepository,
} from '../domain/ports';
import { currentStepOf, menuPathBefore } from '../domain/prototype-capture';
import type { EventPage, RecorderEvent } from '../domain/recorder-events';
import type { TestEvidence } from '../domain/session';
import {
  AUTO_SETTLE_MAX_MS,
  createScreenSettler,
  MANUAL_SETTLE_MAX_MS,
  type ScreenSettler,
} from '../domain/settle';
import {
  applyPageAssertion,
  applyRecorderEvent,
  type ApplyResult,
  type RecordingState,
} from '../domain/step-builder';
import type { DownloadService } from './download-service';
import { saveStepImage } from './step-images';
import { withTimeout } from './with-timeout';
import { RECORDING_UNSUPPORTED_MESSAGE } from './test-session-service';

/** Always masked in screenshots, on top of the fields recorded as secret. */
export const DEFAULT_MASK_CSS = [
  'input[type=password]',
  '[autocomplete=cc-number]',
  '[autocomplete=cc-csc]',
  '[autocomplete=one-time-code]',
];

/** CSS of the elements whose values are secret parameters (masked in every screenshot). */
export function secretMaskCss(def: TestDefinition): string[] {
  const secretIds = new Set(def.parameters.filter((p) => p.secret).map((p) => p.id));
  const css = new Set(DEFAULT_MASK_CSS);
  for (const step of def.steps) {
    if (!step.target || !step.value || !('param' in step.value)) continue;
    if (!secretIds.has(step.value.param)) continue;
    for (const l of step.target.locators) if (l.kind === 'css') css.add(l.selector);
  }
  return [...css];
}

const STORAGE_WARNING =
  'Armazenamento de documentos indisponível: os prints não estão sendo salvos (os passos continuam sendo gravados).';

/** Recorded steps remembered to link the downloads that follow them. */
const MAX_STEP_MARKS = 50;

interface ActiveRecording {
  sessionId: string;
  handle: RecordingHandle | null;
  /** Fixed for the whole recording (and, once there are steps, for the whole session). */
  mode: TestSessionMode;
  paused: boolean;
  warning: string | null;
  /** A step saved before the window existed (the initial goto): its print comes later. */
  pendingPrint: string | null;
  /** Events are applied one at a time, in the order they happened. */
  chain: Promise<void>;
  /** Counts what the user did in the browser (recorded or not): a print never outlives it. */
  actions: number;
  /** The wait for the screen to settle that is running now (aborted by the next action). */
  settling: AbortController | null;
  /** The steps recorded lately (id once saved, null if the event became no step), per page. */
  marks: StepMark<Promise<string | null>>[];
}

export interface RecordingServiceDeps {
  repo: TestSessionRepository;
  images: TestImageStore;
  downloads: DownloadService;
  /** Receives the screens captured with "Protótipo" (the prototypes context). */
  prototypes?: PrototypeSink;
  browser: RecorderBrowser;
  display: DisplaySupport;
  clock: Clock;
  ids: IdGenerator;
  /** Another job (a replay) is using the session. */
  isBusy?: (sessionId: string) => boolean;
  /** An event was applied (tests wait on it). */
  onApplied?: (sessionId: string) => void;
  /** Waits for the screen to settle before a print (real clock by default; tests inject one). */
  settler?: ScreenSettler;
  onError?: (err: unknown) => void;
}

const modeLabel = (mode: TestSessionMode) => `"${SESSION_MODE_LABELS[mode]}"`;

/**
 * One recorded browser at a time. Two fixed modes, chosen when the session is first recorded:
 * `record` turns what the user does into steps, each with an automatic print taken once the screen
 * settled; `capture` ignores what the user does and turns each manual print into a `capture` step.
 */
export class RecordingService {
  private active: ActiveRecording | null = null;
  private readonly settler: ScreenSettler;
  /** Downloads being linked and stored (they outlive the recording by a moment). */
  private readonly downloadTasks = new Set<Promise<void>>();

  constructor(private readonly deps: RecordingServiceDeps) {
    this.settler = deps.settler ?? createScreenSettler();
  }

  state(sessionId: string): TestSessionState {
    if (this.active?.sessionId !== sessionId) return 'idle';
    return this.active.paused ? 'paused' : 'recording';
  }

  mode(sessionId: string): RecordingMode | null {
    if (this.active?.sessionId !== sessionId) return null;
    return this.active.mode;
  }

  warning(sessionId: string): string | null {
    return this.active?.sessionId === sessionId ? this.active.warning : null;
  }

  isRecording(sessionId?: string): boolean {
    return this.active !== null && (sessionId === undefined || this.active.sessionId === sessionId);
  }

  handle(sessionId: string): RecordingHandle | null {
    return this.active?.sessionId === sessionId ? this.active.handle : null;
  }

  /** Resolves when the events received so far are applied (and their prints saved). */
  async whenIdle(): Promise<void> {
    let chain: Promise<void> | undefined;
    do {
      chain = this.active?.chain;
      await chain;
      await Promise.allSettled([...this.downloadTasks]);
    } while (chain !== this.active?.chain && this.active);
  }

  /**
   * Opens the browser. A session that already has steps continues in its own mode (asking for the
   * other one is refused); an empty one takes `options.mode` (default: record) and keeps it.
   */
  async start(sessionId: string, options: { mode?: TestSessionMode } = {}): Promise<void> {
    if (!this.deps.display.canOpenWindow()) {
      throw new DomainError(RECORDING_UNSUPPORTED_MESSAGE, 'recording_unsupported', 400);
    }
    const session = await this.deps.repo.find(sessionId);
    if (!session) throw new DomainError('Sessão de teste não encontrada', 'not_found', 404);
    if (this.active) {
      if (this.active.sessionId === sessionId) return; // already recording
      throw new DomainError(
        'Já existe uma gravação em andamento. Pare-a antes de iniciar outra.',
        'recording_busy',
        409,
      );
    }
    if (this.deps.isBusy?.(sessionId)) {
      throw new DomainError('Aguarde a execução terminar para gravar.', 'test_session_busy', 409);
    }
    const mode = this.resolveMode(session.definition, options.mode);

    const recording: ActiveRecording = {
      sessionId,
      handle: null,
      mode,
      paused: false,
      warning: null,
      pendingPrint: null,
      chain: Promise.resolve(),
      actions: 0,
      settling: null,
      marks: [],
    };
    this.active = recording;
    try {
      if (session.definition.mode !== mode) {
        await this.deps.repo.save({
          ...session,
          definition: { ...session.definition, mode },
          updatedAt: this.deps.clock.now(),
        });
      }
    } catch (err) {
      if (this.active === recording) this.active = null;
      throw err;
    }
    if (mode === 'record') {
      // a fresh browser starts at the initial URL: that is the first step of this stretch
      this.enqueue(
        recording,
        { type: 'navigate', url: session.startUrl, at: this.deps.clock.now() },
        null,
        null,
      );
    }
    try {
      recording.handle = await this.deps.browser.start(
        {
          url: session.startUrl,
          viewport: session.definition.viewport,
          maxDownloadBytes: TEST_LIMITS.maxDownloadBytes,
        },
        {
          onEvent: (event, page, pageId) => this.enqueue(recording, event, page, pageId),
          onDownload: (download, pageId) => this.trackDownload(recording, download, pageId),
          onCaptureRequest: (pageId) => {
            if (this.active !== recording || recording.mode !== 'capture') return;
            void this.capture(sessionId, pageId).catch((err: unknown) => {
              recording.warning =
                err instanceof DomainError ? err.message : 'Não foi possível capturar a tela.';
              this.deps.onError?.(err);
            });
          },
          onPauseToggle: (paused) => {
            if (this.active === recording && recording.mode === 'record') recording.paused = paused;
          },
          onCheckpointRequest: (pageId) => {
            if (this.active !== recording || recording.mode !== 'record') return;
            void this.checkpoint(sessionId, pageId).catch((err: unknown) => {
              recording.warning =
                err instanceof DomainError ? err.message : 'Não foi possível verificar a tela.';
              this.deps.onError?.(err);
            });
          },
          onPrototypeRequest: (pageId) => {
            if (this.active !== recording || recording.mode !== 'capture') return;
            void this.capturePrototype(sessionId, pageId).catch((err: unknown) => {
              recording.warning =
                err instanceof DomainError ? err.message : 'Não foi possível capturar o protótipo.';
              this.deps.onError?.(err);
            });
          },
          onClosed: () => {
            if (this.active === recording) this.active = null;
          },
        },
      );
      if (mode === 'capture') await recording.handle.setState({ mode: 'capture' });
      // headless replays use something close to the window the test was recorded in
      const size = recording.handle.viewport;
      if (size) recording.chain = recording.chain.then(() => this.storeViewport(recording, size));
      // the first page is loaded now: its print documents where the test starts
      recording.chain = recording.chain
        .then(async () => {
          const stepId = recording.pendingPrint;
          recording.pendingPrint = null;
          if (stepId && this.active === recording) {
            await this.print(recording, stepId, null, recording.actions);
          }
        })
        .catch((err: unknown) => this.deps.onError?.(err));
    } catch (err) {
      if (this.active === recording) this.active = null;
      await recording.chain;
      throw new DomainError(
        err instanceof Error ? err.message : 'Não foi possível abrir o navegador.',
        'recorder_unavailable',
        503,
      );
    }
  }

  private resolveMode(def: TestDefinition, requested: TestSessionMode | undefined) {
    // steps (notes aside) lock the mode: the session is one kind of document from then on
    const locked = def.steps.some((s) => !isStructuralStep(s));
    if (!locked) return requested ?? def.mode ?? 'record';
    const current = sessionMode(def)!;
    if (requested && requested !== current) {
      throw new DomainError(
        `Esta sessão foi gravada no modo ${modeLabel(current)} e não pode mudar para ${modeLabel(requested)}. Crie outra sessão para usar o outro modo.`,
        'mode_locked',
        409,
      );
    }
    return current;
  }

  /** The window may open at the monitor's size: keep it as the test's viewport. */
  private async storeViewport(recording: ActiveRecording, size: TestViewport): Promise<void> {
    const session = await this.deps.repo.find(recording.sessionId);
    if (!session) return;
    const viewport = {
      width: Math.min(3840, Math.max(320, Math.round(size.width))),
      height: Math.min(2160, Math.max(240, Math.round(size.height))),
    };
    const current = session.definition.viewport;
    if (current.width === viewport.width && current.height === viewport.height) return;
    await this.deps.repo.save({ ...session, definition: { ...session.definition, viewport } });
  }

  async stop(sessionId: string): Promise<void> {
    const recording = this.active;
    if (!recording || recording.sessionId !== sessionId) return;
    this.active = null;
    recording.settling?.abort();
    await recording.handle?.close(); // waits (bounded) for the files still being downloaded
    await withTimeout(Promise.allSettled([...this.downloadTasks]), DOWNLOAD_DRAIN_MS, []);
    await recording.chain;
  }

  /**
   * A page started a download: it is stored in the background (never blocks the recording) and
   * linked to the step recorded on that page just before it, if any.
   */
  private trackDownload(
    recording: ActiveRecording,
    download: CapturedDownload,
    pageId: RecordedPageId,
  ): void {
    // decided now: steps recorded later are not what triggered this download
    const candidates = linkCandidates(recording.marks, pageId, download.at);
    const task: Promise<void> = (async () => {
      let stepId: string | null = null;
      for (const candidate of candidates) {
        stepId = await withTimeout(candidate.step, DOWNLOAD_DRAIN_MS, null);
        if (stepId) break;
      }
      await this.deps.downloads.record({
        sessionId: recording.sessionId,
        stepId,
        runId: null,
        source: 'recording',
        capture: download,
      });
    })()
      .catch((err: unknown) => {
        if (this.active === recording && err instanceof DomainError) {
          recording.warning = err.message;
        }
        this.deps.onError?.(err);
      })
      .finally(() => {
        this.downloadTasks.delete(task);
        this.deps.onApplied?.(recording.sessionId);
      });
    this.downloadTasks.add(task);
  }

  async pause(sessionId: string, paused: boolean): Promise<void> {
    const recording = this.require(sessionId);
    this.assertRecordingSteps(recording);
    recording.paused = paused;
    await recording.handle?.setState({ paused });
  }

  /**
   * "Verificar" (Thinkflow screen or toolbar): a print of the whole window right now, as a
   * `checkpoint` step. Waits a little for the screen to settle, like a manual print. Recording
   * continues normally.
   */
  async checkpoint(sessionId: string, pageId: RecordedPageId | null = null): Promise<TestEvidence> {
    const recording = this.active?.sessionId === sessionId ? this.active : null;
    if (!recording?.handle) {
      throw new DomainError(
        'Inicie a gravação para verificar a tela do navegador.',
        'not_recording',
        409,
      );
    }
    this.assertRecordingSteps(recording);
    return this.printStep(recording, pageId, 'checkpoint');
  }

  /** A check of the page the user is on now (URL path or title). */
  async assertPage(sessionId: string, type: 'urlContains' | 'title'): Promise<void> {
    const recording = this.require(sessionId);
    this.assertRecordingSteps(recording);
    const page = await recording.handle?.currentPage();
    if (!page) throw new DomainError('A página do navegador foi fechada.', 'page_closed', 409);
    this.enqueueApply(
      recording,
      (state) =>
        applyPageAssertion(state, type, page, () => this.deps.ids.next(), this.deps.clock.now()),
      null,
    );
    await recording.chain;
  }

  /**
   * Manual print (mode "Só prints"): waits a little for the screen to settle, then adds a
   * `capture` step holding the print. Toolbar button, Ctrl+Shift+S or the Thinkflow screen.
   */
  async capture(sessionId: string, pageId: RecordedPageId | null = null): Promise<TestEvidence> {
    const recording = this.active?.sessionId === sessionId ? this.active : null;
    if (!recording?.handle) {
      throw new DomainError(
        'Inicie a gravação para capturar a tela do navegador.',
        'not_recording',
        409,
      );
    }
    if (recording.mode !== 'capture') {
      throw new DomainError(
        `A captura manual só existe no modo ${modeLabel('capture')}: ao gravar passos, cada ação já ganha um print automático.`,
        'capture_unavailable',
        409,
      );
    }
    return this.printStep(recording, pageId, 'capture');
  }

  /**
   * "Protótipo" (toolbar or Thinkflow screen, mode "Só prints" only): the screen the user is on
   * becomes a prototype linked to this session and its current step. No step is added; the
   * capture session continues.
   */
  async capturePrototype(
    sessionId: string,
    pageId: RecordedPageId | null = null,
    options: { keepData?: boolean } = {},
  ): Promise<PrototypeCaptureResultDto> {
    const recording = this.active?.sessionId === sessionId ? this.active : null;
    if (!recording?.handle) {
      throw new DomainError(
        'Inicie a gravação para capturar a tela como protótipo.',
        'not_recording',
        409,
      );
    }
    if (recording.mode !== 'capture') {
      throw new DomainError(
        `O protótipo só pode ser capturado no modo ${modeLabel('capture')}.`,
        'prototype_capture_mode_only',
        409,
      );
    }
    const sink = this.deps.prototypes;
    if (!sink) {
      throw new DomainError('Protótipos indisponíveis.', 'prototypes_unavailable', 501);
    }
    const handle = recording.handle;
    return this.inChain(recording, async () => {
      await this.settle(recording, pageId, MANUAL_SETTLE_MAX_MS, null);
      const session = await this.deps.repo.find(sessionId);
      if (!session) throw new NotFoundError('Sessão de teste');
      const screen = await handle.capturePrototype(pageId);
      if (!screen) throw new DomainError('A página do navegador foi fechada.', 'page_closed', 409);
      const steps = session.definition.steps;
      const step = currentStepOf(steps);
      return sink.capture({
        sessionId,
        stepId: step?.id ?? null,
        menuPath: menuPathBefore(steps, step?.id ?? null),
        keepData: options.keepData === true,
        screen,
      });
    });
  }

  /** A step holding a print of the whole window (settled first): a manual capture or a checkpoint. */
  private async printStep(
    recording: ActiveRecording,
    pageId: RecordedPageId | null,
    kind: Extract<TestStepKind, 'capture' | 'checkpoint'>,
  ): Promise<TestEvidence> {
    const { sessionId } = recording;
    const handle = recording.handle!;
    await this.deps.images.assertWritable();
    return this.inChain(recording, async () => {
      await this.settle(recording, pageId, MANUAL_SETTLE_MAX_MS, null);
      const session = await this.deps.repo.find(sessionId);
      if (!session) throw new NotFoundError('Sessão de teste');
      if (session.definition.steps.length >= TEST_LIMITS.maxSteps) {
        throw new DomainError(
          `Limite de ${TEST_LIMITS.maxSteps} passos atingido.`,
          'too_many_steps',
          400,
        );
      }
      const shot = await handle.screenshot(pageId, {
        maskCss: secretMaskCss(session.definition),
      });
      if (!shot) throw new DomainError('A página do navegador foi fechada.', 'page_closed', 409);
      const step: TestStep = stepSchema.parse({
        id: this.deps.ids.next(),
        at: this.deps.clock.now(),
        kind,
        page: shot.page,
      });
      await this.deps.repo.save({
        ...session,
        definition: { ...session.definition, steps: [...session.definition.steps, step] },
        updatedAt: this.deps.clock.now(),
      });
      return saveStepImage(this.deps, {
        sessionId,
        stepId: step.id,
        bytes: shot.bytes,
        width: shot.width,
        height: shot.height,
      });
    });
  }

  private require(sessionId: string): ActiveRecording {
    const recording = this.active;
    if (!recording || recording.sessionId !== sessionId) {
      throw new DomainError('Nenhuma gravação em andamento nesta sessão.', 'not_recording', 409);
    }
    return recording;
  }

  private assertRecordingSteps(recording: ActiveRecording): void {
    if (recording.mode === 'capture') {
      throw new DomainError(
        `No modo ${modeLabel('capture')} nada vira passo: pausar e verificar só existem ao gravar passos.`,
        'capture_only',
        409,
      );
    }
  }

  async stopAll(): Promise<void> {
    if (this.active) await this.stop(this.active.sessionId);
  }

  /** The user did something in the browser: a print still waiting for the screen is taken now. */
  private noteAction(recording: ActiveRecording): void {
    recording.actions += 1;
    recording.settling?.abort();
  }

  private enqueue(
    recording: ActiveRecording,
    event: RecorderEvent,
    page: EventPage | null,
    pageId: RecordedPageId | null,
  ): void {
    if (event.type !== 'navigate' || recording.handle) this.noteAction(recording);
    if (recording.mode === 'capture') return; // "Só prints": the user only browses and captures
    if (recording.paused && event.type !== 'navigate') return;
    this.enqueueApply(
      recording,
      (state) => applyRecorderEvent(state, event, page, () => this.deps.ids.next()),
      pageId,
      this.markStep(recording, pageId, event.at),
    );
  }

  /** Remembers that a step may come out of this event; the returned function reports which. */
  private markStep(
    recording: ActiveRecording,
    pageId: RecordedPageId | null,
    at: number,
  ): (stepId: string | null) => void {
    let resolve!: (stepId: string | null) => void;
    const step = new Promise<string | null>((r) => (resolve = r));
    recording.marks.push({ pageId, at, step });
    if (recording.marks.length > MAX_STEP_MARKS) recording.marks.shift();
    return resolve;
  }

  private enqueueApply(
    recording: ActiveRecording,
    change: (state: RecordingState) => ApplyResult,
    pageId: RecordedPageId | null,
    onStep?: (stepId: string | null) => void,
  ): void {
    const actions = recording.actions; // the print of this step must not show later actions
    void this.inChain(recording, () => this.apply(recording, change, pageId, actions, onStep))
      .catch(
        () => undefined, // reported by the chain
      )
      .finally(() => onStep?.(null)); // no-op when the step was already reported
  }

  /** Runs `job` after everything queued before it; failures are reported, never stop the chain. */
  private inChain<T>(recording: ActiveRecording, job: () => Promise<T>): Promise<T> {
    const result = recording.chain.then(job);
    recording.chain = result
      .then(
        () => undefined,
        (err: unknown) => this.deps.onError?.(err),
      )
      .finally(() => this.deps.onApplied?.(recording.sessionId));
    return result;
  }

  private async apply(
    recording: ActiveRecording,
    change: (state: RecordingState) => ApplyResult,
    pageId: RecordedPageId | null,
    actions: number,
    onStep?: (stepId: string | null) => void,
  ): Promise<void> {
    const { repo, clock } = this.deps;
    const session = await repo.find(recording.sessionId);
    if (!session) return;
    const result = change(session);
    if (result.change === 'ignored' || !result.stepId) return;
    const saved = {
      ...session,
      definition: result.definition,
      secrets: result.secrets,
      updatedAt: clock.now(),
    };
    await repo.save(saved);
    onStep?.(result.stepId);

    if (!saved.definition.autoThumbnails) return;
    if (!recording.handle) {
      recording.pendingPrint = result.stepId; // taken as soon as the window opens
      return;
    }
    await this.print(recording, result.stepId, pageId, actions);
  }

  /**
   * Waits for the screen to settle (page and frames loaded, no request in flight, DOM quiet),
   * capped; the next user action cuts the wait short so the print never shows a later state.
   * `actions` = the action count when the step was recorded.
   */
  private async settle(
    recording: ActiveRecording,
    pageId: RecordedPageId | null,
    maxMs: number,
    actions: number | null,
  ): Promise<void> {
    const handle = recording.handle;
    if (!handle) return;
    const controller = new AbortController();
    if (actions !== null) {
      // automatic print: an action that already arrived means "take it now"; one that arrives
      // while waiting aborts through `noteAction`
      if (recording.actions > actions) controller.abort();
      recording.settling = controller;
    }
    try {
      await this.settler.settle(() => handle.settleReading(pageId), {
        maxMs,
        signal: controller.signal,
      });
    } catch (err) {
      this.deps.onError?.(err); // the print is still taken
    } finally {
      if (recording.settling === controller) recording.settling = null;
    }
  }

  /** The automatic print of a recorded step. */
  private async print(
    recording: ActiveRecording,
    stepId: string,
    pageId: RecordedPageId | null,
    actions: number,
  ): Promise<void> {
    const { repo } = this.deps;
    const handle = recording.handle;
    const session = await repo.find(recording.sessionId);
    if (!session || !handle) return;
    await this.settle(recording, pageId, AUTO_SETTLE_MAX_MS, actions);
    let shot;
    try {
      shot = await handle.screenshot(pageId, { maskCss: secretMaskCss(session.definition) });
    } catch (err) {
      this.deps.onError?.(err); // the page navigated away or closed: no print
      return;
    }
    if (!shot) return;
    try {
      await saveStepImage(this.deps, {
        sessionId: session.id,
        stepId,
        bytes: shot.bytes,
        width: shot.width,
        height: shot.height,
        // automatic prints are reviewed at the end: the person turns on what goes into the document
        include: false,
      });
      if (recording.warning === STORAGE_WARNING) recording.warning = null;
    } catch (err) {
      if (err instanceof ObjectStoreUnavailableError) {
        recording.warning = STORAGE_WARNING;
        return;
      }
      throw err;
    }
    // re-read: more events may have been applied meanwhile. The first step is saved before the
    // window exists, so it learns its page from the print.
    const latest = await repo.find(session.id);
    if (!latest || !latest.definition.steps.some((s) => s.id === stepId && !s.page)) return;
    const steps = latest.definition.steps.map((s) =>
      s.id === stepId ? { ...s, page: shot.page } : s,
    );
    await repo.save({ ...latest, definition: { ...latest.definition, steps } });
  }
}
