import { describe, expect, it } from 'vitest';
import {
  ReportRunner,
  type JobExecutor,
} from '../../src/contexts/reports/application/report-runner';
import { STOP_REASON } from '../../src/contexts/reports/application/report-pipeline';
import type { Report, ReportJobSpec } from '../../src/contexts/reports/domain/report';
import type { ReportRepository } from '../../src/contexts/reports/domain/report-ports';
import { Lane } from '../../src/shared/kernel/lane';

const report = (id: string, over: Partial<Report> = {}): Report =>
  ({
    id,
    status: 'queued',
    progress: { phase: 'queued', current: 0, total: 0, label: '' },
    researchDone: 0,
    createdAt: Number(id.replace(/\D/g, '')) || 0,
    cancelRequested: false,
    ...over,
  }) as Report;

class FakeRepo {
  reports = new Map<string, Report>();
  deletedNotes: [string, number][] = [];
  resetSections: string[] = [];
  constructor(initial: Report[]) {
    initial.forEach((r) => this.reports.set(r.id, r));
  }
  async findById(id: string) {
    return this.reports.get(id) ?? null;
  }
  async update(id: string, patch: Partial<Report>) {
    const r = this.reports.get(id);
    if (r) Object.assign(r, patch);
  }
  async listByStatus(statuses: readonly string[]) {
    return [...this.reports.values()].filter((r) => statuses.includes(r.status));
  }
  async deleteNotesFromStep(id: string, step: number) {
    this.deletedNotes.push([id, step]);
  }
  async resetWritingSections(id: string) {
    this.resetSections.push(id);
  }
}

const clock = { now: () => 1000 };

function setup(initial: Report[], executor: JobExecutor) {
  const repo = new FakeRepo(initial);
  const runner = new ReportRunner({
    repo: repo as unknown as ReportRepository,
    executor,
    clock,
  });
  return { repo, runner };
}

/** Executor that blocks until released or aborted, recording what ran. */
function blockingExecutor() {
  const ran: string[] = [];
  const aborted: (string | undefined)[] = [];
  const releases = new Map<string, () => void>();
  const executor: JobExecutor = {
    run: (id, job, signal) =>
      new Promise<void>((resolve) => {
        ran.push(`${id}:${job.type}`);
        releases.set(id, resolve);
        signal.addEventListener('abort', () => {
          aborted.push(String(signal.reason));
          resolve();
        });
      }),
  };
  return { executor, ran, aborted, release: (id: string) => releases.get(id)?.() };
}

describe('ReportRunner', () => {
  it('runs one job at a time, in order', async () => {
    const x = blockingExecutor();
    const { runner } = setup([report('r1'), report('r2')], x.executor);
    runner.enqueue({ reportId: 'r1', spec: { type: 'generate' } });
    runner.enqueue({ reportId: 'r2', spec: { type: 'generate' } });
    expect(x.ran).toEqual(['r1:generate']);
    x.release('r1');
    await new Promise((r) => setTimeout(r, 0));
    expect(x.ran).toEqual(['r1:generate', 'r2:generate']);
    x.release('r2');
    await runner.whenIdle();
  });

  it('does not queue the same job twice', async () => {
    const x = blockingExecutor();
    const { runner } = setup([report('r1'), report('r2')], x.executor);
    runner.enqueue({ reportId: 'r1', spec: { type: 'generate' } });
    runner.enqueue({ reportId: 'r2', spec: { type: 'generate' } });
    runner.enqueue({ reportId: 'r2', spec: { type: 'generate' } });
    x.release('r1');
    await new Promise((r) => setTimeout(r, 0));
    x.release('r2');
    await runner.whenIdle();
    expect(x.ran).toEqual(['r1:generate', 'r2:generate']);
  });

  it('cancels a queued report without running it', async () => {
    const x = blockingExecutor();
    const { runner, repo } = setup([report('r1'), report('r2')], x.executor);
    runner.enqueue({ reportId: 'r1', spec: { type: 'generate' } });
    runner.enqueue({ reportId: 'r2', spec: { type: 'generate' } });
    await runner.cancel('r2');
    expect(repo.reports.get('r2')).toMatchObject({ status: 'canceled', cancelRequested: false });
    x.release('r1');
    await runner.whenIdle();
    expect(x.ran).toEqual(['r1:generate']);
  });

  it('aborts a running job and waits for it when asked', async () => {
    const x = blockingExecutor();
    const { runner, repo } = setup([report('r1', { status: 'writing' })], x.executor);
    runner.enqueue({ reportId: 'r1', spec: { type: 'generate' } });
    expect(runner.isRunning('r1')).toBe(true);
    await runner.cancel('r1', { wait: true });
    expect(x.aborted).toEqual(['cancel']);
    expect(repo.reports.get('r1')!.cancelRequested).toBe(true);
    await runner.whenIdle();
    expect(runner.isRunning('r1')).toBe(false);
  });

  it('ignores a cancel for finished or unknown reports', async () => {
    const x = blockingExecutor();
    const { runner, repo } = setup([report('r1', { status: 'done' })], x.executor);
    await runner.cancel('r1');
    await runner.cancel('nope');
    expect(repo.reports.get('r1')!.status).toBe('done');
  });

  it('a canceled queued rewrite leaves the finished report as it was', async () => {
    const x = blockingExecutor();
    const rewrite = { type: 'section', ordinal: 2, instructions: '', model: null } as const;
    const { runner, repo } = setup(
      [
        report('r1'),
        report('r2', {
          status: 'writing',
          progress: { phase: 'writing', current: 2, total: 8, label: '', job: rewrite },
        }),
      ],
      x.executor,
    );
    runner.enqueue({ reportId: 'r1', spec: { type: 'generate' } });
    runner.enqueue({ reportId: 'r2', spec: rewrite });
    await runner.cancel('r2');
    expect(repo.reports.get('r2')!.status).toBe('done');
    expect(repo.resetSections).toEqual(['r2']);
    x.release('r1');
    await runner.whenIdle();
  });

  it('resumes active reports at boot, redoing the cut-off step and the writing sections', async () => {
    const ran: [string, ReportJobSpec][] = [];
    const rewrite = { type: 'section', ordinal: 3, instructions: 'curto', model: 'm' } as const;
    const { runner, repo } = setup(
      [
        report('r2', { status: 'writing', researchDone: 3, createdAt: 2 }),
        report('r1', { status: 'researching', researchDone: 1, createdAt: 1 }),
        report('r3', {
          status: 'writing',
          createdAt: 3,
          progress: { phase: 'writing', current: 3, total: 8, label: '', job: rewrite },
        }),
        report('r4', { status: 'done', createdAt: 4 }),
        report('r5', { status: 'error', createdAt: 5 }),
      ],
      {
        run: async (id, job) => {
          ran.push([id, job]);
        },
      },
    );
    await runner.resumePending();
    await runner.whenIdle();
    expect(ran).toEqual([
      ['r1', { type: 'generate' }],
      ['r2', { type: 'generate' }],
      ['r3', rewrite],
    ]);
    expect(repo.deletedNotes).toEqual([
      ['r1', 2],
      ['r2', 4],
      ['r3', 1],
    ]);
    expect(repo.resetSections).toEqual(['r1', 'r2', 'r3']);
  });

  it('stop aborts the running job with the stop reason and drops the queue', async () => {
    const x = blockingExecutor();
    const { runner, repo } = setup([report('r1'), report('r2')], x.executor);
    runner.enqueue({ reportId: 'r1', spec: { type: 'generate' } });
    runner.enqueue({ reportId: 'r2', spec: { type: 'generate' } });
    runner.stop();
    await runner.whenIdle();
    expect(x.aborted).toEqual([STOP_REASON]);
    expect(x.ran).toEqual(['r1:generate']);
    // the state is untouched: it resumes at the next boot
    expect(repo.reports.get('r1')!.status).toBe('queued');
    runner.enqueue({ reportId: 'r2', spec: { type: 'generate' } });
    expect(x.ran).toEqual(['r1:generate']);
  });

  it('survives an executor that throws', async () => {
    const errors: string[] = [];
    const repo = new FakeRepo([report('r1'), report('r2')]);
    const ran: string[] = [];
    const runner = new ReportRunner({
      repo: repo as unknown as ReportRepository,
      clock,
      executor: {
        run: async (id) => {
          ran.push(id);
          if (id === 'r1') throw new Error('boom');
        },
      },
      onError: (err, id) => errors.push(`${id}:${(err as Error).message}`),
    });
    runner.enqueue({ reportId: 'r1', spec: { type: 'generate' } });
    runner.enqueue({ reportId: 'r2', spec: { type: 'generate' } });
    await runner.whenIdle();
    expect(ran).toEqual(['r1', 'r2']);
    expect(errors).toEqual(['r1:boom']);
  });
});

describe('Lane', () => {
  it('removes waiting jobs by predicate and settles when idle', async () => {
    const ran: number[] = [];
    let release!: () => void;
    const lane = new Lane<number>(
      (n) =>
        new Promise<void>((resolve) => {
          ran.push(n);
          if (n === 1) release = resolve;
          else resolve();
        }),
    );
    lane.enqueue(1);
    lane.enqueue(2);
    lane.enqueue(3);
    expect(lane.has('2')).toBe(true);
    expect(lane.remove((n) => n === 2)).toBe(1);
    release();
    await lane.whenIdle();
    expect(ran).toEqual([1, 3]);
    expect(lane.isIdle()).toBe(true);
  });
});
