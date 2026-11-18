import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { PROTOTYPE_LIMITS } from '@thinkflow/shared';
import type { PrototypeAssistant } from '../../application/prototype-assistant';

export interface PrototypeAssistantRoutesDeps {
  assistant: PrototypeAssistant;
  guard: preHandlerHookHandler;
}

/** The screen travels in the body (it may hold data-URI pictures): same ceiling as a snapshot. */
const BODY_LIMIT = PROTOTYPE_LIMITS.maxSnapshotBytes * 2 + 1024 * 1024;

/** POST /api/prototypes/:id/assistant — proposes a rewritten HTML/CSS; never saves anything. */
export function registerPrototypeAssistantRoutes(
  app: FastifyInstance,
  deps: PrototypeAssistantRoutesDeps,
): void {
  app.post<{ Params: { id: string } }>(
    '/api/prototypes/:id/assistant',
    { preHandler: deps.guard, bodyLimit: BODY_LIMIT },
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
