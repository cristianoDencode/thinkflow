import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import {
  ObjectStoreUnavailableError,
  type ObjectStream,
} from '../../../../shared/kernel/object-store';
import type { ReportService } from '../../application/report-service';
import { CONTENT_SECURITY_POLICY_HEADER } from '../../domain/themes';

export interface ReportRoutesDeps {
  service: ReportService;
  guard: preHandlerHookHandler;
}

type IdParams = { Params: { id: string } };

/** File names come from slugs, but never trust them inside a header. */
const safeFilename = (name: string): string => name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 100);

/** Shown inside the iframe when the HTML lives in the object store and the store is down. */
const STORAGE_DOWN_PAGE = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Documento indisponível</title>
<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#334155;background:#f8fafc}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0;line-height:1.5}</style></head>
<body><main><h1>Documento temporariamente indisponível</h1><p>O armazenamento de documentos (MinIO) está indisponível no momento. Tente novamente em instantes.</p></main></body></html>`;

/**
 * Sends a document that is either in memory or streamed from the object store. A stream is
 * released when the client goes away (`close`), so no socket is left open.
 */
function sendBody(reply: FastifyReply, body: string | Uint8Array | ObjectStream) {
  if (typeof body === 'string') return reply.send(body);
  if (body instanceof Uint8Array) return reply.send(Buffer.from(body));
  reply.raw.on('close', () => body.abort());
  reply.header('content-length', String(body.info.size));
  return reply.send(Readable.from(body.body));
}

export function registerReportRoutes(app: FastifyInstance, deps: ReportRoutesDeps): void {
  const { service } = deps;
  const opts = { preHandler: deps.guard };

  app.get('/api/reports/settings', opts, async () => service.settings());
  app.put('/api/reports/settings', opts, async (request) => service.updateSettings(request.body));

  app.get('/api/reports/renderer', opts, async () => service.rendererStatus());

  app.get('/api/reports', opts, async (request) => service.list(request.query));
  app.post('/api/reports', opts, async (request, reply) =>
    reply.status(201).send(await service.create(request.body)),
  );
  app.get<IdParams>('/api/reports/:id', opts, async (request) => service.get(request.params.id));
  app.patch<IdParams>('/api/reports/:id', opts, async (request) =>
    service.rename(request.params.id, request.body),
  );
  app.delete<IdParams>('/api/reports/:id', opts, async (request) => {
    await service.delete(request.params.id);
    return { ok: true };
  });
  app.post<IdParams>('/api/reports/:id/cancel', opts, async (request, reply) =>
    reply.status(202).send(await service.cancel(request.params.id)),
  );
  app.post<IdParams>('/api/reports/:id/retry', opts, async (request, reply) =>
    reply.status(202).send(await service.retry(request.params.id)),
  );
  app.post<{ Params: { id: string; ordinal: string } }>(
    '/api/reports/:id/sections/:ordinal/regenerate',
    opts,
    async (request, reply) =>
      reply
        .status(202)
        .send(
          await service.regenerateSection(
            request.params.id,
            Number.parseInt(request.params.ordinal, 10),
            request.body ?? {},
          ),
        ),
  );
  app.get<IdParams>('/api/reports/:id/markdown', opts, async (request, reply) => {
    const { filename, text } = await service.markdown(request.params.id);
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="${safeFilename(filename)}"`)
      .header('x-content-type-options', 'nosniff')
      .send(text);
  });
  app.get<IdParams & { Querystring: { download?: string } }>(
    '/api/reports/:id/html',
    opts,
    async (request, reply) => {
      const download = request.query.download === '1' || request.query.download === 'true';
      const htmlHeaders = () =>
        reply
          .header('content-type', 'text/html; charset=utf-8')
          .header('content-security-policy', CONTENT_SECURITY_POLICY_HEADER)
          .header('x-content-type-options', 'nosniff')
          .header('referrer-policy', 'no-referrer');
      let doc: Awaited<ReturnType<ReportService['html']>>;
      try {
        doc = await service.html(request.params.id);
      } catch (err) {
        // the iframe cannot show a JSON error: a small friendly page instead (downloads get JSON)
        if (err instanceof ObjectStoreUnavailableError && !download)
          return htmlHeaders().status(503).header('retry-after', '30').send(STORAGE_DOWN_PAGE);
        throw err;
      }
      htmlHeaders();
      if (download)
        reply.header('content-disposition', `attachment; filename="${safeFilename(doc.filename)}"`);
      return sendBody(reply, doc.body);
    },
  );
  app.get<IdParams>('/api/reports/:id/pdf', opts, async (request, reply) => {
    const { filename, body } = await service.pdf(request.params.id);
    reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${safeFilename(filename)}"`)
      .header('x-content-type-options', 'nosniff');
    return sendBody(reply, body);
  });
  app.post<IdParams>('/api/reports/:id/library', opts, async (request) =>
    service.addToLibrary(request.params.id, request.body),
  );
}
