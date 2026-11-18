import type { Clock } from '../../../shared/kernel/clock';
import { ObjectStoreUnavailableError } from '../../../shared/kernel/object-store';
import type { ReportRepository } from '../domain/report-ports';
import type { ReportArtifactStore } from '../domain/render-ports';

export interface ReportArtifactJanitorDeps {
  repo: ReportRepository;
  artifacts: ReportArtifactStore;
  clock: Clock;
  /** Objects younger than this are never touched: an upload may be in flight (default 1 h). */
  graceMs?: number;
  /** Time between runs (default 6 h). */
  intervalMs?: number;
  /** Delay of the first run after `start()` (default 1 min). */
  firstDelayMs?: number;
  onError?: (err: unknown, action: string) => void;
}

export interface JanitorResult {
  /** Reports that no longer exist whose documents were removed. */
  removedReports: number;
  /** Versions of existing reports that are not the current one. */
  removedVersions: number;
}

interface Stored {
  version: string;
  lastModified: number;
}

/**
 * Cleans what the normal flow leaves behind: documents of deleted reports (a delete that failed
 * with the storage down, an upload that finished after the delete) and superseded versions (a PDF
 * rendered for the old document). Everything younger than the grace period is left alone.
 */
export class ReportArtifactJanitor {
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private running: Promise<JanitorResult> | null = null;
  private stopped = false;

  constructor(private readonly deps: ReportArtifactJanitorDeps) {}

  start(): void {
    if (this.timer || this.interval || this.stopped) return;
    const every = this.deps.intervalMs ?? 6 * 60 * 60_000;
    this.timer = setTimeout(() => {
      void this.runOnce();
      this.interval = setInterval(() => void this.runOnce(), every);
      this.interval.unref();
    }, this.deps.firstDelayMs ?? 60_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = this.interval = null;
    await this.running?.catch(() => undefined);
  }

  /** One pass; concurrent calls share it. Never throws (a storage outage ends the pass early). */
  runOnce(): Promise<JanitorResult> {
    this.running ??= this.run()
      .catch((err: unknown) => {
        if (!(err instanceof ObjectStoreUnavailableError)) this.deps.onError?.(err, 'janitor');
        return { removedReports: 0, removedVersions: 0 };
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async run(): Promise<JanitorResult> {
    const { repo, artifacts, clock } = this.deps;
    const cutoff = clock.now() - (this.deps.graceMs ?? 60 * 60_000);
    const index = await repo.storageIndex();
    const result: JanitorResult = { removedReports: 0, removedVersions: 0 };

    // decided while listing, executed afterwards (never delete under a paginated listing)
    const removals: (() => Promise<void>)[] = [];
    const settle = (reportId: string, stored: Stored[]): void => {
      const entry = index.get(reportId);
      if (!entry) {
        // deleted report: only when nothing recent is left (an upload may still be landing)
        if (stored.every((s) => s.lastModified <= cutoff)) {
          removals.push(async () => {
            await artifacts.deleteReport(reportId);
            result.removedReports++;
          });
        }
        return;
      }
      if (entry.htmlHash === null) return; // not hashed yet (backfill pending): keep everything
      for (const s of stored) {
        if (s.version === entry.htmlHash || s.lastModified > cutoff) continue;
        removals.push(async () => {
          await artifacts.deleteVersion(reportId, s.version);
          result.removedVersions++;
        });
      }
    };

    // the inventory is ordered by key, so the versions of one report arrive together
    let currentId: string | null = null;
    let group: Stored[] = [];
    for await (const item of artifacts.inventory()) {
      if (item.reportId !== currentId) {
        if (currentId !== null) settle(currentId, group);
        currentId = item.reportId;
        group = [];
      }
      group.push({ version: item.version, lastModified: item.lastModified });
    }
    if (currentId !== null) settle(currentId, group);
    for (const remove of removals) {
      if (this.stopped) break;
      await remove();
    }
    return result;
  }
}
