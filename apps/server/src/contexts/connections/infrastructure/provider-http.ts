import type { Connection } from '../domain/connection';
import { parseDuration } from '../domain/quota';
import type { ProviderDefinition } from '../domain/provider-catalog';

export { parseDuration };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function resolveBaseUrl(provider: ProviderDefinition, connection: Connection): string {
  return (connection.baseUrl || provider.baseUrl).replace(/\/+$/, '');
}

export function buildAuthHeaders(
  provider: ProviderDefinition,
  connection: Connection,
): Record<string, string> {
  const headers: Record<string, string> = { ...(provider.extraHeaders ?? {}) };
  if (provider.format === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (!connection.apiKey) return headers;
  if (provider.auth === 'bearer') headers.authorization = `Bearer ${connection.apiKey}`;
  else if (provider.auth === 'x-api-key') headers['x-api-key'] = connection.apiKey;
  else if (provider.auth === 'none' && connection.apiKey)
    headers.authorization = `Bearer ${connection.apiKey}`;
  return headers;
}

/** Extracts a human readable error from a provider error body (JSON or text). */
export function extractErrorMessage(text: string): string {
  if (!text) return '';
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const error = json.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      const meta = e.metadata as Record<string, unknown> | undefined;
      const raw = typeof meta?.raw === 'string' ? ` (${meta.raw})` : '';
      if (typeof e.message === 'string') return e.message + raw;
    }
    if (typeof json.message === 'string') return json.message;
    if (typeof json.detail === 'string') return json.detail;
  } catch {
    // not JSON
  }
  return text.slice(0, 500);
}

/** Parses Retry-After (seconds or HTTP date) and OpenAI-style reset durations ("1m30s", "250ms"). */
export function parseRetryAfter(headers: Headers, now = Date.now()): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset =
    headers.get('x-ratelimit-reset-requests') ?? headers.get('x-ratelimit-reset-tokens');
  if (reset) return parseDuration(reset);
  return null;
}

/** 2xx body that is neither SSE nor JSON (typically a gateway/permission page answering "OK"). */
export function unexpectedBodyMessage(contentType: string, raw: string): string {
  const type = contentType.split(';')[0]?.trim() || 'sem content-type';
  const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 40).replace(/"/g, "'");
  return `Resposta inesperada do provider (${type}: "${snippet}") em vez de JSON/SSE — verifique o token e as permissões da conexão`;
}
