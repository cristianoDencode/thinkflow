import type { Connection } from '../../connections/domain/connection';
import type { CapacitySnapshot } from './capacity';
import type { ModelAliases, RequestAttemptDto } from '@thinkflow/shared';
import type { ExecutionResult, ResolvedTarget, RoutableRequest } from './types';

export interface ProviderExecutor {
  execute(
    target: ResolvedTarget,
    request: RoutableRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionResult>;
}

export interface RequestLogEntry {
  id: string;
  createdAt: number;
  source: string;
  requestedModel: string;
  providerId: string | null;
  model: string | null;
  connectionId: string | null;
  success: boolean;
  httpStatus: number | null;
  reason: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  attempts: RequestAttemptDto[];
  /** Counts only, never values: spans the privacy firewall replaced / images that went unfiltered. */
  privacyTokenized?: number | null;
  imagesUnfiltered?: number | null;
}

export interface RequestLogRepository {
  add(entry: RequestLogEntry): Promise<void>;
  list(limit: number): Promise<RequestLogEntry[]>;
}

export interface AliasSource {
  getAliases(): Promise<ModelAliases>;
}

/** Lists the models a connection can actually use right now. */
export interface ModelDiscovery {
  listModels(connection: Connection): Promise<string[]>;
}

/** Persists what the router learned about each connection/model's token capacity. */
export interface CapacityStore {
  load(): CapacitySnapshot;
  save(snapshot: CapacitySnapshot): void;
}

/** Receives one record per finished request, for usage reports. Must never throw. */
export interface UsageRecorder {
  record(e: {
    at: number;
    source: string;
    providerId: string | null;
    model: string | null;
    success: boolean;
    inputTokens: number;
    outputTokens: number;
    /** True when the provider did not report some of the token counts. */
    estimated: boolean;
  }): void;
}
