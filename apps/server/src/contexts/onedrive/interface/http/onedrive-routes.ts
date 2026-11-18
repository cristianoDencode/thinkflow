import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  onedriveDefaultFolderSchema,
  onedriveFileNameSchema,
  onedriveSettingsUpdateSchema,
  type OneDriveConnectStartDto,
} from '@thinkflow/shared';
import { DomainError } from '../../../../shared/kernel/errors';
import type { OneDriveService } from '../../application/onedrive-service';

export const ONEDRIVE_CALLBACK_PATH = '/api/integrations/onedrive/callback';
const HOST_PATTERN = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$/;

function firstValue(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  return raw?.split(',')[0]?.trim() || undefined;
}

/**
 * The redirect URI as the browser sees this server (works behind the Vite dev proxy and reverse
 * proxies that send X-Forwarded-*). A manual override in the settings wins over this.
 */
export function deriveRedirectUri(request: FastifyRequest): string {
  const host = firstValue(request.headers['x-forwarded-host']) ?? request.headers.host ?? '';
  const proto = firstValue(request.headers['x-forwarded-proto']) ?? request.protocol;
  const safeHost = HOST_PATTERN.test(host) ? host : 'localhost';
  return `${proto === 'https' ? 'https' : 'http'}://${safeHost}${ONEDRIVE_CALLBACK_PATH}`;
}

type CallbackQuery = { code?: string; state?: string; error?: string };

export function registerOneDriveRoutes(
  app: FastifyInstance,
  deps: { service: OneDriveService; guard: preHandlerHookHandler },
): void {
  const { service } = deps;
  const opts = { preHandler: deps.guard };
  const base = '/api/integrations/onedrive';

  app.get(base, opts, async (request) => service.status(deriveRedirectUri(request)));

  app.put(base, opts, async (request) => {
    service.updateSettings(onedriveSettingsUpdateSchema.parse(request.body));
    return service.status(deriveRedirectUri(request));
  });

  /** Returns the Microsoft sign-in URL; the web app navigates the browser to it. */
  app.post(`${base}/connect`, opts, async (request): Promise<OneDriveConnectStartDto> =>
    service.startAuthorization(deriveRedirectUri(request)),
  );

  /**
   * Microsoft redirects the browser here. No session guard on purpose: a cross-site redirect may
   * not carry the cookie, and the unguessable single-use `state` created by the guarded
   * /connect call is what authorizes the exchange.
   */
  app.get<{ Querystring: CallbackQuery }>(`${base}/callback`, async (request, reply) => {
    const { code, state, error } = request.query;
    try {
      await service.completeAuthorization({
        ...(code ? { code } : {}),
        ...(state ? { state } : {}),
        ...(error ? { error } : {}),
      });
      return reply.redirect('/settings?onedrive=connected');
    } catch (err) {
      const message =
        err instanceof DomainError
          ? err.message
          : 'Não foi possível concluir a conexão com o OneDrive.';
      if (!(err instanceof DomainError)) request.log.warn({ err }, 'onedrive callback failed');
      return reply.redirect(`/settings?onedrive=error&reason=${encodeURIComponent(message)}`);
    }
  });

  app.post(`${base}/disconnect`, opts, async (request) => {
    service.disconnect();
    return service.status(deriveRedirectUri(request));
  });

  /** Subfolders of a folder (`parentId` omitted = the OneDrive root). */
  app.get<{ Querystring: { parentId?: string } }>(`${base}/folders`, opts, async (request) =>
    service.listFolder(request.query.parentId?.trim() || null),
  );

  app.put(`${base}/default-folder`, opts, async (request) => {
    const { id } = onedriveDefaultFolderSchema.parse(request.body);
    await service.setDefaultFolder(id);
    return service.status(deriveRedirectUri(request));
  });

  /** File name for a test case using the configured pattern. */
  app.post(`${base}/file-name`, opts, async (request) => {
    const vars = onedriveFileNameSchema.parse(request.body);
    return { fileName: service.suggestFileName(vars) };
  });
}
