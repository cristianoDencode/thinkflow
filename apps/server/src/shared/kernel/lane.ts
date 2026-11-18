/**
 * A FIFO that runs one job at a time; failures of a job never stop the lane.
 * Jobs with the same key are queued once (a job running right now does not count as queued).
 */
export class Lane<T = string> {
  private readonly queue: T[] = [];
  private current: Promise<void> | null = null;
  private stopped = false;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly run: (job: T) => Promise<void>,
    private readonly keyOf: (job: T) => string = (job) => String(job),
  ) {}

  enqueue(job: T): void {
    if (this.stopped || this.has(this.keyOf(job))) return;
    this.queue.push(job);
    this.pump();
  }

  /** True when a job with this key is waiting (not running). */
  has(key: string): boolean {
    return this.queue.some((job) => this.keyOf(job) === key);
  }

  /** Drops the waiting jobs with this key; returns how many were removed. */
  remove(match: (job: T) => boolean): number {
    let removed = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (match(this.queue[i]!)) {
        this.queue.splice(i, 1);
        removed++;
      }
    }
    this.settleIfIdle();
    return removed;
  }

  isIdle(): boolean {
    return this.current === null && this.queue.length === 0;
  }

  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.settleIfIdle();
  }

  private settleIfIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private pump(): void {
    if (this.current || this.stopped) return;
    const next = this.queue.shift();
    if (next === undefined) {
      this.settleIfIdle();
      return;
    }
    this.current = this.run(next)
      .catch(() => undefined)
      .finally(() => {
        this.current = null;
        if (this.queue.length > 0 && !this.stopped) this.pump();
        else this.settleIfIdle();
      });
  }
}
