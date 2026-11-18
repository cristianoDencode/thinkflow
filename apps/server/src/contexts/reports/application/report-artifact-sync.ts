import type { Clock } from '../../../shared/kernel/clock';
import {
  ObjectStoreUnavailableError,
  ObjectTooLargeError,
} from '../../../shared/kernel/object-store';
import { artifactVersion, isLegacyPdfKey } from '../domain/artifact-keys';
import type { Report } from '../domain/report';
import type { ReportRepository } from '../domain/report-ports';
import type {
  LegacyPdfSource,
  ReportArtifactMeta,
  ReportArtifactRef,
  ReportArtifactStore,
} from '../domain/render-ports';

/** Wait before the n-th retry of a failed upload (the last value repeats). */
export const SYNC_BACKOFF_MS: readonly number[] = [
  30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000,
];

export interface ReportArtifactSyncDeps {
  repo: ReportRepository;
  artifacts: ReportArtifactStore;
  /** Pre-object-store PDF cache; moved into the store by the backfill. */
  legacyPdf?: LegacyPdfSource;
  clock: Clock;
  /** Circuit breaker for the periodic sweep: false = the storage is known to be down. */
  checkAvailable?: () => Promise<boolean>;
  onError?: (err: unknown, info: { action: string; reportId: string | null }) => void;
  /** Per storage call (default 30 s). */
  timeoutMs?: number;
  /** Sweep interval (default 30 s). */
  tickMs?: number;
  /** Reports per batch (default 20). */
  batchSize?: number;
  backoffMs?: readonly number[];
}

type Outcome = 'stored' | 'skipped' | 'superseded' | 'unavailable' | 'failed';

/**
 * Moves the HTML (and a Markdown copy) of finished reports from the staging column into the
 * object store. The column is emptied only after the objects are confirmed (`head`), by a
 * conditional UPDATE on the version hash, so an assembly that lands in the meantime is never lost.
 * Failures are recorded with a backoff; the report itself is never affected.
 */
export class ReportArtifactSync {
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private sweeping: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly shutdown = new AbortController();
  private lastErrorText: string | null = null;
  private pdfBackfillDue = true;

  constructor(private readonly deps: ReportArtifactSyncDeps) {}

  /** Uploads one report soon (after an assembly). Never throws. */
  kick(reportId: string): void {
    if (this.stopped) return;
    void this.inLane(reportId, () => this.syncOne(reportId));
  }

  /** Reports waiting for their upload. */
  pending(): Promise<number> {
    return this.deps.repo.countStoragePending();
  }

  /** Last upload error (pt-BR), cleared by the next successful upload. */
  lastError(): string | null {
    return this.lastErrorText;
  }

  /** Resolves when no upload is running or queued (tests). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Boot: starts the periodic sweep and migrates what the previous versions left behind. */
  async resumePending(): Promise<void> {
    this.startTimer();
    if (this.deps.checkAvailable && !(await this.deps.checkAvailable())) return;
    await this.backfill();
  }

  /**
   * Automatic backfill (D5): documents still in the `html` column (reports from before the object
   * store, or never uploaded) go to the bucket, then the legacy `<id>.pdf` files follow. Idempotent.
   */
  async backfill(): Promise<void> {
    await this.run(false);
  }

  /** "Reenviar pendentes": retries everything now, ignoring the backoff. Never throws. */
  async flushAll(): Promise<void> {
    await this.run(true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.shutdown.abort();
    await this.whenIdle();
  }

  /* ------------------------------ internals ------------------------------ */

  private startTimer(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 30_000);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.deps.checkAvailable && !(await this.deps.checkAvailable())) return;
      await this.sweep(false);
      if (this.pdfBackfillDue) this.pdfBackfillDue = !(await this.migrateLegacyPdfs());
    } catch (err) {
      this.report(err, 'tick', null);
    }
  }

  private async run(force: boolean): Promise<void> {
    try {
      await this.sweep(force);
      this.pdfBackfillDue = !(await this.migrateLegacyPdfs());
    } catch (err) {
      this.report(err, force ? 'flush' : 'backfill', null);
    }
  }

  private report(err: unknown, action: string, reportId: string | null): void {
    if (!this.stopped) this.deps.onError?.(err, { action, reportId });
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(settled);
    void settled.finally(() => this.inflight.delete(settled));
    return promise;
  }

  /** Work on one report runs one at a time. */
  private inLane<T>(reportId: string, job: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(reportId) ?? Promise.resolve();
    const next = previous.then(job, job);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.lanes.set(reportId, tail);
    void tail.finally(() => {
      if (this.lanes.get(reportId) === tail) this.lanes.delete(reportId);
    });
    return this.track(next);
  }

  private signal(): AbortSignal {
    return AbortSignal.any([
      AbortSignal.timeout(this.deps.timeoutMs ?? 30_000),
      this.shutdown.signal,
    ]);
  }

  /** Every report that is due, in batches. Stops at the first sign that the storage is down. */
  private sweep(force: boolean): Promise<void> {
    const job = async (): Promise<void> => {
      const batch = this.deps.batchSize ?? 20;
      const seen = new Set<string>();
      for (;;) {
        if (this.stopped) return;
        const now = force ? Number.MAX_SAFE_INTEGER : this.deps.clock.now();
        const due = await this.deps.repo.listStorageDue(now, batch + seen.size);
        const ids = due.filter((id) => !seen.has(id)).slice(0, batch);
        if (ids.length === 0) return;
        for (const id of ids) {
          seen.add(id);
          const outcome = await this.inLane(id, () => this.syncOne(id));
          if (outcome === 'unavailable') return;
        }
      }
    };
    const next = this.sweeping.then(job, job);
    this.sweeping = this.track(next).catch(() => undefined);
    return next;
  }

  private metaOf(report: Pick<Report, 'kind' | 'templateId'>): ReportArtifactMeta {
    return { kind: report.kind, templateId: report.templateId };
  }

  private async syncOne(id: string): Promise<Outcome> {
    const { repo, artifacts, clock } = this.deps;
    let hash: string | null = null;
    let attempts = 0;
    try {
      let report = await repo.findById(id);
      if (!report || report.html === null) return 'skipped';
      if (report.htmlHash === null) {
        // report from before the object store: the version is derived from the document itself
        await repo.setHtmlHashIfMissing(id, artifactVersion(report.html));
        report = await repo.findById(id);
        if (!report || report.html === null || report.htmlHash === null) return 'skipped';
      }
      hash = report.htmlHash;
      attempts = report.storageAttempts;
      const meta = this.metaOf(report);
      const htmlBytes = new TextEncoder().encode(report.html);
      const htmlRef: ReportArtifactRef = { reportId: id, version: hash, artifact: 'html' };
      await artifacts.put(htmlRef, htmlBytes, meta, this.signal());
      const stored = await artifacts.head(htmlRef, this.signal());
      if (!stored || stored.size !== htmlBytes.byteLength)
        throw new ObjectStoreUnavailableError('o envio do documento não foi confirmado');
      if (report.markdown !== null) {
        const mdRef: ReportArtifactRef = { reportId: id, version: hash, artifact: 'md' };
        const mdBytes = new TextEncoder().encode(report.markdown);
        await artifacts.put(mdRef, mdBytes, meta, this.signal());
        const mdStored = await artifacts.head(mdRef, this.signal());
        if (!mdStored || mdStored.size !== mdBytes.byteLength)
          throw new ObjectStoreUnavailableError('o envio da cópia em Markdown não foi confirmado');
      }
      if (!(await repo.markArtifactsStored(id, hash, clock.now()))) {
        // another assembly replaced the document (it has its own upload) or the report is gone
        if (!(await repo.findById(id))) await artifacts.deleteReport(id).catch(() => undefined);
        return 'superseded';
      }
      this.lastErrorText = null;
      // old versions go away only now that the new one is safe; the janitor retries on failure
      await artifacts
        .deleteOtherVersions(id, hash)
        .catch((err: unknown) => this.report(err, 'delete-old-versions', id));
      return 'stored';
    } catch (err) {
      if (this.stopped) return 'skipped';
      const unavailable = err instanceof ObjectStoreUnavailableError;
      const message = unavailable
        ? err.reason
        : err instanceof ObjectTooLargeError
          ? err.message
          : 'falha inesperada ao enviar o documento';
      this.lastErrorText = message;
      if (!unavailable) this.report(err, 'upload', id);
      if (hash !== null) {
        const backoff = this.deps.backoffMs ?? SYNC_BACKOFF_MS;
        const wait = backoff[Math.min(attempts, backoff.length - 1)] ?? 1_800_000;
        await this.deps.repo
          .markStorageFailed(id, hash, message, this.deps.clock.now() + wait)
          .catch(() => undefined);
      }
      return unavailable ? 'unavailable' : 'failed';
    }
  }

  /** Legacy `DATA_DIR/reports/<id>.pdf` -> the object store. Returns false if it stopped early. */
  private async migrateLegacyPdfs(): Promise<boolean> {
    if (!this.deps.legacyPdf) return true;
    const batch = this.deps.batchSize ?? 20;
    let after: string | undefined;
    for (;;) {
      if (this.stopped) return false;
      const rows = await this.deps.repo.listLegacyPdfs(batch, after);
      if (rows.length === 0) return true;
      for (const row of rows) {
        after = row.id;
        const outcome = await this.inLane(row.id, () => this.migratePdf(row.id));
        if (outcome === 'unavailable') return false;
      }
    }
  }

  private async migratePdf(id: string): Promise<Outcome> {
    const { repo, artifacts, legacyPdf, clock } = this.deps;
    if (!legacyPdf) return 'skipped';
    try {
      let report = await repo.findById(id);
      if (!report?.pdfKey || !isLegacyPdfKey(report.pdfKey)) return 'skipped';
      const bytes = await legacyPdf.read(id);
      if (!bytes) {
        // the cache file is gone: the PDF is simply rendered again on the next download
        await repo.update(id, { pdfKey: null, pdfAt: null });
        return 'skipped';
      }
      if (report.htmlHash === null && report.html !== null) {
        await repo.setHtmlHashIfMissing(id, artifactVersion(report.html));
        report = await repo.findById(id);
      }
      if (!report?.htmlHash) {
        await repo.update(id, { pdfKey: null, pdfAt: null });
        return 'skipped';
      }
      const ref: ReportArtifactRef = { reportId: id, version: report.htmlHash, artifact: 'pdf' };
      await artifacts.put(ref, bytes, this.metaOf(report), this.signal());
      const stored = await artifacts.head(ref, this.signal());
      if (!stored || stored.size !== bytes.byteLength)
        throw new ObjectStoreUnavailableError('o envio do PDF não foi confirmado');
      await repo.setPdfKeyIf(id, report.htmlHash, artifacts.key(ref), report.pdfAt ?? clock.now());
      await legacyPdf.delete(id);
      return 'stored';
    } catch (err) {
      if (this.stopped) return 'skipped';
      if (err instanceof ObjectStoreUnavailableError) return 'unavailable';
      this.report(err, 'migrate-pdf', id);
      return 'failed';
    }
  }
}
