import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { chatRequestSchema, type ChatStreamEvent } from '@thinkflow/shared';
import type { ChatService } from '../../application/chat-service';

type IdParams = { Params: { id: string } };

export function registerChatRoutes(
  app: FastifyInstance,
  deps: { service: ChatService; guard: preHandlerHookHandler },
): void {
  const { service } = deps;
  const opts = { preHandler: deps.guard };

  app.get('/api/conversations', opts, async (request) => service.list(request.query));
  app.get<IdParams>('/api/conversations/:id', opts, async (request) =>
    service.get(request.params.id),
  );
  app.patch<IdParams>('/api/conversations/:id', opts, async (request) =>
    service.update(request.params.id, request.body),
  );
  app.post<IdParams>('/api/conversations/:id/fork', opts, async (request, reply) => {
    reply.code(201);
    return service.fork(request.params.id, request.body);
  });
  app.delete<IdParams>('/api/conversations/:id', opts, async (request) => {
    await service.delete(request.params.id);
    return { ok: true };
  });

  app.post<IdParams>('/api/messages/:id/feedback', opts, async (request) => {
    const { feedback } = z
      .object({ feedback: z.enum(['up', 'down']).nullable() })
      .parse(request.body);
    await service.setFeedback(request.params.id, feedback);
    return { ok: true };
  });

  /** The analyst's answer to an `ai_review` card: what the AI may see of each listed column. */
  app.post<{ Params: { reviewId: string } }>(
    '/api/chat/reviews/:reviewId',
    opts,
    async (request) => {
      service.answerReview(request.params.reviewId, request.body);
      return { ok: true };
    },
  );

  /** Streams one chat turn as SSE (`data: ChatStreamEvent`). */
  app.post('/api/chat', { ...opts, bodyLimit: 50 * 1024 * 1024 }, async (request, reply) => {
    const body = chatRequestSchema.parse(request.body); // validate before switching to streaming

    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const emit = (event: ChatStreamEvent) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const keepAlive = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': keep-alive\n\n');
    }, 15_000);

    try {
      await service.send(body, emit, abort.signal);
    } catch (err) {
      request.log.error({ err }, 'chat turn failed');
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      clearInterval(keepAlive);
      reply.raw.end();
    }
  });
}
