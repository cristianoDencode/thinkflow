import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { DomainError } from '../../kernel/errors';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof ZodError) {
      const message = error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      return reply.status(400).send({ error: { code: 'validation_error', message } });
    }
    if (error instanceof DomainError) {
      return reply
        .status(error.httpStatus)
        .send({ error: { code: error.code, message: error.message } });
    }
    const status = (error as FastifyError).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: error.message } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Erro interno no servidor' } });
  });
}
