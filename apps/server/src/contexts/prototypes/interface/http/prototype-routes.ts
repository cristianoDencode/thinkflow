import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { PROTOTYPE_KINDS, PROTOTYPE_LIMITS } from '@thinkflow/shared';
import { z } from 'zod';
import { NotFoundError } from '../../../../shared/kernel/errors';
import type { PrototypeRenderService } from '../../application/prototype-render-service';
import {
  ASSET_BODY_LIMIT,
  type PrototypeSceneService,
} from '../../application/prototype-scene-service';
import type { PrototypeService } from '../../application/prototype-service';

export interface PrototypeRoutesDeps {
  service: PrototypeService;
  render: PrototypeRenderService;
  scene: PrototypeSceneService;
  guard: preHandlerHookHandler;
}

type IdParams = { Params: { id: string } };
type VersionParams = { Params: { id: string; vid: string } };

const listQuerySchema = z.object({
  sessionId: z.string().max(64).optional(),
  kind: z.enum([...PROTOTYPE_KINDS, 'all']).optional(),
});

/** A snapshot may weigh 15 MB of HTML/CSS plus the JSON envelope; the service enforces the exact limit. */
const SNAPSHOT_BODY_LIMIT = PROTOTYPE_LIMITS.maxSnapshotBytes * 2 + 1024 * 1024;
const BLOCK_BODY_LIMIT = PROTOTYPE_LIMITS.maxBlockBytes * 2 + 64 * 1024;

export function registerPrototypeRoutes(app: FastifyInstance, deps: PrototypeRoutesDeps): void {
  const { service, render, scene } = deps;
  const opts = { preHandler: deps.guard };
  const withSnapshot = { ...opts, bodyLimit: SNAPSHOT_BODY_LIMIT };
  const base = '/api/prototypes';

  app.get(base, opts, async (request) => {
    const { sessionId, kind } = listQuerySchema.parse(request.query);
    return service.list({ ...(sessionId ? { sessionId } : {}), ...(kind ? { kind } : {}) });
  });
  app.post(base, withSnapshot, async (request, reply) =>
    reply.status(201).send(await service.create(request.body)),
  );

  // screens sent by an external mapper: captured like in the app (registered before `/:id`)
  app.post(`${base}/import`, withSnapshot, async (request, reply) =>
    reply.status(201).send(await service.importCapture(request.body)),
  );

  // templates ("modelos"): built-ins + the user's (registered before `/:id` too)
  app.get(`${base}/templates`, opts, async () => service.templates());
  app.get<{ Params: { templateId: string } }>(
    `${base}/templates/:templateId/thumbnail`,
    opts,
    async (request, reply) => {
      const png = await render.builtinThumbnail(request.params.templateId);
      return reply
        .header('content-type', 'image/png')
        .header('cache-control', 'private, max-age=3600')
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(png));
    },
  );

  // palette blocks (registered before `/:id` so "blocks" is never read as an id)
  app.get(`${base}/blocks`, opts, async () => service.blocks());
  app.post(`${base}/blocks`, { ...opts, bodyLimit: BLOCK_BODY_LIMIT }, async (request, reply) =>
    reply.status(201).send(await service.createBlock(request.body)),
  );
  app.put<{ Params: { blockId: string } }>(`${base}/blocks/:blockId`, opts, async (request) =>
    service.updateBlock(request.params.blockId, request.body),
  );
  app.delete<{ Params: { blockId: string } }>(
    `${base}/blocks/:blockId`,
    opts,
    async (request, reply) => {
      await service.deleteBlock(request.params.blockId);
      return reply.status(204).send();
    },
  );

  app.get<IdParams>(`${base}/:id`, opts, async (request) => service.get(request.params.id));
  app.put<IdParams>(`${base}/:id`, withSnapshot, async (request) =>
    service.update(request.params.id, request.body),
  );
  app.delete<IdParams>(`${base}/:id`, opts, async (request, reply) => {
    await service.delete(request.params.id);
    return reply.status(204).send();
  });

  app.post<IdParams>(`${base}/:id/save-as-template`, opts, async (request, reply) =>
    reply.status(201).send(await service.saveAsTemplate(request.params.id, request.body)),
  );

  app.get<VersionParams>(`${base}/:id/versions/:vid`, opts, async (request) =>
    service.version(request.params.id, request.params.vid),
  );
  app.post<VersionParams>(`${base}/:id/versions/:vid/restore`, opts, async (request) =>
    service.restore(request.params.id, request.params.vid),
  );

  // images of the "Modo Livre" scene (named by the sha256 of the PNG)
  app.get<{ Params: { id: string; asset: string } }>(
    `${base}/:id/assets/:asset`,
    opts,
    async (request, reply) => {
      const bytes = await scene.asset(request.params.id, request.params.asset);
      return reply
        .header('content-type', 'image/png')
        .header('cache-control', 'private, max-age=31536000, immutable')
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(bytes));
    },
  );
  app.post<IdParams>(
    `${base}/:id/assets`,
    { ...opts, bodyLimit: ASSET_BODY_LIMIT },
    async (request) => scene.upload(request.params.id, request.body),
  );
  app.post<IdParams>(
    `${base}/:id/assets/from-block`,
    { ...opts, bodyLimit: BLOCK_BODY_LIMIT },
    async (request) => scene.fromBlock(request.params.id, request.body),
  );
  // the current version cut into a background plus one image per component (nothing is saved)
  app.post<IdParams>(`${base}/:id/scene/from-html`, opts, async (request) =>
    scene.fromHtml(request.params.id),
  );

  // the current version as a free layout (absolutely positioned wrappers); nothing is saved
  app.post<IdParams>(`${base}/:id/free-layout`, opts, async (request) =>
    scene.freeLayout(request.params.id),
  );

  // the last rendered PNG
  app.get<IdParams>(`${base}/:id/thumbnail`, opts, async (request, reply) => {
    const bytes = await service.thumbnail(request.params.id);
    if (!bytes) throw new NotFoundError('Miniatura');
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'private, no-cache')
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(bytes));
  });

  // PNG of the current version (cached per version and scale; `?force=true` renders again)
  app.post<IdParams>(`${base}/:id/render`, opts, async (request) =>
    render.renderFromQuery(request.params.id, request.query),
  );
  // renders if needed, then adds the PNG to a test session's CT document
  app.post<IdParams>(`${base}/:id/send-to-session`, opts, async (request) =>
    render.sendToSession(request.params.id, request.body),
  );
}
