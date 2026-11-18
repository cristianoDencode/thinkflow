import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { CtAssistant } from '../../application/ct-assistant';

export interface CtAssistantRoutesDeps {
  assistant: CtAssistant;
  guard: preHandlerHookHandler;
}

/** POST /api/tests/sessions/:id/ct-assistant — proposes a text patch; never saves anything. */
export function registerCtAssistantRoutes(app: FastifyInstance, deps: CtAssistantRoutesDeps): void {
  app.post<{ Params: { id: string } }>(
    '/api/tests/sessions/:id/ct-assistant',
    { preHandler: deps.guard, bodyLimit: 2 * 1024 * 1024 },
    async (request) => {
      // the client going away cancels the (slow) model call
      const controller = new AbortController();
      request.raw.on('close', () => {
        if (!request.raw.complete) controller.abort();
      });
      return deps.assistant.assist(request.params.id, request.body, controller.signal);
    },
  );
}
