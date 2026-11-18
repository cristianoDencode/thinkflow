import { templateSpecSchema } from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyMeta,
  type Report,
  type ReportNote,
  type ReportSection,
} from '../../src/contexts/reports/domain/report';
import { SqliteReportRepository } from '../../src/contexts/reports/infrastructure/sqlite-report-repository';
import { openDatabase, type DbHandle } from '../../src/shared/infrastructure/db/client';

let handle: DbHandle | undefined;
afterEach(() => {
  handle?.close();
  handle = undefined;
});

const spec = templateSpecSchema.parse({ sections: [{ id: 'a', title: 'A' }] });

const report = (id: string, over: Partial<Report> = {}): Report => ({
  id,
  title: `Relatório ${id}`,
  kind: 'report',
  templateId: 'tpl',
  templateName: 'Modelo',
  templateSnapshot: spec,
  status: 'done',
  progress: { phase: 'done', current: 0, total: 0, label: 'Concluído' },
  error: null,
  failedPhase: null,
  cancelRequested: false,
  model: 'groq/llama',
  variables: { x: '1' },
  brief: 'pedido',
  libraryId: null,
  useMcp: true,
  conversationId: null,
  plan: null,
  researchDone: 0,
  outline: null,
  html: null,
  markdown: null,
  meta: emptyMeta(),
  pdfKey: null,
  pdfAt: null,
  htmlHash: null,
  artifactsStoredAt: null,
  storageAttempts: 0,
  storageNextAt: null,
  storageError: null,
  createdAt: 1,
  updatedAt: 1,
  startedAt: null,
  finishedAt: null,
  ...over,
});

const section = (
  reportId: string,
  ordinal: number,
  over: Partial<ReportSection> = {},
): ReportSection => ({
  reportId,
  ordinal,
  title: `S${ordinal}`,
  requirements: '',
  role: 'section',
  status: 'pending',
  markdown: '',
  html: null,
  noteIds: [],
  model: null,
  providerId: null,
  warnings: [],
  error: null,
  updatedAt: 1,
  ...over,
});

const note = (reportId: string, id: string, step: number, ordinal = 0): ReportNote => ({
  id,
  reportId,
  step,
  ordinal,
  source: 'mcp',
  toolName: 't',
  query: '{}',
  content: 'c',
  sectionHints: [1],
  createdAt: 1,
});

function repo() {
  handle = openDatabase(':memory:');
  return new SqliteReportRepository(handle.db);
}

describe('SqliteReportRepository', () => {
  it('round-trips a report and applies partial updates', async () => {
    const r = repo();
    await r.create(
      report('r1', {
        plan: [{ objective: 'o', sections: [1] }],
        meta: { ...emptyMeta(), warnings: ['w'] },
        progress: {
          phase: 'writing',
          current: 1,
          total: 2,
          label: 'x',
          job: { type: 'section', ordinal: 2, instructions: 'i', model: null },
        },
      }),
    );
    const loaded = (await r.findById('r1'))!;
    expect(loaded).toMatchObject({
      title: 'Relatório r1',
      variables: { x: '1' },
      useMcp: true,
      plan: [{ objective: 'o', sections: [1] }],
    });
    expect(loaded.meta.warnings).toEqual(['w']);
    expect(loaded.progress.job).toEqual({
      type: 'section',
      ordinal: 2,
      instructions: 'i',
      model: null,
    });
    expect(loaded.templateSnapshot.sections[0]!.id).toBe('a');

    await r.update('r1', {
      status: 'error',
      error: 'falhou',
      failedPhase: 'writing',
      plan: null,
      researchDone: 3,
    });
    expect(await r.findById('r1')).toMatchObject({
      status: 'error',
      error: 'falhou',
      failedPhase: 'writing',
      plan: null,
      researchDone: 3,
      title: 'Relatório r1',
    });
    await r.update('missing', { status: 'done' });
    await r.update('r1', {});
  });

  it('lists newest first with filters, counts and flags, without the heavy columns', async () => {
    const r = repo();
    await r.create(report('a', { createdAt: 1, markdown: '# md', kind: 'prd' }));
    await r.create(
      report('b', {
        createdAt: 3,
        status: 'error',
        plan: [
          { objective: 'o', sections: [1] },
          { objective: 'p', sections: [1] },
        ],
      }),
    );
    await r.create(report('c', { createdAt: 2, title: '100% pronto_1' }));
    await r.addSections([section('b', 1), section('b', 2)]);
    const all = await r.list({ limit: 10, offset: 0 });
    expect(all.map((x) => x.id)).toEqual(['b', 'c', 'a']);
    expect(all[0]).toMatchObject({ sectionCount: 2, researchTotal: 2, hasMarkdown: false });
    expect(all[2]).toMatchObject({ hasMarkdown: true, hasHtml: false, hasPdf: false, kind: 'prd' });
    expect(all[0]).not.toHaveProperty('markdown');
    expect(all[0]).not.toHaveProperty('templateSnapshot');
    expect((await r.list({ limit: 10, offset: 0, status: 'error' })).map((x) => x.id)).toEqual([
      'b',
    ]);
    expect((await r.list({ limit: 10, offset: 0, kind: 'prd' })).map((x) => x.id)).toEqual(['a']);
    expect((await r.list({ limit: 1, offset: 1 })).map((x) => x.id)).toEqual(['c']);
    expect((await r.list({ limit: 10, offset: 0, q: '100%' })).map((x) => x.id)).toEqual(['c']);
    expect((await r.list({ limit: 10, offset: 0, q: 'pronto_1' })).map((x) => x.id)).toEqual(['c']);
    expect(await r.list({ limit: 10, offset: 0, q: '%' })).toHaveLength(1); // % is literal
  });

  it('keeps written sections, resets interrupted ones and cascades on delete', async () => {
    const r = repo();
    await r.create(report('r1'));
    await r.addSections([
      section('r1', 1, { status: 'done', markdown: 'texto' }),
      section('r1', 2),
    ]);
    await r.addSections([section('r1', 1), section('r1', 3)]); // the existing row is kept
    expect((await r.sections('r1')).map((s) => [s.ordinal, s.status, s.markdown])).toEqual([
      [1, 'done', 'texto'],
      [2, 'pending', ''],
      [3, 'pending', ''],
    ]);
    await r.updateSection('r1', 2, { status: 'writing' });
    await r.updateSection('r1', 3, {
      status: 'writing',
      markdown: 'antigo',
      warnings: ['w'],
      noteIds: ['n'],
    });
    await r.resetWritingSections('r1');
    const sections = await r.sections('r1');
    expect(sections.map((s) => s.status)).toEqual(['done', 'pending', 'done']);
    expect(sections[2]).toMatchObject({ warnings: ['w'], noteIds: ['n'] });

    await r.addNotes([note('r1', 'n1', 0), note('r1', 'n2', 1), note('r1', 'n3', 2)]);
    await r.deleteNotesFromStep('r1', 2);
    expect((await r.notes('r1')).map((n) => n.id)).toEqual(['n1', 'n2']);
    expect((await r.notes('r1'))[1]!.sectionHints).toEqual([1]);

    await r.delete('r1');
    expect(await r.sections('r1')).toEqual([]);
    expect(await r.notes('r1')).toEqual([]);
  });

  it('lists by status and prunes only the oldest finished reports', async () => {
    const r = repo();
    for (let i = 1; i <= 4; i++) await r.create(report(`d${i}`, { createdAt: i }));
    await r.create(report('old-running', { createdAt: 0, status: 'writing' }));
    expect((await r.listByStatus(['writing', 'queued'])).map((x) => x.id)).toEqual(['old-running']);
    const removed = await r.pruneOldest(2);
    expect(removed.map((x) => x.id).sort()).toEqual(['d1', 'd2']);
    expect((await r.list({ limit: 10, offset: 0 })).map((x) => x.id).sort()).toEqual([
      'd3',
      'd4',
      'old-running',
    ]);
  });
});

describe('SqliteReportRepository: object storage sync', () => {
  it('derives hasHtml/storage from the staging column and the version hash', async () => {
    const r = repo();
    await r.create(report('none', { createdAt: 1 }));
    await r.create(report('staged', { createdAt: 2, html: '<p>x</p>', htmlHash: 'a'.repeat(16) }));
    await r.create(report('stored', { createdAt: 3, htmlHash: 'b'.repeat(16) }));
    const byId = Object.fromEntries((await r.list({ limit: 10, offset: 0 })).map((x) => [x.id, x]));
    expect(byId.none).toMatchObject({ hasHtml: false, storage: null });
    expect(byId.staged).toMatchObject({ hasHtml: true, storage: 'pending' });
    expect(byId.stored).toMatchObject({ hasHtml: true, storage: 'stored' });
  });

  it('empties the column only for the version that was uploaded', async () => {
    const r = repo();
    const hash = 'a'.repeat(16);
    await r.create(report('r', { html: '<p>x</p>', htmlHash: hash, storageAttempts: 2 }));
    expect(await r.countStoragePending()).toBe(1);
    expect(await r.markArtifactsStored('r', 'f'.repeat(16), 10)).toBe(false); // newer assembly won
    expect((await r.findById('r'))!.html).toBe('<p>x</p>');
    expect(await r.markArtifactsStored('r', hash, 10)).toBe(true);
    expect(await r.findById('r')).toMatchObject({
      html: null,
      htmlHash: hash,
      artifactsStoredAt: 10,
      storageAttempts: 0,
    });
    expect(await r.markArtifactsStored('r', hash, 11)).toBe(false); // nothing left to clear
    expect(await r.countStoragePending()).toBe(0);
    expect(await r.markArtifactsStored('ghost', hash, 11)).toBe(false);
  });

  it('records failures with a backoff that listStorageDue respects', async () => {
    const r = repo();
    const hash = 'a'.repeat(16);
    await r.create(report('old', { html: 'a', htmlHash: hash, updatedAt: 1 }));
    await r.create(report('new', { html: 'b', htmlHash: hash, updatedAt: 2 }));
    await r.create(report('stored', { htmlHash: hash }));
    expect(await r.listStorageDue(100, 10)).toEqual(['old', 'new']);
    await r.markStorageFailed('old', hash, 'MinIO caiu', 500);
    await r.markStorageFailed('old', hash, 'MinIO caiu', 500);
    expect(await r.findById('old')).toMatchObject({
      storageAttempts: 2,
      storageError: 'MinIO caiu',
      storageNextAt: 500,
    });
    expect(await r.listStorageDue(100, 10)).toEqual(['new']);
    expect(await r.listStorageDue(500, 10)).toEqual(['old', 'new']);
    // a failure for a version that is no longer the current one is ignored
    await r.markStorageFailed('new', 'f'.repeat(16), 'x', 999);
    expect((await r.findById('new'))!.storageAttempts).toBe(0);
  });

  it('sets the hash of legacy rows only once, and the PDF only for the current version', async () => {
    const r = repo();
    const hash = 'a'.repeat(16);
    await r.create(report('legacy', { html: '<p>x</p>' }));
    expect(await r.setHtmlHashIfMissing('legacy', hash)).toBe(true);
    expect(await r.setHtmlHashIfMissing('legacy', 'f'.repeat(16))).toBe(false);
    expect((await r.findById('legacy'))!.htmlHash).toBe(hash);

    expect(await r.setPdfKeyIf('legacy', 'f'.repeat(16), 'reports/legacy/x/report.pdf', 5)).toBe(
      false,
    );
    expect(await r.setPdfKeyIf('legacy', hash, 'reports/legacy/x/report.pdf', 5)).toBe(true);
    expect(await r.findById('legacy')).toMatchObject({
      pdfKey: 'reports/legacy/x/report.pdf',
      pdfAt: 5,
    });
    await r.update('legacy', { status: 'writing' });
    expect(await r.setPdfKeyIf('legacy', hash, 'k', 6)).toBe(false);
  });

  it('lists legacy PDFs in id order, paged, and indexes the current versions', async () => {
    const r = repo();
    await r.create(report('a', { pdfKey: 'a.pdf' }));
    await r.create(report('b', { pdfKey: 'reports/b/0123456789abcdef/report.pdf' }));
    await r.create(report('c', { pdfKey: 'c.pdf' }));
    await r.create(report('d', { pdfKey: 'p/reports/d/0123456789abcdef/report.pdf' }));
    await r.create(report('e'));
    expect((await r.listLegacyPdfs(10)).map((x) => x.id)).toEqual(['a', 'c']);
    expect((await r.listLegacyPdfs(1)).map((x) => x.id)).toEqual(['a']);
    expect((await r.listLegacyPdfs(1, 'a')).map((x) => x.id)).toEqual(['c']);
    expect(await r.listLegacyPdfs(1, 'c')).toEqual([]);
    const index = await r.storageIndex();
    expect([...index.keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(index.get('b')).toEqual({
      htmlHash: null,
      pdfKey: 'reports/b/0123456789abcdef/report.pdf',
    });
  });
});
