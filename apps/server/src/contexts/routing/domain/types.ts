import type { Connection } from '../../connections/domain/connection';
import type { ProviderDefinition, WireFormat } from '../../connections/domain/provider-catalog';

export type { WireFormat };

/** A client request as received by the gateway (or built by the chat use case). */
export interface RoutableRequest {
  format: WireFormat;
  /** Original body in `format`. `model` is replaced by the resolved target model. */
  body: Record<string, unknown>;
  /** Headers worth forwarding upstream (e.g. anthropic-beta). */
  headers?: Record<string, string>;
}

export interface ResolvedTarget {
  provider: ProviderDefinition;
  connection: Connection;
  model: string;
}

/** A decoded upstream SSE event: an OpenAI chunk or an Anthropic stream event. */
export type UpstreamEvent = Record<string, unknown>;

export interface UpstreamStream {
  format: WireFormat;
  events: AsyncIterable<UpstreamEvent>;
}

export interface UpstreamFailure {
  /** HTTP status, or null for network/timeout errors. */
  status: number | null;
  message: string;
  retryAfterMs?: number | null;
  /** Set when the failure has a known shape that the HTTP status alone cannot tell. */
  kind?: 'timeout' | 'invalid_response';
}

export type ExecutionResult =
  { ok: true; stream: UpstreamStream } | { ok: false; failure: UpstreamFailure };

/** Thrown while iterating an upstream stream when the provider reports an error mid-stream. */
export class UpstreamStreamError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'UpstreamStreamError';
  }
}
