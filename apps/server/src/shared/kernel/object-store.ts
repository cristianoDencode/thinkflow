import { DomainError } from './errors';

/**
 * Generic object storage port (S3-like: flat keys, whole-object writes).
 * Contexts build their own semantic stores (e.g. report artifacts) on top of it.
 */
export type StorageDriver = 'local' | 's3' | 'memory';

export interface ObjectPutOptions {
  contentType: string;
  /** ASCII only; S3 sends it as x-amz-meta-*; the local driver ignores it. */
  metadata?: Record<string, string>;
  /** Overrides the store-wide limit (STORAGE_MAX_OBJECT_MB) for this write. */
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface ObjectInfo {
  key: string;
  size: number;
  contentType: string | null;
  /** Epoch ms. */
  lastModified: number;
  metadata: Record<string, string>;
}

export interface ObjectReadOptions {
  signal?: AbortSignal;
  /** Overrides the store-wide limit (STORAGE_MAX_OBJECT_MB) for this read. */
  maxBytes?: number;
}

export interface ObjectStream {
  info: ObjectInfo;
  body: AsyncIterable<Uint8Array>;
  /** Frees the underlying socket/file when the body is not consumed to the end. Idempotent. */
  abort(): void;
}

export interface ObjectStoreHealth {
  available: boolean;
  /** pt-BR, secret-free explanation when unavailable. */
  reason: string | null;
  latencyMs: number | null;
}

export interface ObjectStore {
  readonly driver: StorageDriver;
  /** Human location without credentials (path or endpoint/bucket). */
  readonly location: string;
  put(key: string, body: Uint8Array, options: ObjectPutOptions): Promise<void>;
  /** `null` when the key does not exist. */
  getBytes(key: string, options?: ObjectReadOptions): Promise<Uint8Array | null>;
  /** `null` when the key does not exist. The caller must consume the body or call `abort()`. */
  getStream(key: string, options?: ObjectReadOptions): Promise<ObjectStream | null>;
  /** `null` when the key does not exist. */
  head(key: string, options?: { signal?: AbortSignal }): Promise<ObjectInfo | null>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
  /** Deletes every key starting with `prefix` (must end with '/'); returns how many. */
  deletePrefix(prefix: string): Promise<number>;
  /** Keys starting with `prefix`, in ascending key order. `contentType`/`metadata` may be empty here. */
  list(prefix: string, options?: { signal?: AbortSignal }): AsyncIterable<ObjectInfo>;
  /** Reachability + bucket access (S3: HeadBucket; local: writable dir). Never throws. */
  check(): Promise<ObjectStoreHealth>;
  /** Releases sockets/handles. Optional. */
  close?(): Promise<void> | void;
}

/** 503: storage down, auth/bucket misconfigured, timeout. The message is pt-BR and secret-free. */
export class ObjectStoreUnavailableError extends DomainError {
  constructor(public readonly reason: string) {
    super(`O armazenamento de documentos está indisponível: ${reason}`, 'storage_unavailable', 503);
    this.name = 'ObjectStoreUnavailableError';
  }
}

/** 413: the object is bigger than STORAGE_MAX_OBJECT_MB (or the per-call `maxBytes`). */
export class ObjectTooLargeError extends DomainError {
  constructor(public readonly limitBytes: number) {
    super(
      `O documento excede o tamanho máximo permitido (${formatMegabytes(limitBytes)}).`,
      'storage_object_too_large',
      413,
    );
    this.name = 'ObjectTooLargeError';
  }
}

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}
