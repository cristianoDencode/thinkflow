import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { S3ObjectStore } from '../../src/shared/infrastructure/storage/s3-object-store';
import { scopeObjectStore } from '../../src/shared/kernel/scoped-object-store';
import { describeObjectStoreContract } from './object-store-contract';

// Real MinIO / S3: opt-in (RUN_MINIO_TESTS=1), like RUN_CHROMIUM_TESTS.
//   S3_TEST_ENDPOINT, S3_TEST_BUCKET (must exist), S3_TEST_ACCESS_KEY_ID, S3_TEST_SECRET_ACCESS_KEY
// Every run uses a unique key prefix and removes it afterwards.
const enabled = !!process.env.RUN_MINIO_TESTS;

function makeStore(listPageSize: number): S3ObjectStore {
  return new S3ObjectStore({
    endpoint: process.env.S3_TEST_ENDPOINT,
    region: process.env.S3_TEST_REGION ?? 'us-east-1',
    bucket: process.env.S3_TEST_BUCKET ?? 'thinkflow-test',
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: true,
    timeoutMs: 15_000,
    connectTimeoutMs: 3_000,
    maxAttempts: 2,
    listPageSize,
  });
}

describe.skipIf(!enabled)('real S3/MinIO (RUN_MINIO_TESTS=1)', () => {
  describeObjectStoreContract('s3', async ({ listPageSize }) => {
    const store = makeStore(listPageSize);
    const keyPrefix = `contract-${randomUUID()}/`;
    return {
      store,
      keyPrefix,
      supportsMetadata: true,
      cleanup: async () => {
        await store.deletePrefix(keyPrefix);
        store.close();
      },
    };
  });

  // the per-module namespace (library/, reports/…) on a real bucket
  describeObjectStoreContract('s3 scoped', async ({ listPageSize }) => {
    const inner = makeStore(listPageSize);
    const prefix = `contract-${randomUUID()}/`;
    return {
      store: scopeObjectStore(inner, prefix, 'library'),
      keyPrefix: '',
      supportsMetadata: true,
      cleanup: async () => {
        await inner.deletePrefix(prefix);
        inner.close();
      },
    };
  });

  it('reports a missing bucket in pt-BR', async () => {
    const store = new S3ObjectStore({
      endpoint: process.env.S3_TEST_ENDPOINT,
      region: 'us-east-1',
      bucket: `nao-existe-${randomUUID().slice(0, 8)}`,
      accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: true,
      timeoutMs: 15_000,
      connectTimeoutMs: 3_000,
      maxAttempts: 1,
    });
    const health = await store.check();
    expect(health.available).toBe(false);
    expect(health.reason).toMatch(/bucket .* não existe|sem permissão/);
    expect(health.reason).not.toContain(process.env.S3_TEST_SECRET_ACCESS_KEY ?? '\u0000');
    store.close();
  });
});
