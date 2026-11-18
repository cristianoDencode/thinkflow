import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ObjectStoreUnavailableError } from '../../src/shared/kernel/object-store';
import { LocalObjectStore } from '../../src/shared/infrastructure/storage/local-object-store';
import { MemoryObjectStore } from '../../src/shared/infrastructure/storage/memory-object-store';
import { describeObjectStoreContract } from './object-store-contract';

describeObjectStoreContract('memory', async () => ({
  store: new MemoryObjectStore(),
  keyPrefix: '',
  supportsMetadata: true,
  cleanup: async () => undefined,
}));

describeObjectStoreContract('local', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-objects-'));
  return {
    store: new LocalObjectStore(dir),
    keyPrefix: '',
    supportsMetadata: false,
    cleanup: async () => fs.rmSync(dir, { recursive: true, force: true }),
  };
});

describe('MemoryObjectStore', () => {
  it('fail() simulates an outage and restores', async () => {
    const store = new MemoryObjectStore();
    await store.put('a/b.md', new Uint8Array([1]), { contentType: 'text/markdown' });
    store.fail('MinIO caiu');
    await expect(store.getBytes('a/b.md')).rejects.toBeInstanceOf(ObjectStoreUnavailableError);
    await expect(store.put('a/c.md', new Uint8Array(), { contentType: 'x' })).rejects.toThrow(
      /MinIO caiu/,
    );
    expect(await store.check()).toEqual({
      available: false,
      reason: 'MinIO caiu',
      latencyMs: null,
    });
    store.fail(null);
    expect((await store.getBytes('a/b.md'))!.byteLength).toBe(1);
    expect((await store.check()).available).toBe(true);
  });

  it('keeps independent copies of the bytes and honors the injected clock', async () => {
    let now = 1000;
    const store = new MemoryObjectStore({ now: () => now });
    const bytes = new Uint8Array([1, 2, 3]);
    await store.put('k/a.md', bytes, { contentType: 'text/markdown' });
    bytes[0] = 9;
    expect((await store.getBytes('k/a.md'))![0]).toBe(1);
    expect((await store.head('k/a.md'))!.lastModified).toBe(1000);
    now = 5000;
    store.touch('k/a.md', 42);
    expect((await store.head('k/a.md'))!.lastModified).toBe(42);
  });
});

describe('LocalObjectStore', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-objects-'));

  it('writes private files atomically under the root and ignores temp files when listing', async () => {
    const dir = tmp();
    const store = new LocalObjectStore(dir);
    await store.put('reports/r1/v1/report.html', new Uint8Array([1]), { contentType: 'text/html' });
    const file = path.join(dir, 'reports', 'r1', 'v1', 'report.html');
    // POSIX permission bits are not enforced on Windows
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    // a leftover temp file from a crashed write never appears as an object
    fs.writeFileSync(path.join(dir, '.tmp', 'leftover'), 'x');
    const keys: string[] = [];
    for await (const info of store.list('')) keys.push(info.key);
    expect(keys).toEqual(['reports/r1/v1/report.html']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('removes empty directories after delete and deletePrefix', async () => {
    const dir = tmp();
    const store = new LocalObjectStore(dir);
    await store.put('reports/r1/v1/report.html', new Uint8Array([1]), { contentType: 'text/html' });
    await store.delete('reports/r1/v1/report.html');
    expect(fs.existsSync(path.join(dir, 'reports'))).toBe(false);
    await store.put('reports/r2/v1/report.md', new Uint8Array([1]), { contentType: 'text/html' });
    expect(await store.deletePrefix('reports/r2/')).toBe(1);
    expect(fs.existsSync(path.join(dir, 'reports'))).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('treats a directory as a missing object and refuses key conflicts', async () => {
    const dir = tmp();
    const store = new LocalObjectStore(dir);
    await store.put('a/b/c.md', new Uint8Array([1]), { contentType: 'text/markdown' });
    expect(await store.getBytes('a/b')).toBeNull();
    expect(await store.head('a/b/c.md/deeper')).toBeNull();
    await expect(
      store.put('a/b/c.md/deeper', new Uint8Array([1]), { contentType: 'x' }),
    ).rejects.toThrow(/Conflito/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deduces the content type from the extension', async () => {
    const dir = tmp();
    const store = new LocalObjectStore(dir);
    await store.put('x/a.html', new Uint8Array([1]), { contentType: 'text/html; charset=utf-8' });
    await store.put('x/b.bin', new Uint8Array([1]), { contentType: 'application/octet-stream' });
    expect((await store.head('x/a.html'))!.contentType).toBe('text/html; charset=utf-8');
    expect((await store.head('x/b.bin'))!.contentType).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('check() reports an unusable root without throwing', async () => {
    const dir = tmp();
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const health = await new LocalObjectStore(path.join(blocker, 'objects')).check();
    expect(health.available).toBe(false);
    expect(health.reason).toMatch(/disco/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
