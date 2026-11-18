import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { sessionModeSchema } from '@thinkflow/shared';
import { z } from 'zod';
import { DomainError, NotFoundError } from '../../../../shared/kernel/errors';
import type { DocumentService } from '../../application/document-service';
import type { DownloadService } from '../../application/download-service';
import type { EvidenceService } from '../../application/evidence-service';
import type { RecordingService } from '../../application/recording-service';
import type { RunService } from '../../application/run-service';
import { toStepImageDto, type TestSessionService } from '../../application/test-session-service';
import { Readable } from 'node:stream';
import { attachmentDisposition, servedContentType } from '../../domain/download';
import type { TestImageStore } from '../../domain/ports';
import { keyBelongsTo } from '../../domain/session';

export interface TestRoutesDeps {
  sessions: TestSessionService;
  recording: RecordingService;
  evidences: EvidenceService;
  runs: RunService;
  documents: DocumentService;
  downloads: DownloadService;
  images: TestImageStore;
  guard: preHandlerHookHandler;
}

type IdParams = { Params: { id: string } };
type StepParams = { Params: { id: string; stepId: string } };
type EvidenceParams = { Params: { id: string; evidenceId: string } };
type RunParams = { Params: { id: string; runId: string } };
type DownloadParams = { Params: { id: string; downloadId: string } };

/** Reads a multipart body: the `data` field (JSON) and the `image` file. */
async function readMultipart(
  request: FastifyRequest,
): Promise<{ data: unknown; image: Uint8Array | null }> {
  if (!request.isMultipart()) {
    throw new DomainError('Envie a imagem como multipart/form-data', 'bad_upload', 400);
  }
  let data: unknown = {};
  let image: Uint8Array | null = null;
  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname === 'image') image = new Uint8Array(await part.toBuffer());
        else await part.toBuffer();
      } else if (part.fieldname === 'data' && typeof part.value === 'string') {
        data = JSON.parse(part.value);
      }
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new DomainError('Imagem grande demais.', 'image_too_large', 413);
    }
    if (err instanceof SyntaxError) throw new DomainError('Dados inválidos.', 'bad_upload', 400);
    throw err;
  }
  return { data, image };
}

const pauseSchema = z.object({ paused: z.boolean() });
const startSchema = z.object({ mode: sessionModeSchema.optional() });
const prototypeCaptureSchema = z.object({ keepData: z.boolean().optional() });
const pageAssertSchema = z.object({ type: z.enum(['urlContains', 'title']) });
type ImageParams = { Params: { id: string; '*': string } };

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg' };

export function registerTestRoutes(app: FastifyInstance, deps: TestRoutesDeps): void {
  const { sessions, recording, evidences, runs, documents, downloads, images } = deps;
  const opts = { preHandler: deps.guard };
  const base = '/api/tests/sessions';

  app.get('/api/tests/support', opts, async () => sessions.support());

  app.get(base, opts, async () => sessions.list());
  app.post(base, opts, async (request, reply) =>
    reply.status(201).send(await sessions.create(request.body)),
  );
  app.get<IdParams>(`${base}/:id`, opts, async (request) => sessions.get(request.params.id));
  app.patch<IdParams>(`${base}/:id`, opts, async (request) =>
    sessions.update(request.params.id, request.body),
  );
  app.delete<IdParams>(`${base}/:id`, opts, async (request) => {
    await sessions.delete(request.params.id);
    return { ok: true };
  });

  // recording: a visible browser window on the server machine
  app.post<IdParams>(`${base}/:id/record/start`, opts, async (request) => {
    // the mode (record | capture) is chosen here the first time and fixed from then on
    const { mode } = startSchema.parse(request.body ?? {});
    await recording.start(request.params.id, { mode });
    return sessions.get(request.params.id);
  });
  app.post<IdParams>(`${base}/:id/record/stop`, opts, async (request) => {
    await recording.stop(request.params.id);
    return sessions.get(request.params.id);
  });
  app.post<IdParams>(`${base}/:id/record/pause`, opts, async (request) => {
    await recording.pause(request.params.id, pauseSchema.parse(request.body).paused);
    return sessions.get(request.params.id);
  });
  // "Verificar": a print of the whole window becomes a `checkpoint` step
  app.post<IdParams>(`${base}/:id/record/checkpoint`, opts, async (request) => {
    await recording.checkpoint(request.params.id);
    return sessions.get(request.params.id);
  });
  // "Protótipo": the screen the user is on becomes a prototype (values/grid cells scrubbed unless
  // `keepData`); the recording goes on
  app.post<IdParams>(`${base}/:id/record/prototype`, opts, async (request, reply) => {
    const { keepData } = prototypeCaptureSchema.parse(request.body ?? {});
    return reply
      .status(201)
      .send(await recording.capturePrototype(request.params.id, null, { keepData }));
  });
  // checks of the current page (URL path, title)
  app.post<IdParams>(`${base}/:id/record/assert-page`, opts, async (request) => {
    await recording.assertPage(request.params.id, pageAssertSchema.parse(request.body).type);
    return sessions.get(request.params.id);
  });

  // steps
  app.patch<StepParams>(`${base}/:id/steps/:stepId`, opts, async (request) =>
    sessions.updateStep(request.params.id, request.params.stepId, request.body),
  );
  app.delete<StepParams>(`${base}/:id/steps/:stepId`, opts, async (request) =>
    sessions.deleteStep(request.params.id, request.params.stepId),
  );
  app.post<IdParams>(`${base}/:id/steps/reorder`, opts, async (request) =>
    sessions.reorderSteps(request.params.id, request.body),
  );
  app.post<IdParams>(`${base}/:id/steps/notes`, opts, async (request, reply) =>
    reply.status(201).send(await sessions.addNote(request.params.id, request.body)),
  );

  // use-case dividers of the CT document
  app.post<IdParams>(`${base}/:id/steps/use-cases`, opts, async (request, reply) =>
    reply.status(201).send(await sessions.addUseCase(request.params.id, request.body)),
  );

  // parameters and data sets (secret values: a string sets, the marker keeps)
  app.put<IdParams>(`${base}/:id/data`, opts, async (request) =>
    sessions.updateData(request.params.id, request.body),
  );

  // replays
  app.post<IdParams>(`${base}/:id/runs`, opts, async (request, reply) =>
    reply.status(202).send(await runs.start(request.params.id, request.body)),
  );
  app.get<RunParams>(`${base}/:id/runs/:runId`, opts, async (request) =>
    runs.get(request.params.id, request.params.runId),
  );
  app.post<RunParams>(`${base}/:id/runs/:runId/cancel`, opts, async (request) =>
    runs.cancel(request.params.id, request.params.runId),
  );

  // manual print (mode "Só prints"): adds a `capture` step holding the print
  app.post<IdParams>(`${base}/:id/capture`, opts, async (request, reply) =>
    reply.status(201).send(toStepImageDto(await recording.capture(request.params.id))),
  );
  // a PNG pasted/uploaded (another system): becomes a `capture` step with that image
  app.post<IdParams>(`${base}/:id/steps/captures`, opts, async (request, reply) => {
    sessions.assertIdle(request.params.id);
    const { image } = await readMultipart(request);
    if (!image) throw new DomainError('Envie a imagem no campo "image".', 'bad_upload', 400);
    return reply.status(201).send(await evidences.upload(request.params.id, image));
  });
  // the image of a step: annotated and commented, left in/out of the document, or removed
  // (`:evidenceId` is the image's id; the step stays)
  app.patch<EvidenceParams>(`${base}/:id/evidences/:evidenceId`, opts, async (request) =>
    evidences.update(request.params.id, request.params.evidenceId, request.body),
  );
  app.put<EvidenceParams>(`${base}/:id/evidences/:evidenceId/annotated`, opts, async (request) => {
    const { data, image } = await readMultipart(request);
    return evidences.saveAnnotated(request.params.id, request.params.evidenceId, data, image);
  });
  app.delete<EvidenceParams>(`${base}/:id/evidences/:evidenceId`, opts, async (request) => {
    await evidences.delete(request.params.id, request.params.evidenceId);
    return { ok: true };
  });

  // files downloaded while recording or replaying: a history, apart from the document
  app.get<IdParams>(`${base}/:id/downloads`, opts, async (request) =>
    downloads.list(request.params.id, request.query),
  );
  app.get<DownloadParams>(
    `${base}/:id/downloads/:downloadId/file`,
    opts,
    async (request, reply) => {
      const { download, stream } = await downloads.open(
        request.params.id,
        request.params.downloadId,
      );
      reply.raw.on('close', () => stream.abort());
      return reply
        .header('content-type', servedContentType(download.contentType))
        .header('content-length', String(stream.info.size))
        .header('content-disposition', attachmentDisposition(download.fileName))
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', 'sandbox')
        .send(Readable.from(stream.body));
    },
  );
  app.delete<DownloadParams>(`${base}/:id/downloads/:downloadId`, opts, async (request) => {
    await downloads.delete(request.params.id, request.params.downloadId);
    return { ok: true };
  });

  // the evidence document (html/md for the clipboard, zip, Playwright spec)
  app.get<IdParams>(`${base}/:id/document`, opts, async (request, reply) => {
    const file = await documents.render(request.params.id, request.query);
    reply.header('content-type', file.contentType).header('cache-control', 'no-store');
    if (file.contentType.startsWith('text/html')) {
      // shown in a sandboxed iframe: nothing may run or load from outside
      reply.header(
        'content-security-policy',
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      );
    }
    if (file.filename) {
      reply.header('content-disposition', `attachment; filename="${file.filename}"`);
    }
    return reply.send(typeof file.body === 'string' ? file.body : Buffer.from(file.body));
  });

  // thumbnails, screenshots and annotated images: only keys of this session, ids-only paths
  app.get<ImageParams>(`${base}/:id/images/*`, opts, async (request, reply) => {
    const { id } = request.params;
    const key = `${id}/${request.params['*']}`;
    const ext = key.slice(key.lastIndexOf('.') + 1);
    if (!keyBelongsTo(key, id) || !IMAGE_TYPES[ext] || !/^[a-z0-9/._-]+$/.test(key)) {
      throw new NotFoundError('Imagem');
    }
    await sessions.require(id);
    const bytes = await images.get(key);
    if (!bytes) throw new NotFoundError('Imagem');
    return reply
      .header('content-type', IMAGE_TYPES[ext])
      .header('cache-control', 'private, no-cache')
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(bytes));
  });
}
