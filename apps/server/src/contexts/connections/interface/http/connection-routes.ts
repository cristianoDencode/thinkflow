import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { RequestLogDto } from '@thinkflow/shared';
import type { ConnectionService } from '../../application/connection-service';
import type { RequestLogRepository } from '../../../routing/domain/ports';

type IdParams = { Params: { id: string } };

export function registerConnectionRoutes(
  app: FastifyInstance,
  deps: { service: ConnectionService; logs: RequestLogRepository; guard: preHandlerHookHandler },
): void {
  const { service, logs } = deps;
  const opts = { preHandler: deps.guard };

  app.get('/api/providers', opts, async () => service.listProviders());

  app.get('/api/connections', opts, async () => service.list());
  app.post('/api/connections', opts, async (request, reply) =>
    reply.status(201).send(await service.create(request.body)),
  );
  app.put<IdParams>('/api/connections/:id', opts, async (request) =>
    service.update(request.params.id, request.body),
  );
  app.delete<IdParams>('/api/connections/:id', opts, async (request) => {
    await service.delete(request.params.id);
    return { ok: true };
  });
  app.post<IdParams>('/api/connections/:id/test', opts, async (request) =>
    service.test(request.params.id),
  );
  app.post<IdParams>('/api/connections/:id/reset', opts, async (request) =>
    service.resetCooldown(request.params.id),
  );
  app.get<IdParams>('/api/connections/:id/models', opts, async (request) =>
    service.listModels(request.params.id),
  );

  app.get('/api/combos', opts, async () => service.listCombos());
  app.post('/api/combos', opts, async (request, reply) =>
    reply.status(201).send(await service.createCombo(request.body)),
  );
  app.put<IdParams>('/api/combos/:id', opts, async (request) =>
    service.updateCombo(request.params.id, request.body),
  );
  app.delete<IdParams>('/api/combos/:id', opts, async (request) => {
    await service.deleteCombo(request.params.id);
    return { ok: true };
  });

  app.get('/api/models', opts, async () => service.modelOptions());

  app.get<{ Querystring: { limit?: string } }>(
    '/api/logs',
    opts,
    async (request): Promise<RequestLogDto[]> => {
      const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 500);
      return logs.list(limit);
    },
  );
}
