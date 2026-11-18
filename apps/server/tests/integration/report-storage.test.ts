import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ReportDetailDto,
  ReportDto,
  ReportTemplateSummaryDto,
  StorageStatusDto,
} from '@thinkflow/shared';
import { SqliteReportRepository } from '../../src/contexts/reports/infrastructure/sqlite-report-repository';
import { createTestApp, type TestApp } from './test-app';
import { FakePdfRenderer, MODEL, makeProvider, type Provider } from './report-rendering-fixtures';
import { FakeDiagramRenderer } from './report-rendering-fixtures';

let t: TestApp | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Setup {
  app: TestApp;
  provider: Provider;
  pdf: FakePdfRenderer;
  /** The legacy PDF cache directory (`DATA_DIR/reports`). */
  legacyDir: string;
  repo: SqliteReportRepository;
  byName(part: string): string;
}

async function setup(): Promise<Setup> {
  const provider = makeProvider();
  const pdf = new FakePdfRenderer();
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-legacy-'));
  dirs.push(legacyDir);
  const app = await createTestApp({
    fetchFn: provider.fetchFn,
    reports: {
      diagramRenderer: new FakeDiagramRenderer(),
      pdfRenderer: pdf,
      dataDir: legacyDir,
      sleep: async () => {},
    },
  });
  t = app;
  await app.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
  const templates = (await app.api<ReportTemplateSummaryDto[]>('GET', '/api/report-templates'))
    .json;
  return {
    app,
    provider,
    pdf,
    legacyDir,
    repo: new SqliteReportRepository(app.db),
    byName: (part) => templates.find((x) => x.name.includes(part))!.id,
  };
}

/** Generates a report and waits for the job and for its upload. */
async function generate(
  s: Setup,
  body: object = {},
  options: { waitUpload?: boolean } = {},
): Promise<ReportDetailDto> {
  const created = await s.app.api<ReportDto>('POST', '/api/reports', {
    templateId: s.byName('Análise técnica'),
    model: MODEL,
    useMcp: false,
    variables: { assunto: 'Cobrança de IPTU' },
    ...body,
  });
  expect(created.status).toBe(201);
  await s.app.container.reports.runner.whenIdle();
  if (options.waitUpload !== false) await s.app.container.storage.sync.whenIdle();
  return (await s.app.api<ReportDetailDto>('GET', `/api/reports/${created.json.id}`)).json;
}

const get = (app: TestApp, url: string) =>
  app.app.inject({ method: 'GET', url, headers: { cookie: app.cookie } });

const dto = async (s: Setup, id: string) =>
  (await s.app.api<ReportDto>('GET', `/api/reports/${id}`)).json;

/** Objects of a report: `{ <version>: ['html', 'md', ...] }`. */
function versions(s: Setup, id: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of s.app.store.keys(`reports/${id}/`)) {
    const [, , version, file] = key.split('/') as [string, string, string, string];
    (out[version] ??= []).push(file.replace('report.', ''));
  }
  return out;
}

const textOf = async (s: Setup, key: string) =>
  new TextDecoder().decode((await s.app.store.getBytes(key))!);

describe('report storage: upload after assembly', () => {
  it('moves the HTML out of the column and keeps a Markdown copy in the bucket', async () => {
    const s = await setup();
    const report = await generate(s);
    expect(report.status).toBe('done');
    expect(report.storage).toBe('stored');
    expect(report.hasHtml).toBe(true);

    const row = (await s.repo.findById(report.id))!;
    expect(row.html).toBeNull();
    expect(row.htmlHash).toMatch(/^[0-9a-f]{16}$/);
    expect(row.artifactsStoredAt).not.toBeNull();
    expect(row.storageAttempts).toBe(0);
    expect(row.markdown).toBe(report.markdown); // the canonical Markdown stays in SQLite

    const base = `reports/${report.id}/${row.htmlHash}`;
    expect(s.app.store.keys(`reports/${report.id}/`)).toEqual([
      `${base}/report.html`,
      `${base}/report.md`,
    ]);
    const info = (await s.app.store.head(`${base}/report.html`))!;
    expect(info.contentType).toBe('text/html; charset=utf-8');
    expect(info.metadata).toMatchObject({
      'report-id': report.id,
      kind: 'report',
      artifact: 'html',
      app: 'thinkflow',
    });
    expect(info.metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(info.metadata).join(' ')).not.toContain(report.title);
    expect(await textOf(s, `${base}/report.md`)).toBe(report.markdown);
    expect(await s.app.store.head(`${base}/report.md`)).toMatchObject({
      contentType: 'text/markdown; charset=utf-8',
    });
  });

  it('streams the HTML with the same headers as before (CSP, nosniff, length, disposition)', async () => {
    const s = await setup();
    const report = await generate(s);
    const res = await get(s.app, `/api/reports/${report.id}/html`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox",
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.body));
    expect(res.body).toContain('<h2 id="sobre-este-documento">');

    const download = await get(s.app, `/api/reports/${report.id}/html?download=1`);
    expect(download.headers['content-disposition']).toMatch(/^attachment; filename="[^"]+\.html"$/);
    expect(download.body).toBe(res.body);
  });

  it('keeps a retry schedule per version and the storage state in the DTO', async () => {
    const s = await setup();
    s.app.store.fail('MinIO caiu');
    const report = await generate(s);
    expect(report.status).toBe('done');
    expect(report.storage).toBe('pending');
    const row = (await s.repo.findById(report.id))!;
    expect(row.html).not.toBeNull();
    expect(row.storageAttempts).toBe(1);
    expect(row.storageError).toBe('MinIO caiu');
    expect(row.storageNextAt).toBeGreaterThan(Date.now());
    expect(s.app.store.keys()).toEqual([]);

    const status = await s.app.api<StorageStatusDto>('GET', '/api/storage/status');
    expect(status.json).toMatchObject({ pendingUploads: 1, lastError: 'MinIO caiu' });

    // the backoff holds: the periodic/boot pass does not retry yet; "Reenviar pendentes" does
    s.app.store.fail(null);
    await s.app.container.storage.sync.backfill();
    expect((await dto(s, report.id)).storage).toBe('pending');
    expect((await s.app.api('POST', '/api/storage/sync')).status).toBe(202);
    await s.app.container.storage.sync.whenIdle();
    // the route fires and forgets; wait for the flush it started
    await s.app.container.storage.sync.flushAll();
    expect((await dto(s, report.id)).storage).toBe('stored');
    const after = (await s.repo.findById(report.id))!;
    expect(after).toMatchObject({ html: null, storageAttempts: 0, storageError: null });
    expect(versions(s, report.id)[after.htmlHash!]).toEqual(['html', 'md']);
    const done = await s.app.api<StorageStatusDto>('GET', '/api/storage/status');
    expect(done.json).toMatchObject({ pendingUploads: 0, lastError: null });
  });
});

describe('report storage: outage', () => {
  it('generation finishes during an outage; downloads come from the column until the sync clears it', async () => {
    const s = await setup();
    s.app.store.fail('MinIO caiu');
    const report = await generate(s);
    expect(report.status).toBe('done');
    expect(report.storage).toBe('pending');

    const html = await get(s.app, `/api/reports/${report.id}/html`);
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('<h2 id="sobre-este-documento">');
    expect((await get(s.app, `/api/reports/${report.id}/html?download=1`)).statusCode).toBe(200);
    expect((await get(s.app, `/api/reports/${report.id}/markdown`)).statusCode).toBe(200);

    // PDF: printed again from the staged HTML, delivered, but not cached while the storage is down
    const pdf = await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.body.startsWith('%PDF')).toBe(true);
    expect((await dto(s, report.id)).hasPdf).toBe(false);

    s.app.store.fail(null);
    await s.app.container.storage.sync.flushAll();
    const row = (await s.repo.findById(report.id))!;
    expect(row.html).toBeNull();
    expect((await dto(s, report.id)).storage).toBe('stored');
    const again = await get(s.app, `/api/reports/${report.id}/html`);
    expect(again.body).toBe(html.body);
  });

  it('answers 503 when the document is in the bucket and the bucket is down', async () => {
    const s = await setup();
    const report = await generate(s);
    // cache the PDF while the storage works
    expect((await get(s.app, `/api/reports/${report.id}/pdf`)).statusCode).toBe(200);
    expect((await dto(s, report.id)).hasPdf).toBe(true);

    s.app.store.fail('MinIO caiu');
    // iframe: a small pt-BR page, still sandboxed
    const page = await get(s.app, `/api/reports/${report.id}/html`);
    expect(page.statusCode).toBe(503);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain('sandbox');
    expect(page.body).toContain('O armazenamento de documentos (MinIO) está indisponível');
    // download / API clients: JSON
    const download = await get(s.app, `/api/reports/${report.id}/html?download=1`);
    expect(download.statusCode).toBe(503);
    expect(JSON.parse(download.body)).toMatchObject({ error: { code: 'storage_unavailable' } });
    // PDF in cache but the HTML is not staged: nothing to render from
    const pdf = await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(pdf.statusCode).toBe(503);
    expect(JSON.parse(pdf.body)).toMatchObject({ error: { code: 'storage_unavailable' } });
    // Markdown lives in SQLite
    expect((await get(s.app, `/api/reports/${report.id}/markdown`)).statusCode).toBe(200);
    expect((await dto(s, report.id)).status).toBe('done');

    s.app.store.fail(null);
    expect((await get(s.app, `/api/reports/${report.id}/html`)).statusCode).toBe(200);
  });

  it('rebuilds a document whose object disappeared and uploads it again', async () => {
    const s = await setup();
    const report = await generate(s);
    const row = (await s.repo.findById(report.id))!;
    const key = `reports/${report.id}/${row.htmlHash}/report.html`;
    const original = await textOf(s, key);
    s.app.store.drop(key);

    const res = await get(s.app, `/api/reports/${report.id}/html`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(original); // deterministic: same generatedAt, same bytes
    await s.app.container.storage.sync.whenIdle(); // the rebuild queued a new upload
    expect((await dto(s, report.id)).storage).toBe('stored');
    expect((await s.repo.findById(report.id))!.html).toBeNull();
    expect(s.app.store.has(key)).toBe(true);
  });
});

describe('report storage: PDF cache keyed by the document version', () => {
  it('renders once, serves the second from the bucket and invalidates on a new version', async () => {
    const s = await setup();
    const report = await generate(s);
    const v1 = (await s.repo.findById(report.id))!.htmlHash!;

    const first = await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(first.statusCode).toBe(200);
    expect(s.pdf.calls).toHaveLength(1);
    expect(versions(s, report.id)[v1]).toEqual(['html', 'md', 'pdf']);
    expect((await s.repo.findById(report.id))!.pdfKey).toBe(
      `reports/${report.id}/${v1}/report.pdf`,
    );
    const second = await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(second.body).toBe(first.body);
    expect(Number(second.headers['content-length'])).toBe(Buffer.byteLength(second.body));
    expect(s.pdf.calls).toHaveLength(1);

    // a section rewrite is a new document: new version, old objects (PDF included) are removed
    s.provider.answer.section = () => 'Texto novo.';
    await s.app.api('POST', `/api/reports/${report.id}/sections/2/regenerate`, {});
    await s.app.container.reports.runner.whenIdle();
    await s.app.container.storage.sync.whenIdle();
    const v2 = (await s.repo.findById(report.id))!.htmlHash!;
    expect(v2).not.toBe(v1);
    expect(versions(s, report.id)).toEqual({ [v2]: ['html', 'md'] });
    expect((await dto(s, report.id)).hasPdf).toBe(false);

    const third = await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(third.statusCode).toBe(200);
    expect(third.body).not.toBe(first.body);
    expect(s.pdf.calls).toHaveLength(2);
    expect(s.pdf.calls[1]!.html).toContain('Texto novo.');
    expect(versions(s, report.id)[v2]).toEqual(['html', 'md', 'pdf']);
  });

  it('renaming builds a new version and drops the old objects', async () => {
    const s = await setup();
    const report = await generate(s);
    const v1 = (await s.repo.findById(report.id))!.htmlHash!;
    await get(s.app, `/api/reports/${report.id}/pdf`);

    expect(
      (await s.app.api('PATCH', `/api/reports/${report.id}`, { title: 'Título novo' })).status,
    ).toBe(200);
    await s.app.container.storage.sync.whenIdle();
    const v2 = (await s.repo.findById(report.id))!.htmlHash!;
    expect(v2).not.toBe(v1);
    expect(Object.keys(versions(s, report.id))).toEqual([v2]);
    expect((await get(s.app, `/api/reports/${report.id}/html`)).body).toContain(
      '<title>Título novo</title>',
    );
    expect((await dto(s, report.id)).hasPdf).toBe(false);
  });

  it('does not cache a PDF when the storage fails while caching, but still delivers it', async () => {
    const s = await setup();
    const report = await generate(s);
    const v1 = (await s.repo.findById(report.id))!.htmlHash!;
    // HTML is in the bucket: stage it again so the PDF can be rendered while the store is down
    await s.repo.update(report.id, {
      html: await textOf(s, `reports/${report.id}/${v1}/report.html`),
    });
    s.app.store.fail('MinIO caiu');
    const res = await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(res.statusCode).toBe(200);
    expect((await s.repo.findById(report.id))!.pdfKey).toBeNull();
  });
});

describe('report storage: delete and prune', () => {
  it('deleting a report removes every stored document', async () => {
    const s = await setup();
    const report = await generate(s);
    await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(s.app.store.keys(`reports/${report.id}/`)).toHaveLength(3);
    expect((await s.app.api('DELETE', `/api/reports/${report.id}`)).status).toBe(200);
    expect(s.app.store.keys()).toEqual([]);
  });

  it('a delete during an outage is finished by the janitor', async () => {
    const s = await setup();
    const report = await generate(s);
    s.app.store.fail('MinIO caiu');
    expect((await s.app.api('DELETE', `/api/reports/${report.id}`)).status).toBe(200);
    s.app.store.fail(null);
    const key = s.app.store.keys()[0]!;
    // recent objects are protected by the grace period...
    expect(await s.app.container.storage.janitor.runOnce()).toEqual({
      removedReports: 0,
      removedVersions: 0,
    });
    expect(s.app.store.keys()).toHaveLength(2);
    // ...old ones are removed
    s.app.store.touch(key, Date.now() - 2 * 3_600_000);
    for (const k of s.app.store.keys()) s.app.store.touch(k, Date.now() - 2 * 3_600_000);
    expect(await s.app.container.storage.janitor.runOnce()).toEqual({
      removedReports: 1,
      removedVersions: 0,
    });
    expect(s.app.store.keys()).toEqual([]);
  });

  it('pruning old reports removes their documents too', async () => {
    const s = await setup();
    await s.app.api('PUT', '/api/reports/settings', { keepReports: 10 });
    const first = await generate(s);
    expect(s.app.store.keys(`reports/${first.id}/`)).toHaveLength(2);
    // the report being created is never pruned, so the 11th pushes the first out
    for (let i = 0; i < 11; i++) await generate(s);
    expect((await s.app.api('GET', `/api/reports/${first.id}`)).status).toBe(404);
    expect(s.app.store.keys(`reports/${first.id}/`)).toEqual([]);
    expect(s.app.store.keys()).toHaveLength(22); // 11 reports x (html + md)
  });
});

describe('report storage: legacy backfill', () => {
  it('moves the html column and the legacy PDF file into the bucket, idempotently', async () => {
    const s = await setup();
    const report = await generate(s);
    const row = (await s.repo.findById(report.id))!;
    const html = await textOf(s, `reports/${report.id}/${row.htmlHash}/report.html`);

    // rebuild the state of a report created before the object store
    for (const key of s.app.store.keys()) s.app.store.drop(key);
    await s.repo.update(report.id, {
      html,
      htmlHash: null,
      artifactsStoredAt: null,
      pdfKey: `${report.id}.pdf`,
      pdfAt: 1,
    });
    fs.writeFileSync(path.join(s.legacyDir, `${report.id}.pdf`), '%PDF-1.4 legacy');
    expect((await dto(s, report.id)).storage).toBe('pending');

    // still served: the PDF straight from the legacy file, no rendering
    const legacy = await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(legacy.statusCode).toBe(200);
    expect(legacy.body).toBe('%PDF-1.4 legacy');
    expect(s.pdf.calls).toHaveLength(0);

    await s.app.container.storage.sync.backfill();
    const migrated = (await s.repo.findById(report.id))!;
    expect(migrated.html).toBeNull();
    expect(migrated.htmlHash).toBe(row.htmlHash); // same document, same version
    expect(migrated.pdfKey).toBe(`reports/${report.id}/${row.htmlHash}/report.pdf`);
    expect(migrated.pdfAt).toBe(1);
    expect(versions(s, report.id)[row.htmlHash!]).toEqual(['html', 'md', 'pdf']);
    expect(fs.existsSync(path.join(s.legacyDir, `${report.id}.pdf`))).toBe(false);
    expect(await textOf(s, `reports/${report.id}/${row.htmlHash}/report.html`)).toBe(html);

    const keys = s.app.store.keys();
    await s.app.container.storage.sync.backfill();
    expect(s.app.store.keys()).toEqual(keys);
    expect(await s.repo.findById(report.id)).toEqual(migrated);

    const pdf = await get(s.app, `/api/reports/${report.id}/pdf`);
    expect(pdf.body).toBe('%PDF-1.4 legacy');
    expect(s.pdf.calls).toHaveLength(0);
  });

  it('drops the cache pointer when the legacy file is gone', async () => {
    const s = await setup();
    const report = await generate(s);
    await s.repo.update(report.id, { pdfKey: `${report.id}.pdf`, pdfAt: 1 });
    await s.app.container.storage.sync.backfill();
    expect((await s.repo.findById(report.id))!.pdfKey).toBeNull();
    // and the next download renders it again
    expect((await get(s.app, `/api/reports/${report.id}/pdf`)).statusCode).toBe(200);
    expect(s.pdf.calls).toHaveLength(1);
  });

  it('stops at the first outage and resumes later', async () => {
    const s = await setup();
    const report = await generate(s);
    const row = (await s.repo.findById(report.id))!;
    const html = await textOf(s, `reports/${report.id}/${row.htmlHash}/report.html`);
    for (const key of s.app.store.keys()) s.app.store.drop(key);
    await s.repo.update(report.id, { html, htmlHash: null, artifactsStoredAt: null });
    s.app.store.fail('MinIO caiu');
    await s.app.container.storage.sync.backfill();
    expect((await s.repo.findById(report.id))!.html).not.toBeNull();
    s.app.store.fail(null);
    await s.app.container.storage.sync.flushAll();
    expect((await s.repo.findById(report.id))!.html).toBeNull();
  });
});

describe('report storage: janitor', () => {
  it('removes orphans and superseded versions after the grace period, never recent objects', async () => {
    const s = await setup();
    const report = await generate(s);
    const current = (await s.repo.findById(report.id))!.htmlHash!;
    const old = Date.now() - 2 * 3_600_000;
    const put = async (key: string, age: 'old' | 'new') => {
      await s.app.store.put(key, new Uint8Array([1]), { contentType: 'text/html' });
      if (age === 'old') s.app.store.touch(key, old);
    };
    await put(`reports/${report.id}/aaaaaaaaaaaaaaaa/report.pdf`, 'old'); // superseded
    await put(`reports/${report.id}/bbbbbbbbbbbbbbbb/report.html`, 'new'); // superseded, in flight?
    await put('reports/ghost/cccccccccccccccc/report.html', 'old'); // orphan
    await put('reports/ghost/cccccccccccccccc/report.md', 'old');
    await put('reports/fresh/dddddddddddddddd/report.html', 'new'); // orphan, but recent
    await put('reports/mixed/eeeeeeeeeeeeeeee/report.html', 'old'); // orphan with a recent version
    await put('reports/mixed/ffffffffffffffff/report.html', 'new');
    for (const key of s.app.store.keys(`reports/${report.id}/${current}/`))
      s.app.store.touch(key, old); // the current version is old, and stays

    const result = await s.app.container.storage.janitor.runOnce();
    expect(result).toEqual({ removedReports: 1, removedVersions: 1 });
    expect(s.app.store.keys()).toEqual(
      [
        `reports/${report.id}/${current}/report.html`,
        `reports/${report.id}/${current}/report.md`,
        `reports/${report.id}/bbbbbbbbbbbbbbbb/report.html`,
        'reports/fresh/dddddddddddddddd/report.html',
        'reports/mixed/eeeeeeeeeeeeeeee/report.html',
        'reports/mixed/ffffffffffffffff/report.html',
      ].sort(),
    );
  });

  it('does nothing (and does not fail) while the storage is down', async () => {
    const s = await setup();
    await generate(s);
    s.app.store.fail('MinIO caiu');
    expect(await s.app.container.storage.janitor.runOnce()).toEqual({
      removedReports: 0,
      removedVersions: 0,
    });
  });
});
