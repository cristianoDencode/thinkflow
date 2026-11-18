import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { McpService } from '../../application/mcp-service';

type IdParams = { Params: { id: string } };

export function registerMcpRoutes(
  app: FastifyInstance,
  deps: { service: McpService; guard: preHandlerHookHandler },
): void {
  const { service } = deps;
  const opts = { preHandler: deps.guard };

  app.get('/api/mcp', opts, async () => service.list());
  app.post('/api/mcp', opts, async (request, reply) =>
    reply.status(201).send(await service.create(request.body)),
  );
  app.put<IdParams>('/api/mcp/:id', opts, async (request) =>
    service.update(request.params.id, request.body),
  );
  app.patch<IdParams>('/api/mcp/:id/enabled', opts, async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    return service.setEnabled(request.params.id, enabled);
  });
  app.delete<IdParams>('/api/mcp/:id', opts, async (request) => {
    await service.delete(request.params.id);
    return { ok: true };
  });
  app.post<IdParams>('/api/mcp/:id/test', opts, async (request) => service.test(request.params.id));
}
