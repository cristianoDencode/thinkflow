import type { Connection } from '../domain/connection';
import type { ChatProbeResult, ConnectionProbe } from '../domain/ports';
import { parseQuotaFromError, parseRateLimitHeaders } from '../domain/quota';
import { providerCatalog } from '../domain/provider-catalog';
import { DomainError } from '../../../shared/kernel/errors';
import {
  buildAuthHeaders,
  extractErrorMessage,
  resolveBaseUrl,
  unexpectedBodyMessage,
  type FetchFn,
} from './provider-http';

/** Validates credentials by listing the provider's models. */
export class HttpConnectionProbe implements ConnectionProbe {
  constructor(private readonly fetchFn: FetchFn = (input, init) => fetch(input, init)) {}

  async listModels(connection: Connection): Promise<string[]> {
    const provider = providerCatalog.get(connection.providerId);
    if (!provider) throw new DomainError(`Provider desconhecido: ${connection.providerId}`);
    if (!provider.modelsUrl) return provider.suggestedModels.map((m) => m.id);
    const base = resolveBaseUrl(provider, connection);
    if (!base && !/^https?:/.test(provider.modelsUrl))
      throw new DomainError('Base URL não configurada');
    const url = /^https?:/.test(provider.modelsUrl)
      ? provider.modelsUrl
      : `${base}${provider.modelsUrl}`;

    const response = await this.fetchFn(url, {
      headers: { accept: 'application/json', ...buildAuthHeaders(provider, connection) },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new DomainError(
        `HTTP ${response.status}: ${extractErrorMessage(text) || response.statusText}`,
        'probe_failed',
        502,
      );
    }
    return parseModelIds(text);
  }

  async chat(connection: Connection, model: string): Promise<ChatProbeResult> {
    const provider = providerCatalog.get(connection.providerId);
    if (!provider) throw new DomainError(`Provider desconhecido: ${connection.providerId}`);
    const base = resolveBaseUrl(provider, connection);
    if (!base) throw new DomainError('Base URL não configurada');
    const anthropic = provider.format === 'anthropic';
    const messages = [{ role: 'user', content: 'oi' }];
    // OpenAI's own newer models reject `max_tokens`; everyone else still takes it
    const payload = anthropic
      ? { model, max_tokens: 1, messages }
      : provider.id === 'openai'
        ? { model, max_completion_tokens: 16, messages, stream: false }
        : { model, max_tokens: 1, messages, stream: false };

    let response: Response;
    try {
      response = await this.fetchFn(`${base}${anthropic ? '/v1/messages' : '/chat/completions'}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...buildAuthHeaders(provider, connection),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return { ok: false, message: fetchErrorText(err), status: null, quota: [] };
    }
    const now = Date.now();
    const text = await response.text().catch(() => '');
    const quota = parseRateLimitHeaders(response.headers, {
      providerId: provider.id,
      model,
      now,
    });
    if (!response.ok) {
      const message = extractErrorMessage(text) || response.statusText;
      if (response.status === 429) {
        const learned = parseQuotaFromError(message, now);
        if (learned) quota.push(learned);
      }
      return {
        ok: false,
        message: `HTTP ${response.status}: ${message}`,
        status: response.status,
        quota,
      };
    }
    const contentType = response.headers.get('content-type') ?? '';
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        message: text
          ? unexpectedBodyMessage(contentType, text)
          : 'Resposta vazia do provider à chamada de teste',
        status: response.status,
        quota: [],
      };
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return {
        ok: false,
        message: unexpectedBodyMessage(contentType, text),
        status: response.status,
        quota: [],
      };
    }
    const error = (json as { error?: unknown }).error;
    if (error)
      return {
        ok: false,
        message: extractErrorMessage(text) || 'O provider respondeu com erro',
        status: response.status,
        quota,
      };
    return { ok: true, message: '', status: response.status, quota };
  }
}

function fetchErrorText(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError')
    return 'Timeout ao chamar o modelo de teste';
  return err instanceof Error ? err.message : String(err);
}

export function parseModelIds(text: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const list: unknown[] = Array.isArray(json)
    ? json
    : Array.isArray((json as { data?: unknown[] }).data)
      ? (json as { data: unknown[] }).data
      : Array.isArray((json as { models?: unknown[] }).models)
        ? (json as { models: unknown[] }).models
        : [];
  const ids = list
    .map((m) => {
      if (typeof m === 'string') return m;
      const o = m as { id?: unknown; name?: unknown };
      const id = typeof o.id === 'string' ? o.id : typeof o.name === 'string' ? o.name : '';
      return id.replace(/^models\//, '');
    })
    .filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
