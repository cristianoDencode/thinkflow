import type { Combo } from './combo';
import type { Connection } from './connection';
import type { QuotaObservation } from './quota';

export interface ConnectionRepository {
  list(): Promise<Connection[]>;
  findById(id: string): Promise<Connection | null>;
  findByProvider(providerId: string): Promise<Connection[]>;
  save(connection: Connection): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ComboRepository {
  list(): Promise<Combo[]>;
  findById(id: string): Promise<Combo | null>;
  findByName(name: string): Promise<Combo | null>;
  save(combo: Combo): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Outcome of the minimal real chat call used to test a connection. */
export interface ChatProbeResult {
  ok: boolean;
  /** Why it failed (HTTP status/message or an unexpected body); empty when ok. */
  message: string;
  status: number | null;
  /** Limits the provider reported in the answer (headers, or the text of a 429). */
  quota: QuotaObservation[];
}

/** Port used to probe a connection (list models / validate credentials). */
export interface ConnectionProbe {
  listModels(connection: Connection): Promise<string[]>;
  /** One 1-token chat call: proves the credential really serves completions and exposes limits. */
  chat(connection: Connection, model: string): Promise<ChatProbeResult>;
}

/** Hands over what a provider reported about its quota; fire-and-forget, never throws. */
export interface QuotaRecorder {
  record(connectionId: string, observations: QuotaObservation[]): void;
}

export interface QuotaStore extends QuotaRecorder {
  list(connectionId: string): QuotaObservation[];
  listAll(): Map<string, QuotaObservation[]>;
}

/** What this app itself sent through each connection, from its own request log. */
export interface ConnectionUsageReader {
  /** Requests (every attempt) and tokens per connection id since `sinceMs`. */
  since(sinceMs: number): Map<string, { requests: number; tokens: number }>;
}
