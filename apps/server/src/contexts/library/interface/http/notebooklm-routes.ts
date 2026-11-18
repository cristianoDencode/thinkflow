import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { NotebookLmSettingsService } from '../../application/notebooklm-settings-service';

export interface NotebookLmRoutesDeps {
  service: NotebookLmSettingsService;
  guard: preHandlerHookHandler;
}

export function registerNotebookLmRoutes(app: FastifyInstance, deps: NotebookLmRoutesDeps): void {
  const { service } = deps;
  const opts = { preHandler: deps.guard };
  const base = '/api/library/notebooklm';

  app.get(base, opts, async () => {
    void service.detectLimits(); // at most every 12 h; the next load shows the result
    return service.get();
  });
  app.put(base, opts, async (request) => service.update(request.body));
  app.post(`${base}/test`, opts, async () => service.test());
  app.delete(`${base}/credentials`, opts, async () => service.removeCredentials());

  // in-app Google login (a browser window opens on the machine running the server)
  app.post(`${base}/login`, opts, async (_request, reply) =>
    reply.status(202).send(service.startLogin()),
  );
  app.get(`${base}/login`, opts, async () => service.loginStatus());
  app.delete(`${base}/login`, opts, async () => service.cancelLogin());

  // adopt the login already done with the CLI on this machine (path resolved server-side only)
  app.post(`${base}/import-local`, opts, async () => service.importLocal());
  app.post(`${base}/refresh`, opts, async () => service.refresh());
}
