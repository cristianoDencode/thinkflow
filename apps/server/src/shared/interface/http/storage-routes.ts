import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { StorageStatusDto } from '@thinkflow/shared';
import type { ObjectStore } from '../../kernel/object-store';
import type { StorageMonitor } from '../../infrastructure/storage/storage-monitor';

export interface StorageRoutesDeps {
  store: ObjectStore;
  monitor: StorageMonitor;
  guard: preHandlerHookHandler;
  /** Bucket name for the s3 driver (null otherwise). */
  bucket: string | null;
  /** Configured key prefix ('' when none). */
  prefix: string;
  /** Uploads still waiting (provided by the contexts that stage documents; default 0). */
  pending?: () => number | Promise<number>;
  /** Last upload error, pt-BR (default none). */
  lastError?: () => string | null | Promise<string | null>;
  /** Retries the pending uploads now; must not throw (default no-op). */
  flush?: () => void | Promise<void>;
}

/** Status of the document storage. Callbacks keep this module free of any context import. */
export function registerStorageRoutes(app: FastifyInstance, deps: StorageRoutesDeps): void {
  const toDto = async (refresh: boolean): Promise<StorageStatusDto> => {
    const health = refresh ? await deps.monitor.refresh() : await deps.monitor.status();
    return {
      driver: deps.store.driver,
      available: health.available,
      reason: health.reason,
      location: deps.store.location,
      bucket: deps.bucket,
      prefix: deps.prefix,
      checkedAt: health.checkedAt,
      latencyMs: health.latencyMs,
      pendingUploads: (await deps.pending?.()) ?? 0,
      lastError: (await deps.lastError?.()) ?? null,
    };
  };

  app.get('/api/storage/status', { preHandler: deps.guard }, () => toDto(false));

  // "Testar conexão": forces a new check instead of using the cached one
  app.post('/api/storage/check', { preHandler: deps.guard }, () => toDto(true));

  // "Reenviar pendentes": fire and forget
  app.post('/api/storage/sync', { preHandler: deps.guard }, async (_request, reply) => {
    void Promise.resolve()
      .then(() => deps.flush?.())
      .catch((err: unknown) => app.log.warn({ err }, 'reenvio de documentos pendentes falhou'));
    return reply.status(202).send({ accepted: true });
  });
}
