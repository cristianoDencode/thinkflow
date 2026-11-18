import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageStatusDto } from '@thinkflow/shared';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { MemoryObjectStore } from '../../src/shared/infrastructure/storage/memory-object-store';
import { S3ObjectStore } from '../../src/shared/infrastructure/storage/s3-object-store';
import { StorageMonitor } from '../../src/shared/infrastructure/storage/storage-monitor';
import { registerStorageRoutes } from '../../src/shared/interface/http/storage-routes';
import { createTestApp, type TestApp } from './test-app';

describe('storage routes', () => {
  let ctx: TestApp | undefined;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  it('requires a session on every route', async () => {
    ctx = await createTestApp();
    for (const [method, url] of [
      ['GET', '/api/storage/status'],
      ['POST', '/api/storage/check'],
      ['POST', '/api/storage/sync'],
    ] as const) {
      const res = await ctx.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('GET /api/storage/status describes the injected store', async () => {
    ctx = await createTestApp();
    const res = await ctx.api<StorageStatusDto>('GET', '/api/storage/status');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      driver: 'memory',
      available: true,
      reason: null,
      location: 'memory://',
      bucket: null,
      prefix: '',
      pendingUploads: 0,
      lastError: null,
    });
    expect(typeof res.json.checkedAt).toBe('number');
  });

  it('reflects an outage after POST /check and recovers', async () => {
    const store = new MemoryObjectStore();
    ctx = await createTestApp({ objectStore: store });
    store.fail('MinIO caiu');
    const down = await ctx.api<StorageStatusDto>('POST', '/api/storage/check');
    expect(down.status).toBe(200);
    expect(down.json).toMatchObject({ available: false, reason: 'MinIO caiu', latencyMs: null });
    // status is served from the (fresh) cache
    expect((await ctx.api<StorageStatusDto>('GET', '/api/storage/status')).json.available).toBe(
      false,
    );
    store.fail(null);
    const up = await ctx.api<StorageStatusDto>('POST', '/api/storage/check');
    expect(up.json).toMatchObject({ available: true, reason: null });
  });

  it('exposes the container storage and /api/health stays public and unchanged', async () => {
    const store = new MemoryObjectStore();
    ctx = await createTestApp({ objectStore: store });
    expect(ctx.container.storage.store).toBe(store);
    const health = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(Object.keys(JSON.parse(health.body)).sort()).toEqual(['status', 'uptimeSec', 'version']);
  });

  it('never leaks credentials with the s3 driver', async () => {
    const secret = 'top-secret-s3-key-VALUE-98765';
    const accessKey = 'AKIDACCESSKEY12345';
    const config = {
      ...loadConfig({
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://minio:9000',
        S3_BUCKET: 'thinkflow',
        STORAGE_PREFIX: 'thinkflow/',
        S3_ACCESS_KEY_ID: accessKey,
        S3_SECRET_ACCESS_KEY: secret,
      }),
      webDir: '/nonexistent',
    };
    const store = new S3ObjectStore(
      {
        endpoint: 'http://minio:9000',
        region: 'us-east-1',
        bucket: 'thinkflow',
        accessKeyId: accessKey,
        secretAccessKey: secret,
        forcePathStyle: true,
        timeoutMs: 1000,
        connectTimeoutMs: 1000,
        maxAttempts: 1,
      },
      {
        clientFactory: () => ({
          send: async () => {
            throw Object.assign(new Error(secret), { name: 'InvalidAccessKeyId' });
          },
        }),
      },
    );
    ctx = await createTestApp({ config, objectStore: store });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/storage/check',
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(secret);
    expect(res.body).not.toContain(accessKey);
    expect(JSON.parse(res.body)).toMatchObject({
      driver: 's3',
      available: false,
      reason: 'credenciais inválidas',
      location: 'http://minio:9000/thinkflow',
      bucket: 'thinkflow',
      prefix: 'thinkflow/',
    });
  });
});

describe('registerStorageRoutes callbacks', () => {
  it('reports pending uploads and last error, and /sync flushes in the background', async () => {
    const app = Fastify();
    const flush = vi.fn(async () => undefined);
    const store = new MemoryObjectStore();
    registerStorageRoutes(app, {
      store,
      monitor: new StorageMonitor(store),
      guard: async () => undefined,
      bucket: null,
      prefix: '',
      pending: async () => 3,
      lastError: () => 'Falha ao enviar o relatório.',
      flush,
    });
    const status = await app.inject({ method: 'GET', url: '/api/storage/status' });
    expect(JSON.parse(status.body)).toMatchObject({
      pendingUploads: 3,
      lastError: 'Falha ao enviar o relatório.',
    });
    const sync = await app.inject({ method: 'POST', url: '/api/storage/sync' });
    expect(sync.statusCode).toBe(202);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    await app.close();
  });

  it('a failing flush does not fail the request', async () => {
    const app = Fastify();
    const store = new MemoryObjectStore();
    registerStorageRoutes(app, {
      store,
      monitor: new StorageMonitor(store),
      guard: async () => undefined,
      bucket: null,
      prefix: '',
      flush: async () => {
        throw new Error('boom');
      },
    });
    expect((await app.inject({ method: 'POST', url: '/api/storage/sync' })).statusCode).toBe(202);
    await app.close();
  });
});
