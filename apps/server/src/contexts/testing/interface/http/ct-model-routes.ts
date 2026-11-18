import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { CtLayoutAssistant } from '../../application/ct-layout-assistant';
import type { CtModelService } from '../../application/ct-model-service';

export interface CtModelRoutesDeps {
  models: CtModelService;
  assistant: CtLayoutAssistant;
  guard: preHandlerHookHandler;
}

type IdParams = { Params: { id: string } };

/** Models (looks) of the CT document. The logo travels as a data URL (up to 200 KB). */
export function registerCtModelRoutes(app: FastifyInstance, deps: CtModelRoutesDeps): void {
  const { models } = deps;
  const opts = { preHandler: deps.guard, bodyLimit: 2 * 1024 * 1024 };
  const base = '/api/tests/ct-models';

  app.get(base, opts, async () => models.list());
  app.post(base, opts, async (request, reply) =>
    reply.code(201).send(await models.create(request.body)),
  );
  app.post(`${base}/preview`, opts, async (request) => models.preview(request.body));
  // "Criar modelo com IA": proposes a look (a draft); never saves anything
  app.post(`${base}/assist`, opts, async (request) => {
    const controller = new AbortController();
    request.raw.on('close', () => {
      if (!request.raw.complete) controller.abort();
    });
    return deps.assistant.assist(request.body, controller.signal);
  });
  app.get<IdParams>(`${base}/:id`, opts, async (request) => models.get(request.params.id));
  app.put<IdParams>(`${base}/:id`, opts, async (request) =>
    models.update(request.params.id, request.body),
  );
  app.delete<IdParams>(`${base}/:id`, opts, async (request) => {
    await models.remove(request.params.id);
    return { ok: true };
  });
}
