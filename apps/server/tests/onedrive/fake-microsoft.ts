import type { FetchFn } from '../../src/contexts/onedrive/domain/ports';

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Request body as text (form/JSON) - empty for binary bodies. */
  text: string;
  /** Size of a binary body. */
  bytes: number;
  form: URLSearchParams;
}

type Handler = (call: RecordedCall, n: number) => Response | Promise<Response>;

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** In-memory stand-in for login.microsoftonline.com + graph.microsoft.com (no network). */
export class FakeMicrosoft {
  readonly calls: RecordedCall[] = [];
  private readonly routes: { method: string; pattern: RegExp; handler: Handler; hits: number }[] =
    [];

  readonly fetch: FetchFn = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body;
    const text = typeof body === 'string' ? body : '';
    const call: RecordedCall = {
      method,
      url: input,
      headers,
      text,
      bytes: body && typeof body !== 'string' ? (body as Uint8Array).byteLength : text.length,
      form: new URLSearchParams(
        headers['content-type']?.includes('x-www-form-urlencoded') ? text : '',
      ),
    };
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === method && r.pattern.test(input));
    if (!route)
      return jsonResponse(599, { error: { code: 'unrouted', message: `${method} ${input}` } });
    route.hits += 1;
    return route.handler(call, route.hits);
  };

  on(method: string, pattern: RegExp, handler: Handler | Response | object): this {
    const fn: Handler =
      typeof handler === 'function'
        ? (handler as Handler)
        : handler instanceof Response
          ? () => handler.clone()
          : () => jsonResponse(200, handler);
    // later routes win, so a test can override the defaults
    this.routes.unshift({ method, pattern, handler: fn, hits: 0 });
    return this;
  }

  callsTo(method: string, pattern: RegExp): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && pattern.test(c.url));
  }
}

export const TOKEN_URL = /login\.microsoftonline\.com\/consumers\/oauth2\/v2\.0\/token/;

export function tokenResponse(
  over: Partial<{ access: string; refresh: string | null; expiresIn: number }> = {},
) {
  return jsonResponse(200, {
    token_type: 'Bearer',
    scope: 'Files.ReadWrite User.Read',
    expires_in: over.expiresIn ?? 3600,
    access_token: over.access ?? 'AT-1',
    ...(over.refresh === null ? {} : { refresh_token: over.refresh ?? 'RT-1' }),
  });
}

export const ME = {
  id: 'user-1',
  displayName: 'Ana Analista',
  mail: 'ana@outlook.com',
  userPrincipalName: 'ana@outlook.com',
};

export function driveItem(over: Record<string, unknown> = {}) {
  return {
    id: 'ITEM1',
    name: 'CT 1 - a.docx',
    webUrl: 'https://1drv.ms/w/s!abc',
    file: {},
    parentReference: { id: 'PARENT', path: '/drive/root:/Testes' },
    ...over,
  };
}

export function folderItem(id: string, name: string, childCount = 0, path = '/drive/root:') {
  return {
    id,
    name,
    webUrl: `https://onedrive.live.com/?id=${id}`,
    folder: { childCount },
    parentReference: { id: 'ROOT', path },
  };
}
