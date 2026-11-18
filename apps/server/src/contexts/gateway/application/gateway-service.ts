import type { ConnectionService } from '../../connections/application/connection-service';
import { accumulateAnthropic, accumulateOpenAI } from '../../protocol/domain/accumulators';
import {
  convertStream,
  tapUsage,
  type UsageTotals,
  type WireEvent,
  type WireFormat,
} from '../../protocol/domain/convert';
import type { AStreamEvent, OAIChunk } from '../../protocol/domain/wire-types';
import { EphemeralVaultCache } from '../../privacy/application/ephemeral-vault-cache';
import type {
  RouteChatRequest,
  RouteFailure,
  RoutePrivacyOptions,
} from '../../routing/application/route-chat-request';

export interface ProxyOpened {
  ok: true;
  /** Events already converted to the client's format. */
  events: AsyncIterable<WireEvent>;
  providerId: string;
  model: string;
  complete(error?: string): void;
}

export interface ProxyFailed {
  ok: false;
  status: number;
  body: unknown;
}

const ANTHROPIC_ERROR_TYPE: Record<string, string> = {
  rate_limited: 'rate_limit_error',
  quota_exhausted: 'rate_limit_error',
  capacity: 'overloaded_error',
  no_connection: 'overloaded_error',
  model_unavailable: 'not_found_error',
  model_not_found: 'not_found_error',
  bad_request: 'invalid_request_error',
  context_length: 'invalid_request_error',
  validation_error: 'invalid_request_error',
};

/** Who is calling /v1, as far as the privacy firewall needs to know. */
export interface GatewayClient {
  /** The API key presented (only used, hashed, to keep one in-memory vault per client). */
  apiKey?: string | undefined;
  /** The key was issued to Thinkflow's own agent mode, not to a user. */
  internal?: boolean;
  /** Value of `x-thinkflow-privacy-scope`. */
  scopeHeader?: string | undefined;
}

/** Application service behind the OpenAI/Anthropic compatible /v1 endpoints. */
export class GatewayService {
  constructor(
    private readonly router: RouteChatRequest,
    private readonly connections: ConnectionService,
    private readonly privacyVaults: EphemeralVaultCache = new EphemeralVaultCache(),
  ) {}

  /**
   * Privacy scope of a /v1 call. The client is the analyst's own tool (Claude Code...), which
   * needs real values to act, so tool arguments are restored too. Only Thinkflow's internal agent
   * may name a persistent scope (its conversation); anyone else gets an in-memory vault kept per
   * API key (and per header value) for two hours.
   */
  privacyFor(client: GatewayClient = {}): RoutePrivacyOptions {
    const header = client.scopeHeader?.trim().slice(0, 200) || undefined;
    if (client.internal && header) return { scope: header, restoreToolArgs: true };
    const key = `${client.apiKey ?? 'anonymous'}\u0000${header ?? ''}`;
    return { vault: this.privacyVaults.get(key), restoreToolArgs: true };
  }

  async open(
    format: WireFormat,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal: AbortSignal,
    client: GatewayClient = {},
  ): Promise<ProxyOpened | ProxyFailed> {
    const result = await this.router.execute(
      { format, body, headers },
      {
        source: format === 'anthropic' ? 'v1/messages' : 'v1/chat/completions',
        signal,
        privacy: this.privacyFor(client),
      },
    );
    if (!result.ok) return { ok: false, ...errorResponse(format, result) };

    const requestedModel = String(body.model ?? result.model);
    const totals: UsageTotals = { inputTokens: null, outputTokens: null };
    const events = tapUsage(
      convertStream(result.stream.events, result.stream.format, format, requestedModel),
      format,
      totals,
    );
    return {
      ok: true,
      events,
      providerId: result.providerId,
      model: result.model,
      complete: (error) => result.finish({ ...totals, ...(error ? { error } : {}) }),
    };
  }

  async collect(
    format: WireFormat,
    events: AsyncIterable<WireEvent>,
    model: string,
  ): Promise<unknown> {
    return format === 'openai'
      ? accumulateOpenAI(events as AsyncIterable<OAIChunk>, model)
      : accumulateAnthropic(events as AsyncIterable<AStreamEvent>, model);
  }

  /** Union of OpenAI and Anthropic model-list shapes, so both kinds of clients can read it. */
  async listModels(): Promise<unknown> {
    const options = await this.connections.modelOptions();
    const created = Math.floor(Date.now() / 1000);
    const data = options.map((o) => ({
      id: o.id,
      object: 'model',
      type: 'model',
      display_name: o.label,
      created,
      created_at: new Date(created * 1000).toISOString(),
      owned_by: o.kind === 'combo' ? 'thinkflow' : o.id.split('/')[0],
    }));
    return {
      object: 'list',
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
    };
  }

  /** Rough estimate (≈4 chars/token); good enough for Claude Code's context bookkeeping. */
  countTokens(body: Record<string, unknown>): { input_tokens: number } {
    const text = JSON.stringify([body.system ?? '', body.messages ?? [], body.tools ?? []]);
    return { input_tokens: Math.ceil(text.length / 4) };
  }
}

function errorResponse(
  format: WireFormat,
  failure: RouteFailure,
): { status: number; body: unknown } {
  // Upstream auth failures must not look like *our* key being invalid (clients would ask to re-login).
  const status = failure.reason === 'auth' ? 502 : failure.status;
  const details = { attempts: failure.attempts };
  if (format === 'anthropic') {
    return {
      status,
      body: {
        type: 'error',
        error: {
          type: ANTHROPIC_ERROR_TYPE[failure.reason] ?? 'api_error',
          message: failure.message,
          ...details,
        },
      },
    };
  }
  return {
    status,
    body: {
      error: { message: failure.message, type: failure.reason, code: failure.reason, ...details },
    },
  };
}
