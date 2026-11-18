import type { Clock } from '../../../shared/kernel/clock';
import { Lane } from '../../../shared/kernel/lane';
import {
  isActive,
  progressLabel,
  type Report,
  type ReportJobSpec,
  type ReportProgress,
} from '../domain/report';
import type { ReportRepository } from '../domain/report-ports';
import { STOP_REASON } from './report-pipeline';

export interface ReportJob {
  reportId: string;
  spec: ReportJobSpec;
}

/** What the runner needs from the pipeline (a fake in unit tests). */
export interface JobExecutor {
  run(reportId: string, job: ReportJobSpec, signal: AbortSignal): Promise<void>;
}

export interface ReportRunnerDeps {
  repo: ReportRepository;
  executor: JobExecutor;
  clock: Clock;
  onError?: (err: unknown, reportId: string) => void;
}

const keyOf = (job: ReportJob): string =>
  job.spec.type === 'generate' ? `g:${job.reportId}` : `s:${job.reportId}:${job.spec.ordinal}`;

/**
 * Background jobs of the reports: one at a time (free tiers allow little parallelism). All state
 * is in SQLite, so after a restart `resumePending` requeues what was cut off.
 */
export class ReportRunner {
  private readonly lane = new Lane<ReportJob>((job) => this.process(job), keyOf);
  private readonly stopController = new AbortController();
  private current: { reportId: string; controller: AbortController; done: Promise<void> } | null =
    null;
  private stopped = false;

  constructor(private readonly deps: ReportRunnerDeps) {}

  enqueue(job: ReportJob): void {
    this.lane.enqueue(job);
  }

  /** Resolves when nothing is queued or running (tests). */
  async whenIdle(): Promise<void> {
    while (!this.lane.isIdle()) await this.lane.whenIdle();
  }

  isRunning(reportId: string): boolean {
    return this.current?.reportId === reportId;
  }

  /** At boot: every report left in an active status is requeued (interrupted steps are redone). */
  async resumePending(): Promise<void> {
    const { repo } = this.deps;
    const pending = await repo.listByStatus([
      'queued',
      'researching',
      'outlining',
      'writing',
      'assembling',
    ]);
    for (const report of pending.sort((a, b) => a.createdAt - b.createdAt)) {
      await this.prepareResume(report);
      this.enqueue({ reportId: report.id, spec: report.progress.job ?? { type: 'generate' } });
    }
  }

  /** Clears what an interrupted run left half-done so the step runs again from scratch. */
  async prepareResume(report: Pick<Report, 'id' | 'researchDone'>): Promise<void> {
    await this.deps.repo.deleteNotesFromStep(report.id, report.researchDone + 1);
    await this.deps.repo.resetWritingSections(report.id);
  }

  /**
   * Cancels a queued job right away; for a running one asks it to stop (and waits for it when
   * `wait` is set). The report keeps what it already produced.
   */
  async cancel(reportId: string, options: { wait?: boolean } = {}): Promise<void> {
    const { repo, clock } = this.deps;
    const report = await repo.findById(reportId);
    if (!report || !isActive(report.status)) return;

    if (this.current?.reportId === reportId) {
      await repo.update(reportId, { cancelRequested: true, updatedAt: clock.now() });
      this.current.controller.abort('cancel');
      if (options.wait) await this.current.done;
      return;
    }
    // queued (or waiting for the boot-time resume): end it here
    this.lane.remove((job) => job.reportId === reportId);
    if (report.progress.job) {
      // a queued rewrite: the finished document stays as it was
      await repo.resetWritingSections(reportId);
      await repo.update(reportId, {
        status: 'done',
        progress: finished('done'),
        cancelRequested: false,
        updatedAt: clock.now(),
      });
    } else {
      await repo.update(reportId, {
        status: 'canceled',
        progress: finished('canceled'),
        cancelRequested: false,
        finishedAt: clock.now(),
        updatedAt: clock.now(),
      });
    }
  }

  /** Stops accepting jobs and aborts the running one without changing its saved state. */
  stop(): void {
    this.stopped = true;
    this.stopController.abort(STOP_REASON);
    this.lane.stop();
  }

  private async process(job: ReportJob): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.stopController.signal]);
    const done = this.deps.executor
      .run(job.reportId, job.spec, signal)
      .catch((err: unknown) => this.deps.onError?.(err, job.reportId));
    this.current = { reportId: job.reportId, controller, done };
    try {
      await done;
    } finally {
      this.current = null;
    }
  }
}

function finished(phase: 'done' | 'canceled'): ReportProgress {
  return { phase, current: 0, total: 0, label: progressLabel(phase, 0, 0) };
}
