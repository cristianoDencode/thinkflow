import {
  buildAuthHeaders,
  extractErrorMessage,
  parseRetryAfter,
  resolveBaseUrl,
  unexpectedBodyMessage,
  type FetchFn,
} from '../../connections/infrastructure/provider-http';
import type { QuotaRecorder } from '../../connections/domain/ports';
import { parseRateLimitHeaders } from '../../connections/domain/quota';
import { parseSSE } from '../../protocol/domain/sse';
import {
  DEFAULT_MAX_TOKENS,
  anthropicToOpenAIRequest,
  openAIToAnthropicRequest,
  stripUnsignedThinking,
} from '../../protocol/domain/request-translators';
import { completionToChunks, messageToEvents } from '../../protocol/domain/synthesize';
import type {
  AMessageResponse,
  ARequest,
  OAICompletion,
  OAIRequest,
} from '../../protocol/domain/wire-types';
import { stripToolCallExtraContent } from '../../protocol/domain/tool-call-sanitizer';
import type { ProviderExecutor } from '../domain/ports';
import {
  UpstreamStreamError,
  type ExecutionResult,
  type ResolvedTarget,
  type RoutableRequest,
  type UpstreamEvent,
} from '../domain/types';

/** Max wait for the response headers (time to first byte); idle streams have their own limit. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 45_000;

export interface ExecutorOptions {
  /** Max wait for response headers. */
  connectTimeoutMs?: number;
  /** Max silence between two stream events. */
  idleTimeoutMs?: number;
  /** Receives the rate-limit headers of every successful answer (never throws). */
  quota?: QuotaRecorder;
  /** Clock for the observation timestamps. */
  now?: () => number;
}

const ANTHROPIC_ERROR_STATUS: Record<string, number> = {
  overloaded_error: 529,
  rate_limit_error: 429,
  api_error: 500,
  authentication_error: 401,
  permission_error: 403,
  invalid_request_error: 400,
  not_found_error: 404,
  request_too_large: 413,
};

/** Calls OpenAI-compatible or Anthropic providers, always streaming upstream. */
export class HttpProviderExecutor implements ProviderExecutor {
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly quota: QuotaRecorder | undefined;
  private readonly now: () => number;

  constructor(
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
    options: ExecutorOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 180_000;
    this.quota = options.quota;
    this.now = options.now ?? Date.now;
  }

  async execute(
    target: ResolvedTarget,
    request: RoutableRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const { provider, connection, model } = target;
    const baseUrl = resolveBaseUrl(provider, connection);
    if (!baseUrl)
      return {
        ok: false,
        failure: { status: null, message: 'Base URL não configurada na conexão' },
      };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...buildAuthHeaders(provider, connection),
    };
    let url: string;
    let payload: Record<string, unknown>;

    if (provider.format === 'openai') {
      const body: OAIRequest =
        request.format === 'openai'
          ? { ...(request.body as OAIRequest) }
          : anthropicToOpenAIRequest(request.body as ARequest);
      // `extra_content` is provider-specific and no supported provider takes it back
      if (Array.isArray(body.messages)) body.messages = stripToolCallExtraContent(body.messages);
      // DeepSeek thinking mode (on by default) 400s unless `reasoning_content` is echoed back
      // on tool turns; we don't keep it, so tool requests run with thinking disabled.
      // Docs: https://api-docs.deepseek.com/guides/thinking_mode
      if (provider.id === 'deepseek' && Array.isArray(body.tools) && body.tools.length > 0)
        (body as Record<string, unknown>).thinking ??= { type: 'disabled' };
      body.model = model;
      body.stream = true;
      if (provider.streamUsage) body.stream_options = { include_usage: true };
      else delete body.stream_options;
      url = `${baseUrl}/chat/completions`;
      payload = body;
    } else {
      const body: ARequest =
        request.format === 'anthropic'
          ? stripUnsignedThinking({ ...(request.body as ARequest) })
          : openAIToAnthropicRequest(request.body as OAIRequest);
      body.model = model;
      body.stream = true;
      body.max_tokens ||= DEFAULT_MAX_TOKENS;
      url = `${baseUrl}/v1/messages`;
      payload = body;
      const beta = request.headers?.['anthropic-beta'];
      if (beta) headers['anthropic-beta'] = beta;
    }

    const controller = new AbortController();
    const onParentAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    signal?.addEventListener('abort', onParentAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onParentAbort);
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.connectTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      cleanup();
      const message =
        controller.signal.aborted && !signal?.aborted
          ? 'Timeout ao conectar no provider'
          : errorText(err);
      const timedOut = controller.signal.aborted && !signal?.aborted;
      return {
        ok: false,
        failure: { status: null, message, ...(timedOut ? { kind: 'timeout' as const } : {}) },
      };
    }
    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      cleanup();
      return {
        ok: false,
        failure: {
          status: response.status,
          message: extractErrorMessage(text) || response.statusText || `HTTP ${response.status}`,
          retryAfterMs: parseRetryAfter(response.headers),
        },
      };
    }

    this.recordQuota(connection.id, provider.id, model, response.headers);

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('event-stream') || !response.body) {
      // Provider ignored `stream: true` — synthesize events from the JSON body.
      let json: unknown;
      let raw = '';
      try {
        raw = await response.text();
        json = JSON.parse(raw);
      } catch (err) {
        cleanup();
        return {
          ok: false,
          failure: {
            status: 502,
            kind: 'invalid_response',
            message: raw
              ? unexpectedBodyMessage(contentType, raw)
              : `Resposta inválida do provider: ${errorText(err)}`,
          },
        };
      }
      cleanup();
      const events =
        provider.format === 'openai'
          ? completionToChunks(json as OAICompletion)
          : messageToEvents(json as AMessageResponse);
      return {
        ok: true,
        stream: {
          format: provider.format,
          events: fromArray(events as unknown as UpstreamEvent[]),
        },
      };
    }

    const idleTimeoutMs = this.idleTimeoutMs;
    const format = provider.format;
    const body = response.body as unknown as AsyncIterable<Uint8Array>;

    async function* decode(): AsyncGenerator<UpstreamEvent> {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(new Error('idle timeout')), idleTimeoutMs);
      };
      armIdle();
      try {
        for await (const message of parseSSE(body)) {
          armIdle();
          if (message.data === '[DONE]') return;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(message.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (format === 'openai') {
            if (parsed.error) {
              const err = parsed.error as { message?: string; code?: number | string };
              const status = typeof err.code === 'number' ? err.code : null;
              throw new UpstreamStreamError(err.message ?? JSON.stringify(parsed.error), status);
            }
          } else {
            if (parsed.type === 'error') {
              const err = parsed.error as { type?: string; message?: string };
              throw new UpstreamStreamError(
                err?.message ?? 'Erro no stream',
                ANTHROPIC_ERROR_STATUS[err?.type ?? ''] ?? 500,
              );
            }
            if (parsed.type === 'ping') continue;
          }
          yield parsed;
        }
      } catch (err) {
        if (err instanceof UpstreamStreamError) throw err;
        if (controller.signal.aborted && !signal?.aborted)
          throw new UpstreamStreamError('Stream ocioso por tempo demais', null);
        throw new UpstreamStreamError(errorText(err), null);
      } finally {
        clearTimeout(idle);
        cleanup();
        controller.abort();
      }
    }

    return { ok: true, stream: { format, events: decode() } };
  }

  private recordQuota(
    connectionId: string,
    providerId: string,
    model: string,
    headers: Headers,
  ): void {
    if (!this.quota) return;
    try {
      const observations = parseRateLimitHeaders(headers, {
        providerId,
        model,
        now: this.now(),
      });
      if (observations.length) this.quota.record(connectionId, observations);
    } catch {
      // quota bookkeeping must never break a request
    }
  }
}

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { message?: string; code?: string } }).cause;
    return cause?.message
      ? `${err.message}: ${cause.code ?? ''} ${cause.message}`.trim()
      : err.message;
  }
  return String(err);
}
