import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DiagramService } from '../../application/diagram-service';

export interface DiagramRoutesDeps {
  service: DiagramService;
  guard: preHandlerHookHandler;
}

export function registerDiagramRoutes(app: FastifyInstance, deps: DiagramRoutesDeps): void {
  app.post('/api/diagrams/repair', { preHandler: deps.guard }, async (request) => {
    const controller = new AbortController();
    request.raw.once('close', () => {
      if (!request.raw.complete) controller.abort();
    });
    return deps.service.repairForChat(request.body, controller.signal);
  });
}
