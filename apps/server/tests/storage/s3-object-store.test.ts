import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  ObjectStoreUnavailableError,
  ObjectTooLargeError,
} from '../../src/shared/kernel/object-store';
import {
  S3ObjectStore,
  buildS3ClientConfig,
  s3Location,
  type S3ObjectStoreOptions,
  type S3Sender,
} from '../../src/shared/infrastructure/storage/s3-object-store';

const SECRET = 'sup3r-secret-access-key-VALUE';
const ACCESS = 'AKIATESTACCESSKEY';

const baseOptions: S3ObjectStoreOptions = {
  endpoint: 'http://minio:9000',
  region: 'us-east-1',
  bucket: 'thinkflow',
  accessKeyId: ACCESS,
  secretAccessKey: SECRET,
  forcePathStyle: true,
  timeoutMs: 30_000,
  connectTimeoutMs: 3_000,
  maxAttempts: 3,
};

interface Call {
  name: string;
  input: Record<string, unknown>;
  abortSignal?: AbortSignal | undefined;
}

function sdkError(name: string, status?: number, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${name} (${SECRET})`), {
    name,
    ...(status ? { $metadata: { httpStatusCode: status, requestId: 'REQ1' } } : {}),
    $response: { headers: { authorization: SECRET } },
    ...extra,
  });
}

/** Scripted client: `handler` answers by command name; every call is recorded. */
function fakeClient(
  handler: (call: Call) => unknown,
): S3Sender & { calls: Call[]; config: unknown; destroyed: boolean } {
  const calls: Call[] = [];
  const client = {
    calls,
    config: undefined as unknown,
    destroyed: false,
    async send(
      command: { constructor: { name: string }; input: Record<string, unknown> },
      opts?: { abortSignal?: AbortSignal },
    ) {
      const call: Call = {
        name: command.constructor.name.replace(/Command$/, ''),
        input: command.input,
        abortSignal: opts?.abortSignal,
      };
      calls.push(call);
      const out = handler(call);
      if (out instanceof Error) throw out;
      return out;
    },
    destroy() {
      client.destroyed = true;
    },
  };
  return client;
}

function makeStore(
  handler: (call: Call) => unknown,
  options: Partial<S3ObjectStoreOptions> = {},
  logger?: { warn: (obj: object, msg: string) => void },
) {
  const client = fakeClient(handler);
  const store = new S3ObjectStore(
    { ...baseOptions, ...options },
    {
      clientFactory: (config) => {
        client.config = config;
        return client;
      },
      ...(logger ? { logger } : {}),
    },
  );
  return { store, client };
}

describe('S3ObjectStore: client options', () => {
  it('uses path-style, WHEN_REQUIRED checksums, timeouts and retries', () => {
    const { client } = makeStore(() => ({}));
    expect(client.config).toMatchObject({
      endpoint: 'http://minio:9000',
      region: 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 3,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: { connectionTimeout: 3000, requestTimeout: 30000 },
      credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
    });
  });

  it('omits the endpoint for AWS', () => {
    const config = buildS3ClientConfig({
      ...baseOptions,
      endpoint: undefined,
      forcePathStyle: false,
    });
    expect(config).not.toHaveProperty('endpoint');
    expect(config.forcePathStyle).toBe(false);
  });

  it('exposes a location without credentials', () => {
    expect(s3Location('http://user:pw@minio:9000/', 'b')).toBe('http://minio:9000/b');
    expect(s3Location(undefined, 'b')).toBe('s3://b');
    expect(makeStore(() => ({})).store.location).toBe('http://minio:9000/thinkflow');
  });

  it('close() destroys the SDK client', () => {
    const { store, client } = makeStore(() => ({}));
    store.close();
    expect(client.destroyed).toBe(true);
  });
});

describe('S3ObjectStore: put', () => {
  it('sends length, content type and metadata', async () => {
    const { store, client } = makeStore(() => ({}));
    await store.put('reports/r1/v/report.html', new Uint8Array([1, 2, 3]), {
      contentType: 'text/html; charset=utf-8',
      metadata: { app: 'thinkflow' },
    });
    expect(client.calls[0]).toMatchObject({
      name: 'PutObject',
      input: {
        Bucket: 'thinkflow',
        Key: 'reports/r1/v/report.html',
        ContentLength: 3,
        ContentType: 'text/html; charset=utf-8',
        Metadata: { app: 'thinkflow' },
      },
    });
    expect(client.calls[0]!.input).not.toHaveProperty('ServerSideEncryption');
  });

  it('adds server-side encryption when configured', async () => {
    const kms = makeStore(() => ({}), { sse: 'aws:kms', sseKmsKeyId: 'key-1' });
    await kms.store.put('a/b.md', new Uint8Array(), { contentType: 'text/markdown' });
    expect(kms.client.calls[0]!.input).toMatchObject({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'key-1',
    });
    const aes = makeStore(() => ({}), { sse: 'AES256' });
    await aes.store.put('a/b.md', new Uint8Array(), { contentType: 'text/markdown' });
    expect(aes.client.calls[0]!.input).toMatchObject({ ServerSideEncryption: 'AES256' });
    expect(aes.client.calls[0]!.input).not.toHaveProperty('SSEKMSKeyId');
  });

  it('refuses oversized bodies before touching the network', async () => {
    const { store, client } = makeStore(() => ({}), { maxObjectBytes: 4 });
    await expect(
      store.put('a/b.md', new Uint8Array(5), { contentType: 'text/markdown' }),
    ).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(client.calls).toHaveLength(0);
  });
});

describe('S3ObjectStore: error mapping', () => {
  const cases: [string, Error, RegExp][] = [
    [
      'ECONNREFUSED',
      sdkError('Error', undefined, { code: 'ECONNREFUSED' }),
      /servidor inacessível \(minio:9000\)/,
    ],
    [
      'ENOTFOUND via cause',
      sdkError('TypeError', undefined, { cause: { code: 'ENOTFOUND' } }),
      /servidor inacessível/,
    ],
    ['HTTP 503', sdkError('ServiceUnavailable', 503), /servidor inacessível/],
    ['HTTP 500', sdkError('InternalError', 500), /servidor inacessível/],
    ['TimeoutError', sdkError('TimeoutError'), /tempo esgotado/],
    ['AbortError', sdkError('AbortError'), /tempo esgotado/],
    ['ETIMEDOUT', sdkError('Error', undefined, { code: 'ETIMEDOUT' }), /tempo esgotado/],
    ['InvalidAccessKeyId', sdkError('InvalidAccessKeyId', 403), /credenciais inválidas/],
    ['SignatureDoesNotMatch', sdkError('SignatureDoesNotMatch', 403), /credenciais inválidas/],
    ['AccessDenied', sdkError('AccessDenied', 403), /sem permissão no bucket thinkflow/],
    ['NoSuchBucket', sdkError('NoSuchBucket', 404), /o bucket thinkflow não existe/],
    ['unknown', sdkError('Weird'), /erro inesperado/],
  ];

  it.each(cases)(
    '%s becomes ObjectStoreUnavailableError in pt-BR without secrets',
    async (_n, error, pattern) => {
      const warn = vi.fn();
      const { store } = makeStore(() => error, {}, { warn });
      const err = await store.getBytes('a/b.md').then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ObjectStoreUnavailableError);
      const unavailable = err as ObjectStoreUnavailableError;
      expect(unavailable.httpStatus).toBe(503);
      expect(unavailable.code).toBe('storage_unavailable');
      expect(unavailable.message).toMatch(pattern);
      expect(unavailable.message).not.toContain(SECRET);
      expect(JSON.stringify(unavailable)).not.toContain(SECRET);
      expect(inspect(unavailable, { depth: 6 })).not.toContain(SECRET);
      expect(unavailable.cause).toBeUndefined();
      // the log carries only sanitized fields
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
      expect(warn).toHaveBeenCalled();
    },
  );

  it('maps missing keys to null for get, head and delete', async () => {
    for (const name of ['NoSuchKey', 'NotFound']) {
      const { store } = makeStore(() => sdkError(name, 404));
      expect(await store.getBytes('a/b.md')).toBeNull();
      expect(await store.getStream('a/b.md')).toBeNull();
      expect(await store.head('a/b.md')).toBeNull();
      await expect(store.delete('a/b.md')).resolves.toBeUndefined();
    }
  });

  it('check() never throws and explains the failure', async () => {
    const down = makeStore(() => sdkError('Error', undefined, { code: 'ECONNREFUSED' }));
    expect(await down.store.check()).toEqual({
      available: false,
      reason: 'servidor inacessível (minio:9000)',
      latencyMs: null,
    });
    const noBucket = makeStore(() => sdkError('NotFound', 404));
    expect((await noBucket.store.check()).reason).toBe('o bucket thinkflow não existe');
    const ok = makeStore(() => ({}));
    const health = await ok.store.check();
    expect(health).toMatchObject({ available: true, reason: null });
    expect(ok.client.calls[0]!.name).toBe('HeadBucket');
    expect(ok.client.calls[0]!.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('never exposes credentials through the instance', () => {
    // a client that, like the real SDK one, does not expose the plain secret
    const store = new S3ObjectStore(baseOptions, {
      clientFactory: () => ({ send: async () => ({}) }),
    });
    expect(JSON.stringify(store)).not.toContain(SECRET);
    expect(inspect(store, { depth: 6 })).not.toContain(SECRET);
    expect(String(store.location)).not.toContain(ACCESS);
  });
});

describe('S3ObjectStore: deletePrefix and list', () => {
  it('deletes in batches of 1000 and counts', async () => {
    const all = Array.from({ length: 2500 }, (_, i) => `reports/r1/${i}`);
    const { store, client } = makeStore((call) => {
      if (call.name === 'ListObjectsV2') {
        const start = Number(call.input.ContinuationToken ?? 0);
        const slice = all.slice(start, start + 1000);
        const next = start + 1000;
        return {
          Contents: slice.map((Key) => ({ Key })),
          IsTruncated: next < all.length,
          NextContinuationToken: String(next),
        };
      }
      if (call.name === 'DeleteObjects') {
        const objects = (call.input.Delete as { Objects: { Key: string }[] }).Objects;
        return { Deleted: objects.map((o) => ({ Key: o.Key })) };
      }
      return {};
    });
    expect(await store.deletePrefix('reports/r1/')).toBe(2500);
    const deletes = client.calls.filter((c) => c.name === 'DeleteObjects');
    expect(deletes.map((c) => (c.input.Delete as { Objects: unknown[] }).Objects.length)).toEqual([
      1000, 1000, 500,
    ]);
    expect(client.calls.find((c) => c.name === 'ListObjectsV2')!.input).toMatchObject({
      Prefix: 'reports/r1/',
    });
  });

  it('fails when the server reports per-object errors', async () => {
    const { store } = makeStore((call) => {
      if (call.name === 'ListObjectsV2') return { Contents: [{ Key: 'a/1' }, { Key: 'a/2' }] };
      return { Deleted: [{ Key: 'a/1' }], Errors: [{ Key: 'a/2', Code: 'AccessDenied' }] };
    });
    await expect(store.deletePrefix('a/')).rejects.toThrow(/falha ao excluir 1 objeto/);
  });

  it('rejects dangerous prefixes before any request', async () => {
    const { store, client } = makeStore(() => ({}));
    await expect(store.deletePrefix('')).rejects.toThrow(/inválido/);
    await expect(store.deletePrefix('reports/1')).rejects.toThrow(/inválido/);
    expect(client.calls).toHaveLength(0);
  });

  it('paginates list with ContinuationToken and the configured page size', async () => {
    const pages: Record<string, unknown> = {
      first: {
        Contents: [{ Key: 'p/a', Size: 1, LastModified: new Date(5) }],
        IsTruncated: true,
        NextContinuationToken: 'T1',
      },
      T1: { Contents: [{ Key: 'p/b', Size: 2 }], IsTruncated: false },
    };
    const { store, client } = makeStore(
      (call) => pages[(call.input.ContinuationToken as string | undefined) ?? 'first'],
      { listPageSize: 1 },
    );
    const got = [];
    for await (const info of store.list('p/')) got.push(info);
    expect(got.map((i) => [i.key, i.size, i.lastModified])).toEqual([
      ['p/a', 1, 5],
      ['p/b', 2, 0],
    ]);
    expect(client.calls.map((c) => [c.input.MaxKeys, c.input.ContinuationToken])).toEqual([
      [1, undefined],
      [1, 'T1'],
    ]);
  });
});

describe('S3ObjectStore: streaming', () => {
  function getHandler(body: Readable, length = 3) {
    return (call: Call) =>
      call.name === 'GetObject'
        ? {
            Body: body,
            ContentLength: length,
            ContentType: 'application/pdf',
            LastModified: new Date(7),
            Metadata: { app: 'thinkflow' },
          }
        : {};
  }

  it('streams the body and reports the object info', async () => {
    const body = Readable.from([Buffer.from([1, 2]), Buffer.from([3])]);
    const { store } = makeStore(getHandler(body));
    const stream = await store.getStream('a/b.pdf');
    expect(stream!.info).toEqual({
      key: 'a/b.pdf',
      size: 3,
      contentType: 'application/pdf',
      lastModified: 7,
      metadata: { app: 'thinkflow' },
    });
    const parts: number[] = [];
    for await (const chunk of stream!.body) parts.push(...chunk);
    expect(parts).toEqual([1, 2, 3]);
  });

  it('abort() destroys the body and aborts the request', async () => {
    const body = new Readable({ read() {} });
    const { store, client } = makeStore(getHandler(body));
    const stream = await store.getStream('a/b.pdf');
    stream!.abort();
    expect(body.destroyed).toBe(true);
    expect(client.calls[0]!.abortSignal!.aborted).toBe(true);
    stream!.abort();
  });

  it('breaking out of the iteration releases the socket', async () => {
    const body = new Readable({ read() {} });
    body.push(Buffer.from([1]));
    const { store, client } = makeStore(getHandler(body, 100));
    const stream = await store.getStream('a/b.pdf');
    for await (const _chunk of stream!.body) break;
    expect(body.destroyed).toBe(true);
    expect(client.calls[0]!.abortSignal!.aborted).toBe(true);
  });

  it('propagates the caller signal to the request', async () => {
    const body = Readable.from([Buffer.from([1, 2, 3])]);
    const { store, client } = makeStore(getHandler(body));
    const controller = new AbortController();
    const stream = await store.getStream('a/b.pdf', { signal: controller.signal });
    controller.abort();
    expect(client.calls[0]!.abortSignal!.aborted).toBe(true);
    stream!.abort();
  });

  it('rejects by Content-Length without reading, and stops a body that lies', async () => {
    const big = Readable.from([Buffer.alloc(10)]);
    const a = makeStore(getHandler(big, 10), { maxObjectBytes: 5 });
    await expect(a.store.getStream('a/b.pdf')).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(big.destroyed).toBe(true);

    const liar = Readable.from([Buffer.alloc(4), Buffer.alloc(4)]);
    const b = makeStore(getHandler(liar, 3), { maxObjectBytes: 5 });
    await expect(b.store.getBytes('a/b.pdf')).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(liar.destroyed).toBe(true);
  });

  it('getBytes concatenates the chunks', async () => {
    const body = Readable.from([Buffer.from([1, 2]), Buffer.from([3])]);
    const { store } = makeStore(getHandler(body));
    expect([...(await store.getBytes('a/b.pdf'))!]).toEqual([1, 2, 3]);
  });

  it('maps a broken connection while streaming', async () => {
    const body = new Readable({
      read() {
        this.destroy(Object.assign(new Error(SECRET), { code: 'ECONNRESET' }));
      },
    });
    const { store } = makeStore(getHandler(body));
    const err = await store.getBytes('a/b.pdf').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ObjectStoreUnavailableError);
    expect((err as Error).message).not.toContain(SECRET);
  });
});

describe('S3ObjectStore.ensureBucket', () => {
  it('creates the bucket on 404 (with a location constraint outside us-east-1)', async () => {
    const { store, client } = makeStore(
      (call) => (call.name === 'HeadBucket' ? sdkError('NotFound', 404) : {}),
      { region: 'sa-east-1' },
    );
    expect(await store.ensureBucket()).toBe('created');
    expect(client.calls.map((c) => c.name)).toEqual(['HeadBucket', 'CreateBucket']);
    expect(client.calls[1]!.input).toMatchObject({
      Bucket: 'thinkflow',
      CreateBucketConfiguration: { LocationConstraint: 'sa-east-1' },
    });
  });

  it('does nothing when it exists and surfaces other errors', async () => {
    const ok = makeStore(() => ({}));
    expect(await ok.store.ensureBucket()).toBe('exists');
    expect(ok.client.calls).toHaveLength(1);
    const denied = makeStore(() => sdkError('AccessDenied', 403));
    await expect(denied.store.ensureBucket()).rejects.toThrow(/sem permissão/);
  });
});
