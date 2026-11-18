export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Fired when the session expired; the app redirects to /login. */
export const UNAUTHORIZED_EVENT = 'thinkflow:unauthorized';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    // FormData: the browser sets the multipart content-type (with boundary)
    headers: body !== undefined && !isForm ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: isForm ? body : JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const data = text ? safeParse(text) : null;
  if (!response.ok) {
    const error = (data as { error?: { message?: string; code?: string } } | null)?.error;
    if (response.status === 401 && !url.startsWith('/api/auth/'))
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(error?.message ?? `Erro ${response.status}`, response.status, error?.code);
  }
  return data as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, form: FormData) => request<T>('POST', url, form),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
