import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import {
  LIBRARY_LIMITS,
  librarySearchQuerySchema,
  librarySettingsSchema,
  libraryTextQuerySchema,
  type LibrarySettings,
} from '@thinkflow/shared';
import { DomainError } from '../../../../shared/kernel/errors';
import type { LibraryService, UploadedFile } from '../../application/library-service';

type IdParams = { Params: { id: string } };
type DocParams = { Params: { id: string; docId: string } };

export interface LibraryRoutesDeps {
  service: LibraryService;
  guard: preHandlerHookHandler;
  settings: { get(): LibrarySettings; set(value: LibrarySettings): void };
}

function uploadError(err: unknown): DomainError | null {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case 'FST_REQ_FILE_TOO_LARGE':
      return new DomainError(
        `Arquivo maior que ${LIBRARY_LIMITS.maxFileBytes / (1024 * 1024)} MB`,
        'file_too_large',
        413,
      );
    case 'FST_FILES_LIMIT':
      return new DomainError(
        `Envie no máximo ${LIBRARY_LIMITS.maxFilesPerUpload} arquivos por vez`,
        'too_many_files',
        413,
      );
    case 'FST_PARTS_LIMIT':
    case 'FST_FIELDS_LIMIT':
      return new DomainError('Envio inválido: partes demais', 'bad_upload', 400);
    default:
      return null;
  }
}

export function registerLibraryRoutes(app: FastifyInstance, deps: LibraryRoutesDeps): void {
  const { service } = deps;
  const opts = { preHandler: deps.guard };

  app.get('/api/libraries', opts, async () => service.list());
  app.post('/api/libraries', opts, async (request, reply) =>
    reply.status(201).send(await service.create(request.body)),
  );
  app.get<IdParams>('/api/libraries/:id', opts, async (request) => service.get(request.params.id));
  app.patch<IdParams>('/api/libraries/:id', opts, async (request) =>
    service.update(request.params.id, request.body),
  );
  app.delete<IdParams>('/api/libraries/:id', opts, async (request) => {
    await service.delete(request.params.id);
    return { ok: true };
  });

  app.post<IdParams>('/api/libraries/:id/documents', opts, async (request, reply) => {
    if (!request.isMultipart())
      throw new DomainError('Envie os arquivos como multipart/form-data', 'bad_upload', 400);
    const files: UploadedFile[] = [];
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue;
        files.push({
          name: part.filename,
          mimeType: part.mimetype,
          bytes: await part.toBuffer(),
        });
      }
    } catch (err) {
      throw uploadError(err) ?? err;
    }
    return reply.status(201).send(await service.addDocuments(request.params.id, files));
  });

  app.delete<DocParams>('/api/libraries/:id/documents/:docId', opts, async (request) => {
    await service.deleteDocument(request.params.id, request.params.docId);
    return { ok: true };
  });
  app.post<DocParams>('/api/libraries/:id/documents/:docId/reindex', opts, async (request, reply) =>
    reply.status(202).send(await service.reindex(request.params.id, request.params.docId)),
  );
  app.post<DocParams>('/api/libraries/:id/documents/:docId/sync', opts, async (request, reply) =>
    reply.status(202).send(await service.resync(request.params.id, request.params.docId)),
  );
  app.get<DocParams>('/api/libraries/:id/documents/:docId/text', opts, async (request) => {
    const { offset, limit } = libraryTextQuerySchema.parse(request.query);
    return service.documentText(request.params.id, request.params.docId, offset, limit);
  });
  app.get<IdParams>('/api/libraries/:id/search', opts, async (request) => {
    const { q, k } = librarySearchQuerySchema.parse(request.query);
    return service.search(request.params.id, q, k);
  });

  app.get('/api/library/settings', opts, async () => deps.settings.get());
  app.put('/api/library/settings', opts, async (request) => {
    const value = librarySettingsSchema.parse(request.body);
    deps.settings.set(value);
    return value;
  });
}
