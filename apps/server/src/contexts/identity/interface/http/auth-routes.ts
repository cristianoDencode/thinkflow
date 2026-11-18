import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../../application/auth-service';

export const SESSION_COOKIE = 'tf_session';

export function sessionToken(request: FastifyRequest): string | undefined {
  return request.cookies?.[SESSION_COOKIE];
}

/** preHandler: dashboard API requires a logged-in session. */
export function requireSession(auth: AuthService) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await auth.verifySession(sessionToken(request)))) {
      return reply
        .status(401)
        .send({ error: { code: 'unauthorized', message: 'Faça login para continuar' } });
    }
  };
}

/** Extracts an API key from `x-api-key` or `Authorization: Bearer`. */
export function apiKeyFrom(request: FastifyRequest): string | undefined {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header) return header;
  const auth = request.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  options: { cookieSecure: boolean },
): void {
  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: options.cookieSecure,
      maxAge: 30 * 24 * 3600,
    });

  app.get('/api/auth/status', async (request) => auth.status(sessionToken(request)));

  app.post('/api/auth/setup', async (request, reply) => {
    const token = await auth.setup(request.body);
    setCookie(reply, token);
    return auth.status(token);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const token = await auth.login(request.body);
    setCookie(reply, token);
    return auth.status(token);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await auth.logout(sessionToken(request));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  const guard = { preHandler: requireSession(auth) };

  app.put('/api/profile', guard, async (request) => auth.updateProfile(request.body));

  app.post('/api/profile/password', guard, async (request) => {
    const body = z.object({ current: z.string(), next: z.string() }).parse(request.body);
    await auth.changePassword(body.current, body.next);
    return { ok: true };
  });

  app.get('/api/api-keys', guard, async () => auth.listApiKeys());
  app.post('/api/api-keys', guard, async (request) => auth.createApiKey(request.body));
  app.delete<{ Params: { id: string } }>('/api/api-keys/:id', guard, async (request) => {
    await auth.revokeApiKey(request.params.id);
    return { ok: true };
  });
}
