import {
  isInteractionStep,
  runCreateSchema,
  sessionMode,
  TEST_LIMITS,
  type TestRunDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { DomainError, NotFoundError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import { Lane } from '../../../shared/kernel/lane';
import { ObjectStoreUnavailableError } from '../../../shared/kernel/object-store';
import { resolveValues } from '../domain/data';
import { planRerun, snapshotRunData, snapshotValues } from '../domain/run-data';
import { DOWNLOAD_DRAIN_MS } from '../domain/download';
import type {
  DisplaySupport,
  TestImageStore,
  TestRunner,
  TestSessionRepository,
} from '../domain/ports';
import {
  isFinishedRun,
  testKeys,
  type RunDataSnapshot,
  type TestRun,
  type TestSession,
} from '../domain/session';
import type { DownloadService } from './download-service';
import { secretMaskCss } from './recording-service';
import { RECORDING_UNSUPPORTED_MESSAGE, toRunDto } from './test-session-service';
import { withTimeout } from './with-timeout';

export const INTERRUPTED_MESSAGE = 'Execução interrompida: o servidor foi reiniciado.';

export interface RunServiceDeps {
  repo: TestSessionRepository;
  images: TestImageStore;
  downloads: DownloadService;
  runner: TestRunner;
  display: DisplaySupport;
  clock: Clock;
  ids: IdGenerator;
  /** The session is being recorded. */
  isRecording?: (sessionId: string) => boolean;
  onError?: (err: unknown) => void;
}

/** Replays, one at a time (a browser each); results are saved step by step for the live screen. */
export class RunService {
  private readonly lane: Lane<string>;
  /** runId → sessionId of the runs queued or running in this process. */
  private readonly pending = new Map<string, string>();
  private readonly controllers = new Map<string, AbortController>();
  /** Settles when the running run ends (cancel waits on it). */
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly deps: RunServiceDeps) {
    this.lane = new Lane((runId) => this.execute(runId));
  }

  isRunning(sessionId: string): boolean {
    return [...this.pending.values()].includes(sessionId);
  }

  whenIdle(): Promise<void> {
    return this.lane.whenIdle();
  }

  stop(): void {
    for (const c of this.controllers.values()) c.abort();
    this.lane.stop();
  }

  /** Boot: runs left queued/running by a previous process cannot continue. */
  async recoverInterrupted(): Promise<void> {
    const now = this.deps.clock.now();
    for (const status of ['queued', 'running'] as const) {
      for (const run of await this.deps.repo.runsWithStatus(status)) {
        await this.deps.repo.saveRun({
          ...run,
          status: 'error',
          error: INTERRUPTED_MESSAGE,
          finishedAt: now,
        });
      }
    }
  }

  /** One data set, or every data set in sequence (`dataSetId: null`). */
  /** DTO of a run, with the numbers of the session's runs. */
  private async dto(run: TestRun, session?: TestSession | null): Promise<TestRunDto> {
    const owner = session === undefined ? await this.deps.repo.find(run.sessionId) : session;
    return toRunDto(run, owner, await this.deps.repo.runNumbers(run.sessionId));
  }

  async start(sessionId: string, body: unknown): Promise<TestRunDto[]> {
    const input = runCreateSchema.parse(body);
    const session = await this.deps.repo.find(sessionId);
    if (!session) throw new NotFoundError('Sessão de teste');
    if (this.deps.isRecording?.(sessionId)) {
      throw new DomainError('Pare a gravação antes de executar.', 'test_session_busy', 409);
    }
    if (this.isRunning(sessionId)) {
      throw new DomainError('Esta sessão já está em execução.', 'test_session_busy', 409);
    }
    if (input.headed && !this.deps.display.canOpenWindow()) {
      throw new DomainError(RECORDING_UNSUPPORTED_MESSAGE, 'recording_unsupported', 400);
    }
    const def = session.definition;
    if (!def.steps.some(isInteractionStep)) {
      throw new DomainError(
        sessionMode(def) === 'capture'
          ? 'Esta sessão é só de prints: não há passos para executar.'
          : 'Grave ao menos um passo antes de executar.',
        'no_steps',
        400,
      );
    }
    // what each new run will use: a reproduction keeps the data of the original run
    const plans: { dataSetId: string | null; snapshot: RunDataSnapshot; rerunOf: string | null }[] =
      [];
    if (input.rerunOf) {
      const original = await this.deps.repo.findRun(input.rerunOf);
      if (!original || original.sessionId !== sessionId) throw new NotFoundError('Execução');
      if (!isFinishedRun(original.status)) {
        throw new DomainError(
          'Só dá para reproduzir uma execução que já terminou.',
          'run_not_finished',
          409,
        );
      }
      const plan = planRerun(original, def, session.secrets);
      if (!plan.snapshot) throw new DomainError(plan.dto.notice ?? '', 'rerun_impossible', 409);
      plans.push({
        dataSetId: original.dataSetId,
        snapshot: plan.snapshot,
        rerunOf: original.id,
      });
    } else {
      let dataSets = def.dataSets;
      if (input.dataSetId) {
        const ds = def.dataSets.find((d) => d.id === input.dataSetId);
        if (!ds) throw new NotFoundError('Conjunto de dados');
        dataSets = [ds];
      }
      for (const ds of dataSets) {
        plans.push({
          dataSetId: ds.id,
          snapshot: snapshotRunData(def, session.secrets, ds.id),
          rerunOf: null,
        });
      }
    }
    const runs: TestRun[] = [];
    let seq = await this.deps.repo.nextRunSeq(sessionId);
    for (const plan of plans) {
      const run: TestRun = {
        id: this.deps.ids.next(),
        sessionId,
        seq: seq++,
        rerunOf: plan.rerunOf,
        snapshot: plan.snapshot,
        dataSetId: plan.dataSetId,
        status: 'queued',
        headed: input.headed,
        results: [],
        error: null,
        createdAt: this.deps.clock.now(),
        startedAt: null,
        finishedAt: null,
      };
      await this.deps.repo.saveRun(run);
      runs.push(run);
    }
    for (const run of runs) {
      this.pending.set(run.id, sessionId);
      this.lane.enqueue(run.id);
    }
    const numbers = await this.deps.repo.runNumbers(sessionId);
    return runs.map((r) => toRunDto(r, session, numbers));
  }

  async get(sessionId: string, runId: string): Promise<TestRunDto> {
    const run = await this.deps.repo.findRun(runId);
    if (!run || run.sessionId !== sessionId) throw new NotFoundError('Execução');
    return this.dto(run);
  }

  async cancel(sessionId: string, runId: string): Promise<TestRunDto> {
    const run = await this.deps.repo.findRun(runId);
    if (!run || run.sessionId !== sessionId) throw new NotFoundError('Execução');
    if (isFinishedRun(run.status)) return this.dto(run);
    if (run.status === 'queued' && this.lane.remove((id) => id === runId) > 0) {
      this.pending.delete(runId);
      const canceled = { ...run, status: 'canceled' as const, finishedAt: this.deps.clock.now() };
      await this.deps.repo.saveRun(canceled);
      return this.dto(canceled);
    }
    this.controllers.get(runId)?.abort();
    await this.running.get(runId);
    return this.get(sessionId, runId);
  }

  private execute(runId: string): Promise<void> {
    const done = this.executeRun(runId);
    this.running.set(
      runId,
      done.catch(() => undefined),
    );
    return done.finally(() => this.running.delete(runId));
  }

  private async executeRun(runId: string): Promise<void> {
    const { repo, clock } = this.deps;
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    try {
      const queued = await repo.findRun(runId);
      const session = queued && (await repo.find(queued.sessionId));
      if (!queued || !session || queued.status !== 'queued') return;
      let run: TestRun = { ...queued, status: 'running', startedAt: clock.now() };
      await repo.saveRun(run);
      const def = session.definition;
      // files downloaded by the replay: stored in the background, linked to the running step
      const downloads = new Set<Promise<void>>();
      try {
        await this.deps.runner.run(
          {
            definition: def,
            // the data the run was created with; runs queued by an older version resolve it now
            values: run.snapshot
              ? snapshotValues(run.snapshot)
              : resolveValues(def, session.secrets, run.dataSetId),
            headed: run.headed,
            maskCss: secretMaskCss(def),
            signal: controller.signal,
            maxDownloadBytes: TEST_LIMITS.maxDownloadBytes,
            onDownload: (capture, stepId) => {
              const task: Promise<void> = this.deps.downloads
                .record({ sessionId: session.id, stepId, runId, source: 'replay', capture })
                .then(
                  () => undefined,
                  (err: unknown) => this.deps.onError?.(err),
                )
                .finally(() => downloads.delete(task));
              downloads.add(task);
            },
          },
          async (stepId, outcome) => {
            let screenshotKey: string | null = null;
            if (outcome.screenshot) {
              const key = testKeys.runShot(session.id, run.id, stepId);
              try {
                await this.deps.images.put(key, outcome.screenshot, 'image/png');
                screenshotKey = key;
              } catch (err) {
                // the result matters more than its screenshot
                if (!(err instanceof ObjectStoreUnavailableError)) this.deps.onError?.(err);
              }
            }
            run = {
              ...run,
              results: [
                ...run.results,
                {
                  stepId,
                  status: outcome.status,
                  durationMs: outcome.durationMs,
                  error: outcome.error,
                  locatorUsed: outcome.locatorUsed,
                  screenshotKey,
                },
              ],
            };
            await repo.saveRun(run);
          },
        );
        await withTimeout(Promise.allSettled([...downloads]), DOWNLOAD_DRAIN_MS, []);
        const failed = run.results.some((r) => r.status === 'failed');
        run = {
          ...run,
          status: controller.signal.aborted ? 'canceled' : failed ? 'failed' : 'passed',
          finishedAt: clock.now(),
        };
      } catch (err) {
        await withTimeout(Promise.allSettled([...downloads]), DOWNLOAD_DRAIN_MS, []);
        this.deps.onError?.(err);
        run = {
          ...run,
          status: controller.signal.aborted ? 'canceled' : 'error',
          error: controller.signal.aborted
            ? null
            : err instanceof Error
              ? err.message.slice(0, 1000)
              : 'Falha ao executar',
          finishedAt: clock.now(),
        };
      }
      await repo.saveRun(run);
    } finally {
      this.controllers.delete(runId);
      this.pending.delete(runId);
    }
  }
}
