import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import {
  ObjectStoreUnavailableError,
  ObjectTooLargeError,
  type ObjectInfo,
  type ObjectPutOptions,
  type ObjectReadOptions,
  type ObjectStore,
  type ObjectStoreHealth,
  type ObjectStream,
} from '../../kernel/object-store';
import {
  DEFAULT_MAX_OBJECT_BYTES,
  assertAsciiMetadata,
  assertObjectKey,
  assertObjectPrefix,
} from './object-keys';

export interface S3ObjectStoreOptions {
  /** Absent = AWS. For MinIO/others: `http(s)://host:port` (no credentials, no path). */
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  sse?: '' | 'AES256' | 'aws:kms';
  sseKmsKeyId?: string | undefined;
  timeoutMs: number;
  connectTimeoutMs: number;
  maxAttempts: number;
  maxObjectBytes?: number;
  /** MaxKeys of each ListObjectsV2 call (default 1000; tests use a small value). */
  listPageSize?: number;
  /** Timeout of `check()` (default 3000 ms). */
  checkTimeoutMs?: number;
}

/** The only part of the SDK client the adapter needs; tests pass a fake. */
export interface S3Sender {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any, options?: { abortSignal?: AbortSignal }): Promise<any>;
  destroy?(): void;
}

export type S3ClientFactory = (config: S3ClientConfig) => S3Sender;

/** Only sanitized fields (error name, HTTP status, request id) are ever logged. */
export interface StorageLogger {
  warn(obj: object, msg: string): void;
}

/** SDK client options. Exported so a test pins the compatibility settings (§2.3 of the plan). */
export function buildS3ClientConfig(options: S3ObjectStoreOptions): S3ClientConfig {
  return {
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    maxAttempts: options.maxAttempts,
    // the default became "WHEN_SUPPORTED" in 3.729 and breaks several S3-compatible servers
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {
      connectionTimeout: options.connectTimeoutMs,
      requestTimeout: options.timeoutMs,
    },
  };
}

/** `endpoint/bucket` without credentials (userinfo is stripped even if someone sneaks it in). */
export function s3Location(endpoint: string | undefined, bucket: string): string {
  if (!endpoint) return `s3://${bucket}`;
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}/${bucket}`;
  } catch {
    return `s3://${bucket}`;
  }
}

type S3ErrorKind =
  'not_found' | 'no_bucket' | 'credentials' | 'denied' | 'timeout' | 'unreachable' | 'other';

interface SdkLikeError {
  name?: string;
  Code?: string;
  code?: string;
  $metadata?: { httpStatusCode?: number; requestId?: string };
  cause?: { code?: string } | undefined;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

function classify(err: unknown): S3ErrorKind {
  const e = (err ?? {}) as SdkLikeError;
  const names = [e.name, e.Code, e.code, e.cause?.code].filter((n): n is string => !!n);
  const status = e.$metadata?.httpStatusCode;
  if (names.includes('NoSuchBucket')) return 'no_bucket';
  if (names.includes('NoSuchKey') || names.includes('NotFound') || status === 404) {
    return 'not_found';
  }
  if (
    names.some((n) =>
      ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidToken', 'ExpiredToken'].includes(n),
    )
  ) {
    return 'credentials';
  }
  if (names.includes('AccessDenied') || status === 403) return 'denied';
  if (
    names.some((n) =>
      ['TimeoutError', 'AbortError', 'RequestTimeout', 'ETIMEDOUT', 'ECONNABORTED'].includes(n),
    )
  ) {
    return 'timeout';
  }
  if (names.some((n) => NETWORK_CODES.has(n)) || (status !== undefined && status >= 500)) {
    return 'unreachable';
  }
  return 'other';
}

/** S3-compatible adapter (MinIO, AWS S3, Garage, RustFS…). Streams, never buffers via the API. */
export class S3ObjectStore implements ObjectStore {
  readonly driver = 's3' as const;
  readonly location: string;
  private readonly client: S3Sender;
  private readonly bucket: string;
  private readonly endpointLabel: string;
  private readonly region: string;
  private readonly sse: '' | 'AES256' | 'aws:kms';
  private readonly sseKmsKeyId: string | undefined;
  private readonly maxObjectBytes: number;
  private readonly listPageSize: number;
  private readonly checkTimeoutMs: number;
  private readonly logger: StorageLogger | undefined;

  // The options (which hold the secret) are deliberately NOT kept on the instance.
  constructor(
    options: S3ObjectStoreOptions,
    deps: { clientFactory?: S3ClientFactory; logger?: StorageLogger } = {},
  ) {
    this.client = (deps.clientFactory ?? ((cfg) => new S3Client(cfg)))(
      buildS3ClientConfig(options),
    );
    this.bucket = options.bucket;
    this.region = options.region;
    this.location = s3Location(options.endpoint, options.bucket);
    this.endpointLabel = options.endpoint
      ? new URL(options.endpoint).host
      : `AWS S3 (${options.region})`;
    this.sse = options.sse ?? '';
    this.sseKmsKeyId = options.sseKmsKeyId;
    this.maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    this.listPageSize = options.listPageSize ?? 1000;
    this.checkTimeoutMs = options.checkTimeoutMs ?? 3000;
    this.logger = deps.logger;
  }

  close(): void {
    this.client.destroy?.();
  }

  /** Never attaches the SDK error (its `$response` may carry request headers). */
  private toUnavailable(err: unknown, operation: string): ObjectStoreUnavailableError {
    const kind = classify(err);
    const e = (err ?? {}) as SdkLikeError;
    this.logger?.warn(
      {
        operation,
        errorName: typeof e.name === 'string' ? e.name : 'Error',
        status: e.$metadata?.httpStatusCode,
        requestId: e.$metadata?.requestId,
      },
      'falha no armazenamento de objetos',
    );
    switch (kind) {
      case 'no_bucket':
        return new ObjectStoreUnavailableError(`o bucket ${this.bucket} não existe`);
      case 'credentials':
        return new ObjectStoreUnavailableError('credenciais inválidas');
      case 'denied':
        return new ObjectStoreUnavailableError(`sem permissão no bucket ${this.bucket}`);
      case 'timeout':
        return new ObjectStoreUnavailableError(
          `tempo esgotado ao falar com o servidor (${this.endpointLabel})`,
        );
      case 'unreachable':
        return new ObjectStoreUnavailableError(`servidor inacessível (${this.endpointLabel})`);
      default:
        return new ObjectStoreUnavailableError(
          `erro inesperado ao falar com o servidor (${this.endpointLabel})`,
        );
    }
  }

  private isMissing(err: unknown): boolean {
    return classify(err) === 'not_found';
  }

  private async send<T>(command: unknown, operation: string, signal?: AbortSignal): Promise<T> {
    try {
      return (await this.client.send(command, signal ? { abortSignal: signal } : undefined)) as T;
    } catch (err) {
      if (err instanceof ObjectStoreUnavailableError || err instanceof ObjectTooLargeError) {
        throw err;
      }
      throw this.toUnavailable(err, operation);
    }
  }

  async put(key: string, body: Uint8Array, options: ObjectPutOptions): Promise<void> {
    assertObjectKey(key);
    assertAsciiMetadata(options.metadata);
    const limit = options.maxBytes ?? this.maxObjectBytes;
    if (body.byteLength > limit) throw new ObjectTooLargeError(limit);
    await this.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.byteLength,
        ContentType: options.contentType,
        ...(options.metadata && Object.keys(options.metadata).length > 0
          ? { Metadata: options.metadata }
          : {}),
        ...(this.sse
          ? {
              ServerSideEncryption: this.sse,
              ...(this.sse === 'aws:kms' && this.sseKmsKeyId
                ? { SSEKMSKeyId: this.sseKmsKeyId }
                : {}),
            }
          : {}),
      }),
      'put',
      options.signal,
    );
  }

  private infoFrom(
    key: string,
    out: {
      ContentLength?: number | undefined;
      ContentType?: string | undefined;
      LastModified?: Date | undefined;
      Metadata?: Record<string, string> | undefined;
    },
  ): ObjectInfo {
    return {
      key,
      size: out.ContentLength ?? 0,
      contentType: out.ContentType ?? null,
      lastModified: out.LastModified ? out.LastModified.getTime() : 0,
      metadata: { ...out.Metadata },
    };
  }

  async head(key: string, options?: { signal?: AbortSignal }): Promise<ObjectInfo | null> {
    assertObjectKey(key);
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        options?.signal ? { abortSignal: options.signal } : undefined,
      );
      return this.infoFrom(key, out);
    } catch (err) {
      if (this.isMissing(err)) return null;
      throw this.toUnavailable(err, 'head');
    }
  }

  async getStream(key: string, options?: ObjectReadOptions): Promise<ObjectStream | null> {
    assertObjectKey(key);
    const limit = options?.maxBytes ?? this.maxObjectBytes;
    const controller = new AbortController();
    const relay = () => controller.abort();
    if (options?.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', relay, { once: true });
    }
    const detach = () => options?.signal?.removeEventListener('abort', relay);

    let out: Awaited<ReturnType<S3Sender['send']>>;
    try {
      out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
        abortSignal: controller.signal,
      });
    } catch (err) {
      detach();
      if (this.isMissing(err)) return null;
      throw this.toUnavailable(err, 'get');
    }

    const source = out.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    const destroy = () => {
      try {
        source?.destroy?.();
      } catch {
        /* already closed */
      }
    };
    const info = this.infoFrom(key, out);
    if (!source) {
      detach();
      return {
        info: { ...info, size: 0 },
        body: (async function* () {})(),
        abort: () => undefined,
      };
    }
    if (info.size > limit) {
      detach();
      controller.abort();
      destroy();
      throw new ObjectTooLargeError(limit);
    }

    let finished = false;
    const finish = () => {
      finished = true;
      detach();
    };
    const toUnavailable = (err: unknown) => this.toUnavailable(err, 'get');
    const body = (async function* (): AsyncGenerator<Uint8Array> {
      let total = 0;
      try {
        for await (const chunk of source) {
          total += chunk.byteLength;
          if (total > limit) throw new ObjectTooLargeError(limit);
          yield chunk;
        }
        finish();
      } catch (err) {
        if (err instanceof ObjectTooLargeError) throw err;
        throw toUnavailable(err);
      } finally {
        if (!finished) {
          finish();
          controller.abort();
          destroy();
        }
      }
    })();
    return {
      info,
      body,
      abort: () => {
        if (finished) return;
        finish();
        controller.abort();
        destroy();
      },
    };
  }

  async getBytes(key: string, options?: ObjectReadOptions): Promise<Uint8Array | null> {
    const stream = await this.getStream(key, options);
    if (!stream) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream.body) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (this.isMissing(err)) return;
      throw this.toUnavailable(err, 'delete');
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    assertObjectPrefix(prefix, { requireSlash: true });
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.send<{
        Contents?: { Key?: string }[];
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      }>(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ...(token ? { ContinuationToken: token } : {}),
        }),
        'list',
      );
      const keys = (page.Contents ?? []).map((c) => c.Key).filter((k): k is string => !!k);
      if (keys.length > 0) {
        const res = await this.send<{ Deleted?: unknown[]; Errors?: unknown[] }>(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: false },
          }),
          'delete-batch',
        );
        const failed = res.Errors?.length ?? 0;
        if (failed > 0) {
          throw new ObjectStoreUnavailableError(`falha ao excluir ${failed} objeto(s) no bucket`);
        }
        deleted += res.Deleted?.length ?? keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  async *list(prefix: string, options?: { signal?: AbortSignal }): AsyncIterable<ObjectInfo> {
    assertObjectPrefix(prefix);
    let token: string | undefined;
    do {
      const page = await this.send<{
        Contents?: { Key?: string; Size?: number; LastModified?: Date }[];
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      }>(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ...(prefix ? { Prefix: prefix } : {}),
          MaxKeys: this.listPageSize,
          ...(token ? { ContinuationToken: token } : {}),
        }),
        'list',
        options?.signal,
      );
      for (const item of page.Contents ?? []) {
        if (!item.Key) continue;
        yield {
          key: item.Key,
          size: item.Size ?? 0,
          contentType: null,
          lastModified: item.LastModified ? item.LastModified.getTime() : 0,
          metadata: {},
        };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async check(): Promise<ObjectStoreHealth> {
    const started = Date.now();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
        abortSignal: AbortSignal.timeout(this.checkTimeoutMs),
      });
      return { available: true, reason: null, latencyMs: Date.now() - started };
    } catch (err) {
      // HeadBucket has no body: a 404 means the bucket is missing
      const kind = classify(err);
      const unavailable =
        kind === 'not_found'
          ? new ObjectStoreUnavailableError(`o bucket ${this.bucket} não existe`)
          : this.toUnavailable(err, 'check');
      return { available: false, reason: unavailable.reason, latencyMs: null };
    }
  }

  /** Startup helper for `S3_CREATE_BUCKET=true`: HeadBucket and, on 404, CreateBucket. */
  async ensureBucket(): Promise<'exists' | 'created'> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return 'exists';
    } catch (err) {
      if (classify(err) !== 'not_found') throw this.toUnavailable(err, 'ensure-bucket');
    }
    try {
      await this.client.send(
        new CreateBucketCommand({
          Bucket: this.bucket,
          ...(this.region !== 'us-east-1'
            ? { CreateBucketConfiguration: { LocationConstraint: this.region as never } }
            : {}),
        }),
      );
      return 'created';
    } catch (err) {
      const e = (err ?? {}) as SdkLikeError;
      if (e.name === 'BucketAlreadyOwnedByYou' || e.name === 'BucketAlreadyExists') return 'exists';
      throw this.toUnavailable(err, 'create-bucket');
    }
  }
}
