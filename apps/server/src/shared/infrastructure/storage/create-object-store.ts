import type { ObjectStore } from '../../kernel/object-store';
import type { StorageConfig } from '../config';
import { LocalObjectStore } from './local-object-store';
import { S3ObjectStore, type S3ClientFactory, type StorageLogger } from './s3-object-store';

export interface CreateObjectStoreDeps {
  logger?: StorageLogger;
  /** Replaces the SDK client (tests). */
  clientFactory?: S3ClientFactory;
  /** MINIO_ROOT_USER of this environment, to warn when the app runs as the server's root user. */
  rootUser?: string | undefined;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** A name without dots (a compose/k8s service such as `minio`) or a private/loopback address. */
function isInternalHost(hostname: string): boolean {
  if (LOOPBACK.has(hostname)) return true;
  if (!hostname.includes('.') && !hostname.includes(':')) return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(hostname);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

/** Builds the configured adapter. Never contacts the server (see `prepareObjectStore`). */
export function createObjectStore(
  config: StorageConfig,
  deps: CreateObjectStoreDeps = {},
): ObjectStore {
  if (config.driver === 'local') {
    return new LocalObjectStore(config.dir, { maxObjectBytes: config.maxObjectBytes });
  }
  if (config.endpoint) {
    const url = new URL(config.endpoint);
    if (url.protocol === 'http:' && !isInternalHost(url.hostname)) {
      deps.logger?.warn(
        { endpoint: `${url.protocol}//${url.host}` },
        'S3_ENDPOINT usa http:// fora da rede local: o tráfego e as credenciais não são cifrados. Prefira https://.',
      );
    }
  }
  if (deps.rootUser && config.accessKeyId === deps.rootUser) {
    deps.logger?.warn(
      {},
      'S3_ACCESS_KEY_ID é igual a MINIO_ROOT_USER: a aplicação não deveria usar o usuário root do servidor. Crie um usuário com a política mínima.',
    );
  }
  return new S3ObjectStore(
    {
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      forcePathStyle: config.forcePathStyle,
      sse: config.sse,
      sseKmsKeyId: config.sseKmsKeyId,
      timeoutMs: config.timeoutMs,
      connectTimeoutMs: config.connectTimeoutMs,
      maxAttempts: config.maxAttempts,
      maxObjectBytes: config.maxObjectBytes,
    },
    {
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.clientFactory ? { clientFactory: deps.clientFactory } : {}),
    },
  );
}

/**
 * Startup step: with `S3_CREATE_BUCKET=true` creates the bucket when missing. Failures are
 * logged, never thrown (the server boots degraded when the storage is down).
 */
export async function prepareObjectStore(
  store: ObjectStore,
  config: StorageConfig,
  logger?: StorageLogger,
): Promise<void> {
  if (config.driver !== 's3' || !config.createBucket || !(store instanceof S3ObjectStore)) return;
  try {
    await store.ensureBucket();
  } catch (err) {
    logger?.warn(
      { reason: err instanceof Error ? err.message : 'erro desconhecido' },
      'não foi possível preparar o bucket (S3_CREATE_BUCKET)',
    );
  }
}
