import { directQuerySchema } from '@thinkflow/shared';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseService } from '../../application/database-service';

type IdParams = { Params: { id: string } };
type RuleParams = { Params: { id: string; ruleId: string } };

export function registerDatabaseRoutes(
  app: FastifyInstance,
  deps: { service: DatabaseService; guard: preHandlerHookHandler },
): void {
  const { service } = deps;
  const opts = { preHandler: deps.guard };

  app.get('/api/databases', opts, async () => service.list());

  /** Data-dictionary MCP servers (tool `field_search`) and their projects, for a connection's settings. */
  app.get('/api/databases/metadata-mcp/servers', opts, async () => service.metadataServers());
  app.get<{ Params: { serverId: string } }>(
    '/api/databases/metadata-mcp/servers/:serverId/projects',
    opts,
    async (request) => service.metadataProjects(request.params.serverId),
  );
  app.post('/api/databases', opts, async (request, reply) =>
    reply.status(201).send(await service.create(request.body)),
  );
  app.get<IdParams>('/api/databases/:id', opts, async (request) => service.get(request.params.id));
  app.put<IdParams>('/api/databases/:id', opts, async (request) =>
    service.update(request.params.id, request.body),
  );
  app.delete<IdParams>('/api/databases/:id', opts, async (request) => {
    await service.delete(request.params.id);
    return { ok: true };
  });
  app.post<IdParams>('/api/databases/:id/test', opts, async (request) =>
    service.test(request.params.id),
  );

  /** What the AI may see of each column (rules by schema.table.column; `*` = any). */
  app.get<IdParams>('/api/databases/:id/ai-rules', opts, async (request) =>
    service.listRules(request.params.id),
  );
  app.put<IdParams>('/api/databases/:id/ai-rules', opts, async (request) =>
    service.saveRule(request.params.id, request.body),
  );
  app.delete<RuleParams>('/api/databases/:id/ai-rules/:ruleId', opts, async (request) => {
    await service.deleteRule(request.params.id, request.params.ruleId);
    return { ok: true };
  });

  /** The analyst's own SQL ("Executar SQL"): read-only, no AI. */
  app.post<IdParams>('/api/databases/:id/query', opts, async (request, reply) => {
    const { sql } = directQuerySchema.parse(request.body);
    // cancel the statement in Postgres when the client goes away before the answer
    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });
    return service.runDirect(request.params.id, sql, abort.signal);
  });

  /** Checks a SQL against the database without running it (guard, names, EXPLAIN). */
  app.post<IdParams>('/api/databases/:id/validate', opts, async (request, reply) => {
    const { sql } = directQuerySchema.parse(request.body);
    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });
    return service.validate(request.params.id, sql, abort.signal);
  });
}
