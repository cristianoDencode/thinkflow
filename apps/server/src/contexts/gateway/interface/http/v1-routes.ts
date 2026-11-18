import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../../../identity/application/auth-service';
import { apiKeyFrom } from '../../../identity/interface/http/auth-routes';
import { formatAnthropicSSE, formatOpenAISSE, OPENAI_SSE_DONE } from '../../../protocol/domain/sse';
import type { WireFormat } from '../../../protocol/domain/convert';
import type { GatewayService } from '../../application/gateway-service';

const FORWARDED_HEADERS = ['anthropic-beta'];
/** Privacy vault scope named by Thinkflow's own agent (honored only with its internal key). */
export const PRIVACY_SCOPE_HEADER = 'x-thinkflow-privacy-scope';

export function registerV1Routes(
  app: FastifyInstance,
  deps: { gateway: GatewayService; auth: AuthService },
): void {
  const { gateway, auth } = deps;

  const requireApiKey = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await auth.verifyApiKey(apiKeyFrom(request)))) {
      const anthropic = request.url.startsWith('/v1/messages');
      return reply.status(401).send(
        anthropic
          ? {
              type: 'error',
              error: { type: 'authentication_error', message: 'API key do Thinkflow inválida' },
            }
          : { error: { message: 'API key do Thinkflow inválida', type: 'invalid_api_key' } },
      );
    }
  };
  const opts = { preHandler: requireApiKey, bodyLimit: 64 * 1024 * 1024 };

  app.post('/v1/chat/completions', opts, (request, reply) => proxy(request, reply, 'openai'));
  app.post('/v1/messages', opts, (request, reply) => proxy(request, reply, 'anthropic'));
  app.post('/v1/messages/count_tokens', opts, async (request) =>
    gateway.countTokens((request.body ?? {}) as Record<string, unknown>),
  );
  app.get('/v1/models', { preHandler: requireApiKey }, async () => gateway.listModels());

  async function proxy(request: FastifyRequest, reply: FastifyReply, format: WireFormat) {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const wantsStream = body.stream === true;
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });

    const apiKey = apiKeyFrom(request);
    const scopeHeader = request.headers[PRIVACY_SCOPE_HEADER];
    const opened = await gateway.open(format, body, headers, abort.signal, {
      apiKey,
      internal: auth.isInternalKey(apiKey),
      scopeHeader: typeof scopeHeader === 'string' ? scopeHeader : undefined,
    });
    if (!opened.ok) return reply.status(opened.status).send(opened.body);

    reply.header('x-thinkflow-provider', opened.providerId);
    reply.header('x-thinkflow-model', opened.model);

    if (!wantsStream) {
      try {
        const json = await gateway.collect(
          format,
          opened.events,
          String(body.model ?? opened.model),
        );
        opened.complete();
        return reply.send(json);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opened.complete(message);
        return reply
          .status(502)
          .send(
            format === 'anthropic'
              ? { type: 'error', error: { type: 'api_error', message } }
              : { error: { message, type: 'upstream_error' } },
          );
      }
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-thinkflow-provider': opened.providerId,
      'x-thinkflow-model': opened.model,
    });
    let error: string | undefined;
    try {
      for await (const event of opened.events) {
        if (reply.raw.writableEnded) break;
        reply.raw.write(
          format === 'openai'
            ? formatOpenAISSE(event)
            : formatAnthropicSSE(event as { type: string }),
        );
      }
      if (format === 'openai' && !reply.raw.writableEnded) reply.raw.write(OPENAI_SSE_DONE);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      request.log.warn({ err }, 'upstream stream failed after commit');
      if (!reply.raw.writableEnded) {
        reply.raw.write(
          format === 'anthropic'
            ? formatAnthropicSSE({
                type: 'error',
                error: { type: 'api_error', message: error },
              } as { type: string })
            : formatOpenAISSE({ error: { message: error, type: 'upstream_error' } }),
        );
      }
    } finally {
      opened.complete(error);
      reply.raw.end();
    }
  }
}
