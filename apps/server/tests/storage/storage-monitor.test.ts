import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../src/shared/kernel/clock';
import { MemoryObjectStore } from '../../src/shared/infrastructure/storage/memory-object-store';
import { StorageMonitor } from '../../src/shared/infrastructure/storage/storage-monitor';
import { createObjectStore } from '../../src/shared/infrastructure/storage/create-object-store';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { LocalObjectStore } from '../../src/shared/infrastructure/storage/local-object-store';
import { S3ObjectStore } from '../../src/shared/infrastructure/storage/s3-object-store';

describe('StorageMonitor', () => {
  it('caches the check for the TTL, refresh() bypasses it and logs transitions once', async () => {
    const store = new MemoryObjectStore();
    const check = vi.spyOn(store, 'check');
    const clock = new FakeClock(1000);
    const warn = vi.fn();
    const monitor = new StorageMonitor(store, { clock, ttlMs: 15_000, logger: { warn } });

    expect(monitor.last()).toBeNull();
    const first = await monitor.status();
    expect(first).toMatchObject({ available: true, checkedAt: 1000 });
    await monitor.status();
    expect(check).toHaveBeenCalledTimes(1);

    store.fail('fora do ar');
    clock.advance(14_000);
    expect((await monitor.status()).available).toBe(true); // still cached
    clock.advance(2_000);
    expect(await monitor.status()).toMatchObject({ available: false, reason: 'fora do ar' });
    await monitor.refresh();
    expect(warn).toHaveBeenCalledTimes(1);

    store.fail(null);
    expect((await monitor.refresh()).available).toBe(true);
  });

  it('shares concurrent refreshes and survives a throwing store', async () => {
    const store = new MemoryObjectStore();
    const check = vi.spyOn(store, 'check').mockRejectedValue(new Error('inesperado'));
    const monitor = new StorageMonitor(store);
    const [a, b] = await Promise.all([monitor.refresh(), monitor.refresh()]);
    expect(a).toBe(b);
    expect(check).toHaveBeenCalledTimes(1);
    expect(a.available).toBe(false);
  });
});

describe('createObjectStore', () => {
  it('builds the adapter for the configured driver', () => {
    const local = createObjectStore(loadConfig({ DATA_DIR: '/tmp/x' }).storage);
    expect(local).toBeInstanceOf(LocalObjectStore);
    expect(local.location).toBe(path.resolve('/tmp/x/objects'));
    const s3 = createObjectStore(
      loadConfig({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://minio:9000',
        S3_BUCKET: 'thinkflow',
        S3_ACCESS_KEY_ID: 'app',
        S3_SECRET_ACCESS_KEY: 'secret-value',
      }).storage,
    );
    expect(s3).toBeInstanceOf(S3ObjectStore);
    expect(s3.location).toBe('http://minio:9000/thinkflow');
  });

  it('warns about plain http outside the local network and about the root user', () => {
    const env = (endpoint: string, accessKey = 'app') => ({
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: endpoint,
      S3_BUCKET: 'thinkflow',
      S3_ACCESS_KEY_ID: accessKey,
      S3_SECRET_ACCESS_KEY: 'secret-value',
    });
    const warnings = (endpoint: string, accessKey?: string, rootUser?: string) => {
      const warn = vi.fn();
      createObjectStore(loadConfig(env(endpoint, accessKey)).storage, {
        logger: { warn },
        rootUser,
      });
      return warn.mock.calls.map((c) => c[1] as string);
    };
    expect(warnings('http://minio:9000')).toEqual([]);
    expect(warnings('http://127.0.0.1:9000')).toEqual([]);
    expect(warnings('http://192.168.1.10:9000')).toEqual([]);
    expect(warnings('https://s3.example.com')).toEqual([]);
    expect(warnings('http://s3.example.com:9000')).toEqual([expect.stringMatching(/http:\/\//)]);
    expect(warnings('http://minio:9000', 'root', 'root')).toEqual([
      expect.stringMatching(/MINIO_ROOT_USER/),
    ]);
    // the warnings never carry the secret
    expect(JSON.stringify(warnings('http://s3.example.com:9000'))).not.toContain('secret-value');
  });
});
