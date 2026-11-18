import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { templateListQuerySchema } from '@thinkflow/shared';
import type { TemplateAssistant } from '../../application/template-assistant';
import type { TemplateService } from '../../application/template-service';

export interface TemplateRoutesDeps {
  service: TemplateService;
  assistant: TemplateAssistant;
  guard: preHandlerHookHandler;
}

type IdParams = { Params: { id: string } };

export function registerTemplateRoutes(app: FastifyInstance, deps: TemplateRoutesDeps): void {
  const { service, assistant } = deps;
  const opts = { preHandler: deps.guard };

  app.get('/api/report-templates', opts, async (request) => {
    const { kind } = templateListQuerySchema.parse(request.query);
    return service.list(kind);
  });
  // the assistant never saves: the editor opens pre-filled with the returned draft
  app.post('/api/report-templates/assist', opts, async (request, reply) => {
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    return assistant.assist(request.body, controller.signal);
  });
  app.get<IdParams>('/api/report-templates/:id', opts, async (request) =>
    service.get(request.params.id),
  );
  app.post('/api/report-templates', opts, async (request, reply) =>
    reply.status(201).send(await service.create(request.body)),
  );
  app.put<IdParams>('/api/report-templates/:id', opts, async (request) =>
    service.update(request.params.id, request.body),
  );
  app.delete<IdParams>('/api/report-templates/:id', opts, async (request) => {
    await service.delete(request.params.id);
    return { ok: true };
  });
  app.post<IdParams>('/api/report-templates/:id/duplicate', opts, async (request, reply) =>
    reply.status(201).send(await service.duplicate(request.params.id)),
  );
}
