import { templateSpecSchema } from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ReportArtifactSync } from '../../src/contexts/reports/application/report-artifact-sync';
import { artifactVersion } from '../../src/contexts/reports/domain/artifact-keys';
import { emptyMeta, type Report } from '../../src/contexts/reports/domain/report';
import type { ReportArtifactStore } from '../../src/contexts/reports/domain/render-ports';
import { ObjectReportArtifactStore } from '../../src/contexts/reports/infrastructure/object-report-artifact-store';
import { SqliteReportRepository } from '../../src/contexts/reports/infrastructure/sqlite-report-repository';
import { openDatabase, type DbHandle } from '../../src/shared/infrastructure/db/client';
import { MemoryObjectStore } from '../../src/shared/infrastructure/storage/memory-object-store';
import { FakeClock } from '../../src/shared/kernel/clock';

let handle: DbHandle | undefined;
afterEach(() => {
  handle?.close();
  handle = undefined;
});

const spec = templateSpecSchema.parse({ sections: [{ id: 'a', title: 'A' }] });

const report = (id: string, html: string, over: Partial<Report> = {}): Report => ({
  id,
  title: id,
  kind: 'report',
  templateId: null,
  templateName: 'Modelo',
  templateSnapshot: spec,
  status: 'done',
  progress: { phase: 'done', current: 0, total: 0, label: 'Concluído' },
  error: null,
  failedPhase: null,
  cancelRequested: false,
  model: 'm',
  variables: {},
  brief: '',
  libraryId: null,
  useMcp: false,
  conversationId: null,
  plan: null,
  researchDone: 0,
  outline: null,
  html,
  markdown: `# ${id}`,
  meta: emptyMeta(),
  pdfKey: null,
  pdfAt: null,
  htmlHash: artifactVersion(html),
  artifactsStoredAt: null,
  storageAttempts: 0,
  storageNextAt: null,
  storageError: null,
  createdAt: 1,
  updatedAt: 1,
  startedAt: null,
  finishedAt: 1,
  ...over,
});

function setup(wrap?: (store: ReportArtifactStore) => ReportArtifactStore) {
  handle = openDatabase(':memory:');
  const repo = new SqliteReportRepository(handle.db);
  const raw = new MemoryObjectStore();
  const artifacts = wrap
    ? wrap(new ObjectReportArtifactStore(raw))
    : new ObjectReportArtifactStore(raw);
  const clock = new FakeClock(1_000_000);
  const errors: unknown[] = [];
  const sync = new ReportArtifactSync({
    repo,
    artifacts,
    clock,
    onError: (err) => errors.push(err),
  });
  return { repo, raw, sync, clock, errors };
}

describe('ReportArtifactSync', () => {
  it('uploads, confirms and only then empties the column', async () => {
    const { repo, raw, sync } = setup();
    await repo.create(report('r1', '<p>1</p>'));
    sync.kick('r1');
    await sync.whenIdle();
    const row = (await repo.findById('r1'))!;
    expect(row.html).toBeNull();
    expect(raw.keys()).toHaveLength(2);
    await sync.stop();
  });

  it('keeps the column when the confirmation (head) says the object is not there', async () => {
    const { repo, raw, sync } = setup(
      (inner) =>
        ({
          ...inner,
          key: inner.key.bind(inner),
          put: async () => undefined, // pretends to upload
          head: async () => null,
        }) as ReportArtifactStore,
    );
    await repo.create(report('r1', '<p>1</p>'));
    sync.kick('r1');
    await sync.whenIdle();
    const row = (await repo.findById('r1'))!;
    expect(row.html).toBe('<p>1</p>');
    expect(row.storageAttempts).toBe(1);
    expect(row.storageError).toContain('não foi confirmado');
    expect(raw.keys()).toEqual([]);
    await sync.stop();
  });

  it('keeps the newer document when an assembly lands during the upload', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ctx = setup((inner) => {
      const put = inner.put.bind(inner);
      let first = true;
      return {
        ...inner,
        key: inner.key.bind(inner),
        head: inner.head.bind(inner),
        deleteReport: inner.deleteReport.bind(inner),
        deleteOtherVersions: inner.deleteOtherVersions.bind(inner),
        put: async (...args: Parameters<typeof put>) => {
          await put(...args);
          if (first) {
            first = false;
            await gate;
          }
        },
      } as ReportArtifactStore;
    });
    await ctx.repo.create(report('r1', '<p>old</p>'));
    ctx.sync.kick('r1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    // a new assembly replaces the document while the old one is being uploaded
    await ctx.repo.update('r1', { html: '<p>new</p>', htmlHash: artifactVersion('<p>new</p>') });
    release();
    await ctx.sync.whenIdle();
    expect((await ctx.repo.findById('r1'))!.html).toBe('<p>new</p>'); // not lost
    ctx.sync.kick('r1');
    await ctx.sync.whenIdle();
    const row = (await ctx.repo.findById('r1'))!;
    expect(row.html).toBeNull();
    // the old version is gone once the new one is safe
    expect(ctx.raw.keys().every((k) => k.includes(row.htmlHash!))).toBe(true);
    expect(ctx.raw.keys()).toHaveLength(2);
    await ctx.sync.stop();
  });

  it('removes what it uploaded for a report that was deleted meanwhile', async () => {
    const holder: { repo?: SqliteReportRepository } = {};
    const ctx = setup((inner) => {
      const put = inner.put.bind(inner);
      return {
        ...inner,
        key: inner.key.bind(inner),
        head: inner.head.bind(inner),
        deleteReport: inner.deleteReport.bind(inner),
        deleteOtherVersions: inner.deleteOtherVersions.bind(inner),
        put: async (...args: Parameters<typeof put>) => {
          await put(...args);
          await holder.repo?.delete('r1');
        },
      } as ReportArtifactStore;
    });
    holder.repo = ctx.repo;
    await ctx.repo.create(report('r1', '<p>1</p>'));
    ctx.sync.kick('r1');
    await ctx.sync.whenIdle();
    expect(ctx.raw.keys()).toEqual([]);
    await ctx.sync.stop();
  });

  it('backs off after a failure and honours the schedule', async () => {
    const { repo, raw, sync, clock } = setup();
    await repo.create(report('r1', '<p>1</p>'));
    raw.fail('MinIO caiu');
    sync.kick('r1');
    await sync.whenIdle();
    let row = (await repo.findById('r1'))!;
    expect(row).toMatchObject({ storageAttempts: 1, storageError: 'MinIO caiu' });
    expect(row.storageNextAt).toBe(1_000_000 + 30_000);
    raw.fail(null);

    await sync.backfill(); // not yet due
    expect((await repo.findById('r1'))!.html).not.toBeNull();
    clock.advance(30_000);
    await sync.backfill();
    expect((await repo.findById('r1'))!.html).toBeNull();

    // the second failure waits longer
    await repo.create(report('r2', '<p>2</p>', { storageAttempts: 1 }));
    raw.fail('de novo');
    sync.kick('r2');
    await sync.whenIdle();
    row = (await repo.findById('r2'))!;
    expect(row.storageNextAt).toBe(1_030_000 + 60_000);
    await sync.stop();
  });

  it('stops a bulk pass at the first outage', async () => {
    const { repo, raw, sync } = setup();
    for (const id of ['a', 'b', 'c']) await repo.create(report(id, `<p>${id}</p>`));
    raw.fail('MinIO caiu');
    await sync.flushAll();
    // one attempt was recorded, the others were not even tried
    const attempts = await Promise.all(['a', 'b', 'c'].map((id) => repo.findById(id)));
    expect(attempts.map((r) => r!.storageAttempts).sort()).toEqual([0, 0, 1]);
    raw.fail(null);
    await sync.flushAll();
    expect(await repo.countStoragePending()).toBe(0);
    expect(sync.lastError()).toBeNull();
    await sync.stop();
  });

  it('hashes legacy rows (no htmlHash) before uploading them', async () => {
    const { repo, raw, sync } = setup();
    await repo.create(report('old', '<p>legacy</p>', { htmlHash: null }));
    await sync.backfill();
    const row = (await repo.findById('old'))!;
    expect(row.html).toBeNull();
    expect(row.htmlHash).toBe(artifactVersion('<p>legacy</p>'));
    expect(raw.keys()).toContain(`reports/old/${row.htmlHash}/report.html`);
    await sync.stop();
  });

  it('ignores kicks after stop', async () => {
    const { repo, raw, sync } = setup();
    await repo.create(report('r1', '<p>1</p>'));
    await sync.stop();
    sync.kick('r1');
    await sync.whenIdle();
    expect(raw.keys()).toEqual([]);
  });
});
