import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { CtDocumentService, CtFile } from '../../application/ct-document-service';

export interface CtRoutesDeps {
  service: CtDocumentService;
  guard: preHandlerHookHandler;
}

type IdParams = { Params: { id: string } };

const clipboardQuery = z.object({ format: z.enum(['html', 'text']).default('html') });

function send(reply: FastifyReply, file: CtFile) {
  reply.header('content-type', file.contentType).header('cache-control', 'no-store');
  if (file.filename) {
    // ASCII fallback + RFC 5987 name (the stem is already free of accents and unsafe characters)
    reply.header(
      'content-disposition',
      `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
  }
  return reply.send(typeof file.body === 'string' ? file.body : Buffer.from(file.body));
}

/** "Caso de Teste CT" of a test session: fields, preview and the exports. */
export function registerCtRoutes(app: FastifyInstance, deps: CtRoutesDeps): void {
  const { service } = deps;
  const opts = { preHandler: deps.guard };
  const base = '/api/tests/sessions/:id/ct';

  app.get<IdParams>(base, opts, async (request) => service.state(request.params.id));
  app.put<IdParams>(base, opts, async (request) => service.update(request.params.id, request.body));
  // the model (look) of this session's document
  app.put<IdParams>(`${base}/model`, opts, async (request) =>
    service.setModel(request.params.id, request.body),
  );

  // shown in an iframe: nothing may run, images only from this origin (authenticated route)
  app.get<IdParams>(`${base}/preview`, opts, async (request, reply) => {
    const file = await service.preview(request.params.id);
    reply.header(
      'content-security-policy',
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    );
    return send(reply, file);
  });
  app.get<IdParams>(`${base}/docx`, opts, async (request, reply) =>
    send(reply, await service.docx(request.params.id)),
  );
  app.get<IdParams>(`${base}/pdf`, opts, async (request, reply) => {
    const controller = new AbortController();
    // the client went away before the PDF was sent: stop printing
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    return send(reply, await service.pdf(request.params.id, controller.signal));
  });
  app.get<IdParams>(`${base}/clipboard`, opts, async (request, reply) => {
    const { format } = clipboardQuery.parse(request.query);
    return send(reply, await service.clipboard(request.params.id, format));
  });
  app.post<IdParams>(`${base}/onedrive`, opts, async (request) =>
    service.publish(request.params.id),
  );
}
