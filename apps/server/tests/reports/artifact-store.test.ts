import { describe, expect, it } from 'vitest';
import {
  artifactKey,
  artifactVersion,
  isLegacyPdfKey,
  parseArtifactKey,
} from '../../src/contexts/reports/domain/artifact-keys';
import { ObjectReportArtifactStore } from '../../src/contexts/reports/infrastructure/object-report-artifact-store';
import { MemoryObjectStore } from '../../src/shared/infrastructure/storage/memory-object-store';
import { ObjectStoreUnavailableError } from '../../src/shared/kernel/object-store';

describe('artifact keys', () => {
  it('versions by the content of the HTML', () => {
    const a = artifactVersion('<p>a</p>');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(artifactVersion('<p>a</p>')).toBe(a);
    expect(artifactVersion('<p>b</p>')).not.toBe(a);
  });

  it('builds and parses keys, with and without a prefix', () => {
    const ref = { reportId: 'r-1', version: '0123456789abcdef', artifact: 'pdf' } as const;
    expect(artifactKey('', ref)).toBe('reports/r-1/0123456789abcdef/report.pdf');
    expect(artifactKey('prod/app/', { ...ref, artifact: 'md' })).toBe(
      'prod/app/reports/r-1/0123456789abcdef/report.md',
    );
    for (const prefix of ['', 'prod/app/'])
      for (const artifact of ['html', 'pdf', 'md'] as const) {
        const r = { ...ref, artifact };
        expect(parseArtifactKey(prefix, artifactKey(prefix, r))).toEqual(r);
      }
  });

  it('rejects keys that do not follow the scheme', () => {
    for (const key of [
      'reports/r/0123456789abcdef/report.txt',
      'reports/r/short/report.html',
      'reports/r/0123456789abcdef/sub/report.html',
      'reports/r/0123456789abcdef',
      'library/r/0123456789abcdef/report.html',
      'other/reports/r/0123456789abcdef/report.html',
    ])
      expect(parseArtifactKey('', key), key).toBeNull();
  });

  it('recognises the legacy PDF cache names', () => {
    expect(isLegacyPdfKey('3f2a-11.pdf')).toBe(true);
    expect(isLegacyPdfKey('reports/3f2a/0123456789abcdef/report.pdf')).toBe(false);
    expect(isLegacyPdfKey('a/b.pdf')).toBe(false);
  });
});

describe('ObjectReportArtifactStore', () => {
  const meta = { kind: 'report', templateId: 'builtin-1' } as const;
  const bytes = (text: string) => new TextEncoder().encode(text);
  const ref = (reportId: string, version: string, artifact: 'html' | 'pdf' | 'md' = 'html') => ({
    reportId,
    version,
    artifact,
  });
  const V1 = '1111111111111111';
  const V2 = '2222222222222222';

  it('applies the prefix, stores ASCII metadata and reads back', async () => {
    const raw = new MemoryObjectStore();
    const store = new ObjectReportArtifactStore(raw, 'thinkflow/');
    await store.put(ref('r1', V1), bytes('<p>oi</p>'), meta);
    expect(raw.keys()).toEqual([`thinkflow/reports/r1/${V1}/report.html`]);
    const info = (await raw.head(`thinkflow/reports/r1/${V1}/report.html`))!;
    expect(info.metadata).toMatchObject({ 'template-id': 'builtin-1', app: 'thinkflow' });
    expect(new TextDecoder().decode((await store.read(ref('r1', V1)))!)).toBe('<p>oi</p>');
    expect(await store.head(ref('r1', V1))).toEqual({ size: 9 });
    expect(await store.exists(ref('r1', V2))).toBe(false);
    expect(await store.read(ref('r1', V2))).toBeNull();
    expect(await store.stream(ref('r1', V2))).toBeNull();
    expect(store.key(ref('r1', V1))).toBe(`thinkflow/reports/r1/${V1}/report.html`);
  });

  it('leaves out a template id that is not safe for a header', async () => {
    const raw = new MemoryObjectStore();
    const store = new ObjectReportArtifactStore(raw);
    await store.put(ref('r1', V1), bytes('x'), { kind: 'prd', templateId: 'Relatório ç' });
    const info = (await raw.head(`reports/r1/${V1}/report.html`))!;
    expect(info.metadata['template-id']).toBeUndefined();
    expect(info.metadata.kind).toBe('prd');
  });

  it('deletes a version, the other versions, or the whole report without touching neighbours', async () => {
    const raw = new MemoryObjectStore();
    const store = new ObjectReportArtifactStore(raw);
    for (const id of ['r1', 'r10'])
      for (const v of [V1, V2])
        for (const a of ['html', 'md', 'pdf'] as const)
          await store.put(ref(id, v, a), bytes('x'), meta);
    await store.deleteOtherVersions('r1', V2);
    expect(raw.keys('reports/r1/')).toHaveLength(3);
    expect(raw.keys('reports/r1/').every((k) => k.includes(V2))).toBe(true);
    expect(raw.keys('reports/r10/')).toHaveLength(6);
    await store.deleteVersion('r10', V1);
    expect(raw.keys('reports/r10/').every((k) => k.includes(V2))).toBe(true);
    await store.deleteReport('r1');
    expect(raw.keys('reports/r1/')).toEqual([]);
    expect(raw.keys('reports/r10/')).toHaveLength(3);
  });

  it('inventories versions with the newest modification time', async () => {
    let now = 1000;
    const raw = new MemoryObjectStore({ now: () => now });
    const store = new ObjectReportArtifactStore(raw, 'p/');
    await store.put(ref('a', V1, 'html'), bytes('x'), meta);
    now = 5000;
    await store.put(ref('a', V1, 'pdf'), bytes('x'), meta);
    now = 2000;
    await store.put(ref('a', V2, 'html'), bytes('x'), meta);
    await store.put(ref('b', V1, 'html'), bytes('x'), meta);
    await raw.put('p/library/doc.txt', bytes('x'), { contentType: 'text/plain' }); // not ours
    const seen: unknown[] = [];
    for await (const item of store.inventory()) seen.push(item);
    expect(seen).toEqual([
      { reportId: 'a', version: V1, lastModified: 5000 },
      { reportId: 'a', version: V2, lastModified: 2000 },
      { reportId: 'b', version: V1, lastModified: 2000 },
    ]);
  });

  it('surfaces an outage as ObjectStoreUnavailableError', async () => {
    const raw = new MemoryObjectStore();
    const store = new ObjectReportArtifactStore(raw);
    raw.fail('MinIO caiu');
    await expect(store.read(ref('r', V1))).rejects.toBeInstanceOf(ObjectStoreUnavailableError);
    await expect(store.put(ref('r', V1), bytes('x'), meta)).rejects.toBeInstanceOf(
      ObjectStoreUnavailableError,
    );
    await expect(store.deleteReport('r')).rejects.toBeInstanceOf(ObjectStoreUnavailableError);
  });
});
