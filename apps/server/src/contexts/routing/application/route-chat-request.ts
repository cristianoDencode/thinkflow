import type { RequestAttemptDto } from '@thinkflow/shared';
import type {
  ComboRepository,
  ConnectionRepository,
  QuotaRecorder,
} from '../../connections/domain/ports';
import { parseQuotaFromError } from '../../connections/domain/quota';
import type { Connection } from '../../connections/domain/connection';
import type { ComboTarget } from '../../connections/domain/combo';
import { providerCatalog } from '../../connections/domain/provider-catalog';
import type { Clock } from '../../../shared/kernel/clock';
import type { IdGenerator } from '../../../shared/kernel/ids';
import { DomainError } from '../../../shared/kernel/errors';
import {
  classifyFailure,
  isTimeoutFailure,
  isToolUnsupported,
  TRANSIENT_REASONS,
  type FailureClassification,
} from '../domain/error-classifier';
import { decideCooldown } from '../domain/cooldown-policy';
import { selectConnections } from '../domain/connection-selector';
import { resolveModel } from '../domain/model-resolver';
import type {
  AliasSource,
  CapacityStore,
  ModelDiscovery,
  ProviderExecutor,
  RequestLogRepository,
  UsageRecorder,
} from '../domain/ports';
import { isAutoModel, isTextChatModel, pickAutoModel } from '../domain/auto-model';
import { summarizeAttempts } from '../domain/failure-summary';
import { CapacityBook, estimateTokens } from '../domain/capacity';
import type { PrivacyFirewall, ProtectResult } from '../../privacy/application/privacy-firewall';
import { restoreStream } from '../../privacy/application/restore-stream';
import type { Vault } from '../../privacy/domain/vault';
import {
  UpstreamStreamError,
  type RoutableRequest,
  type UpstreamEvent,
  type UpstreamFailure,
  type UpstreamStream,
} from '../domain/types';

export interface RouteSuccess {
  ok: true;
  stream: UpstreamStream;
  providerId: string;
  model: string;
  connectionId: string;
  attempts: RequestAttemptDto[];
  /** Must be called once the response has been fully delivered (or aborted). */
  finish(result: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    error?: string;
  }): void;
}

export interface RouteFailure {
  ok: false;
  status: number;
  reason: string;
  message: string;
  attempts: RequestAttemptDto[];
  /** Some attempt failed transiently (or candidates were only in cooldown): waiting may help. */
  retryable: boolean;
}

export type RouteResult = RouteSuccess | RouteFailure;

export interface RouteDeps {
  connections: ConnectionRepository;
  combos: ComboRepository;
  aliases: AliasSource;
  executor: ProviderExecutor;
  logs: RequestLogRepository;
  /** Optional: enables "auto" models and recovery from unknown models. */
  discovery?: ModelDiscovery;
  /** Optional: persists learned token limits across restarts. */
  capacity?: CapacityStore;
  /** Optional: aggregates token usage per day/provider/model. */
  usage?: UsageRecorder;
  /**
   * Optional personal-data firewall: when present and enabled, every request is tokenized before
   * it leaves for any provider and the tokens are restored in what comes back.
   */
  privacy?: PrivacyFirewall;
  /** Optional: remembers limits the providers reveal in 429 messages. */
  quota?: QuotaRecorder;
  clock: Clock;
  ids: IdGenerator;
}

export interface RoutePrivacyOptions {
  /** Persistent vault scope (conversation or report id); absent = a throw-away vault for this request. */
  scope?: string;
  /** A ready-made vault (e.g. the gateway's in-memory per-client one); wins over `scope`. */
  vault?: Vault;
  /**
   * Restore tokens in tool-call arguments too. Only for callers whose tools are the analyst's own
   * (the /v1 gateway): internal and MCP tools must never receive real values.
   */
  restoreToolArgs?: boolean;
}

export interface RouteOptions {
  source: string;
  signal?: AbortSignal;
  privacy?: RoutePrivacyOptions;
}

/** How many alternative models to try on one connection after "model not found". */
const MAX_MODEL_RETRIES = 6;
/** From this size on, targets known to accept more tokens are tried first. */
const LARGE_REQUEST_TOKENS = 6000;

const STATUS_BY_REASON: Record<string, number> = {
  rate_limited: 429,
  quota_exhausted: 429,
  capacity: 529,
  auth: 401,
  model_unavailable: 404,
  context_length: 400,
  bad_request: 400,
  no_connection: 503,
  invalid_response: 502,
};

/**
 * Application service: resolves the requested model into targets and tries them in
 * order, rotating through each provider's healthy connections. A failure before the
 * first streamed event falls over to the next candidate; afterwards the stream is committed.
 */
export class RouteChatRequest {
  private sequence = 0;
  private readonly modelCache = new Map<string, { at: number; models: string[] }>();
  private readonly badModels = new Map<string, Set<string>>();
  /** Models that rejected tool calling, per connection (still fine for plain chat). */
  private readonly noTools = new Map<string, Set<string>>();
  private book: CapacityBook | null = null;

  constructor(private readonly deps: RouteDeps) {}

  async execute(original: RoutableRequest, options: RouteOptions): Promise<RouteResult> {
    const { deps } = this;
    const startedAt = deps.clock.now();
    const requestedModel = String(original.body.model ?? '').trim();
    const attempts: RequestAttemptDto[] = [];
    let privacyMeta: { tokenized: number; imagesUnfiltered: number } | undefined;

    const fail = (status: number, reason: string, message: string): RouteFailure => {
      void this.log({
        startedAt,
        source: options.source,
        requestedModel,
        success: false,
        httpStatus: status,
        reason,
        attempts,
        ...(privacyMeta ?? {}),
      });
      const retryable =
        reason !== 'bad_request' &&
        attempts.some(
          (a) => TRANSIENT_REASONS.has(a.reason) || a.reason === 'no_available_connection',
        );
      return { ok: false, status, reason, message, attempts, retryable };
    };

    if (!requestedModel) return fail(400, 'bad_request', 'O campo "model" é obrigatório');

    const [combos, allConnections, aliases] = await Promise.all([
      deps.combos.list(),
      deps.connections.list(),
      deps.aliases.getAliases(),
    ]);
    const byProvider = groupByProvider(allConnections);

    let targets;
    try {
      targets = resolveModel(requestedModel, {
        findCombo: (name) => combos.find((c) => c.name === name),
        hasProvider: (id) => providerCatalog.has(id),
        hasConnectionsFor: (id) => (byProvider.get(id)?.length ?? 0) > 0,
        connectedProviders: () => [...byProvider.keys()],
        aliases,
        sequence: this.sequence++,
      }).targets;
    } catch (err) {
      if (err instanceof DomainError) return fail(err.httpStatus, err.code, err.message);
      throw err;
    }

    // The firewall runs once: every failover target gets the same protected body.
    let request = original;
    let vault: Vault | undefined;
    if (deps.privacy?.enabled()) {
      try {
        vault = options.privacy?.vault ?? deps.privacy.vaultFor(options.privacy?.scope);
        const protectedRequest = await deps.privacy.protect(original, vault);
        request = protectedRequest.request;
        privacyMeta = privacyCounts(protectedRequest);
      } catch {
        // fail closed: never send what could not be checked
        return fail(
          500,
          'privacy_error',
          'Não foi possível proteger os dados pessoais antes de enviar à IA; a requisição foi bloqueada.',
        );
      }
    }

    const estimate = estimateTokens(request.body);
    const needsTools = Array.isArray(request.body.tools) && request.body.tools.length > 0;
    targets = await this.orderByCapacity(targets, byProvider, estimate);

    let lastFailure: { classification: FailureClassification; failure: UpstreamFailure } | null =
      null;

    for (let target of targets) {
      const provider = providerCatalog.get(target.providerId);
      if (!provider) {
        attempts.push({ ...attemptBase(target), reason: 'unknown_provider' });
        continue;
      }
      const candidates = selectConnections(byProvider.get(target.providerId) ?? [], {
        now: deps.clock.now(),
        pinnedConnectionId: target.connectionId ?? null,
      });
      if (candidates.length === 0) {
        attempts.push({ ...attemptBase(target), reason: 'no_available_connection' });
        continue;
      }

      for (const connection of candidates) {
        if (options.signal?.aborted)
          return fail(499, 'aborted', 'Requisição cancelada pelo cliente');

        let model = target.model;
        const autoPicked = isAutoModel(model);
        let timeoutRetried = false;
        if (autoPicked) {
          // listing failed or returned nothing: fall back to the connection's own default
          // model, then to the catalog's suggestion, so an unreachable connection is still
          // tried (and cooled down) normally
          const picked =
            (await this.discover(connection, [], estimate, false, needsTools)) ??
            (connection.defaultModel || null) ??
            provider.suggestedModels[0]?.id ??
            null;
          if (!picked) {
            attempts.push({
              ...attemptBase(target, connection),
              reason: 'model_unavailable',
              message: 'Nenhum modelo disponível encontrado nesta conexão',
            });
            continue;
          }
          model = picked;
        }
        let used = { ...target, model };
        let outcome: Awaited<ReturnType<typeof peekFirstEvent>>;
        for (let tries = 0; ; tries++) {
          const result = await deps.executor.execute(
            { provider, connection, model },
            request,
            options.signal,
          );
          outcome = result.ok
            ? await peekFirstEvent(result.stream)
            : ({ ok: false, failure: result.failure } as const);
          if (outcome.ok) break;
          const why = classifyFailure(outcome.failure).reason;
          const noTools =
            needsTools && why === 'model_unavailable' && isToolUnsupported(outcome.failure.message);
          // A timeout is not model-specific, but an auto-picked model that never worked on this
          // connection may be the one that hangs: try a proven one once before giving up the connection.
          const timeoutOnUnproven =
            autoPicked &&
            !timeoutRetried &&
            isTimeoutFailure(outcome.failure) &&
            this.capacityBook().lastSuccessAt(connection.id, model, deps.clock.now()) === undefined;
          if (why !== 'model_unavailable' && why !== 'context_length' && !timeoutOnUnproven) break;
          if (why === 'context_length') {
            this.capacityBook().recordRejection(
              connection.id,
              model,
              estimate,
              outcome.failure.message,
              deps.clock.now(),
            );
            this.persistCapacity();
          } else if (noTools) {
            this.mark(this.noTools, connection.id, model);
          } else {
            this.mark(this.badModels, connection.id, model);
          }
          if (timeoutOnUnproven) timeoutRetried = true;
          const alt =
            tries < MAX_MODEL_RETRIES
              ? await this.discover(
                  connection,
                  [model],
                  estimate,
                  true,
                  needsTools,
                  timeoutOnUnproven,
                )
              : null;
          if (!alt) break;
          attempts.push({
            ...attemptBase(used, connection),
            status: outcome.failure.status ?? undefined,
            reason: why,
            message: `${outcome.failure.message.slice(0, 200)} — tentando "${alt}"`,
          });
          model = alt;
          used = { ...target, model: alt };
        }
        target = used;

        if (outcome.ok) {
          this.capacityBook().recordSuccess(
            connection.id,
            target.model,
            estimate,
            deps.clock.now(),
          );
          this.persistCapacity();
          connection.registerSuccess(deps.clock.now());
          await deps.connections.save(connection);
          attempts.push({ ...attemptBase(target, connection), reason: 'success' });
          let finished = false;
          return {
            ok: true,
            stream: vault
              ? {
                  format: outcome.stream.format,
                  events: restoreStream(outcome.stream.events, outcome.stream.format, vault, {
                    restoreToolArgs: options.privacy?.restoreToolArgs === true,
                  }),
                }
              : outcome.stream,
            providerId: provider.id,
            model: target.model,
            connectionId: connection.id,
            attempts,
            finish: (r) => {
              if (finished) return;
              finished = true;
              void this.log({
                startedAt,
                source: options.source,
                requestedModel,
                success: !r.error,
                httpStatus: 200,
                reason: r.error ? 'stream_error' : null,
                attempts,
                providerId: provider.id,
                model: target.model,
                connectionId: connection.id,
                inputTokens: r.inputTokens ?? null,
                outputTokens: r.outputTokens ?? null,
                estimate,
                ...(privacyMeta ?? {}),
              });
            },
          };
        }

        const classification = classifyFailure(outcome.failure);
        lastFailure = { classification, failure: outcome.failure };
        attempts.push({
          ...attemptBase(target, connection),
          status: outcome.failure.status ?? undefined,
          reason: classification.reason,
          message: outcome.failure.message.slice(0, 300),
        });
        this.learnQuota(connection, outcome.failure);
        await this.applyFailure(connection, classification, outcome.failure);

        if (classification.scope === 'fatal') {
          return fail(
            outcome.failure.status ?? 400,
            classification.reason,
            outcome.failure.message,
          );
        }
        if (classification.scope === 'target') break;
      }
    }

    if (lastFailure) {
      const { classification, failure } = lastFailure;
      const names = new Map(allConnections.map((c) => [c.id, c.name]));
      const providerCount = new Map<string, Set<string>>();
      for (const a of attempts)
        providerCount.set(
          a.providerId,
          (providerCount.get(a.providerId) ?? new Set()).add(a.connectionId ?? ''),
        );
      const label = (a: RequestAttemptDto): string => {
        // "Ollama (local)" -> "Ollama": one short name per line
        const base = (providerCatalog.get(a.providerId)?.name ?? a.providerId).replace(
          /\s*\([^)]*\)\s*$/,
          '',
        );
        const connectionName = a.connectionId ? names.get(a.connectionId) : undefined;
        return (providerCount.get(a.providerId)?.size ?? 0) > 1 && connectionName
          ? `${base} - ${connectionName}`
          : base;
      };
      return fail(
        STATUS_BY_REASON[classification.reason] ?? failure.status ?? 502,
        classification.reason,
        `Todas as conexões falharam: ${summarizeAttempts(attempts, label)}. Último erro (${classification.reason}): ${failure.message.slice(0, 300)}`,
      );
    }
    return fail(
      503,
      'no_connection',
      'Nenhuma conexão disponível para este modelo (todas desativadas, em cooldown ou não cadastradas).',
    );
  }

  /**
   * Largest input (estimate units) that every candidate (target x enabled connection x model)
   * is known to reject beyond, i.e. the max of their learned limits. Undefined when any
   * candidate has no learned limit (or "auto" models were not discovered yet): no network calls.
   */
  async inputLimitHint(model: string): Promise<number | undefined> {
    const requested = model.trim();
    if (!requested) return undefined;
    const { deps } = this;
    const [combos, allConnections, aliases] = await Promise.all([
      deps.combos.list(),
      deps.connections.list(),
      deps.aliases.getAliases(),
    ]);
    const byProvider = groupByProvider(allConnections);
    let targets: ComboTarget[];
    try {
      targets = resolveModel(requested, {
        findCombo: (name) => combos.find((c) => c.name === name),
        hasProvider: (id) => providerCatalog.has(id),
        hasConnectionsFor: (id) => (byProvider.get(id)?.length ?? 0) > 0,
        connectedProviders: () => [...byProvider.keys()],
        aliases,
        sequence: this.sequence,
      }).targets;
    } catch (err) {
      if (err instanceof DomainError) return undefined;
      throw err;
    }
    const book = this.capacityBook();
    const now = deps.clock.now();
    let hint: number | undefined;
    for (const target of targets) {
      const connections = (byProvider.get(target.providerId) ?? []).filter(
        (c) => c.enabled && (!target.connectionId || c.id === target.connectionId),
      );
      for (const connection of connections) {
        const models = isAutoModel(target.model)
          ? (this.modelCache.get(connection.id)?.models ?? [])
          : [target.model];
        if (models.length === 0) return undefined;
        for (const m of models) {
          const limit = book.limit(connection.id, m, now);
          if (limit === undefined) return undefined;
          hint = Math.max(hint ?? 0, limit);
        }
      }
    }
    return hint;
  }

  private async modelsFor(connection: Connection): Promise<string[] | null> {
    const discovery = this.deps.discovery;
    if (!discovery) return null;
    const cached = this.modelCache.get(connection.id);
    if (cached && Date.now() - cached.at < 600_000) return cached.models;
    try {
      const models = await discovery.listModels(connection);
      this.modelCache.set(connection.id, { at: Date.now(), models });
      this.badModels.delete(connection.id);
      this.noTools.delete(connection.id);
      return models;
    } catch {
      return null;
    }
  }

  /**
   * Picks a model for "auto" (or a replacement after a failure), skipping models known
   * to be broken and, when possible, those known to be too small for this request.
   * With `strict`, a model that cannot fit is never returned.
   */
  private async discover(
    connection: Connection,
    exclude: string[],
    estimate: number,
    strict = false,
    needsTools = false,
    preferProven = false,
  ): Promise<string | null> {
    const models = await this.modelsFor(connection);
    if (!models) return null;
    const blocked = [
      ...exclude,
      ...(this.badModels.get(connection.id) ?? []),
      ...(needsTools ? (this.noTools.get(connection.id) ?? []) : []),
    ];
    const book = this.capacityBook();
    const now = this.deps.clock.now();
    const fitting = models.filter((m) => book.fits(connection.id, m, estimate, now));
    // among fitting models, prefer those already known to handle requests this big, the one that
    // worked most recently on this connection first (a model proven at 30.4k serves a 31k estimate)
    const proven =
      preferProven || estimate >= LARGE_REQUEST_TOKENS
        ? fitting
            .filter(
              (m) =>
                !blocked.includes(m) &&
                isTextChatModel(m) &&
                book.isProven(connection.id, m, estimate, now),
            )
            .sort(
              (a, b) =>
                (book.lastSuccessAt(connection.id, b, now) ?? 0) -
                (book.lastSuccessAt(connection.id, a, now) ?? 0),
            )
        : [];
    return (
      proven[0] ??
      pickAutoModel(fitting, blocked, needsTools) ??
      (strict ? null : pickAutoModel(models, blocked, needsTools))
    );
  }

  /**
   * Reorders targets so that those able to take a request of this size come first.
   * Targets known to be too small are moved to the end (tried only as a last resort).
   * For large requests, targets with the largest known capacity go first.
   */
  private async orderByCapacity(
    targets: ComboTarget[],
    byProvider: Map<string, Connection[]>,
    estimate: number,
  ): Promise<ComboTarget[]> {
    const book = this.capacityBook();
    const now = this.deps.clock.now();
    const scored = await Promise.all(
      targets.map(async (target, index) => {
        const conns = (byProvider.get(target.providerId) ?? []).filter(
          (c) => c.enabled && (!target.connectionId || c.id === target.connectionId),
        );
        let fits = conns.length === 0;
        let capacity = -1;
        for (const c of conns) {
          const models = isAutoModel(target.model) ? await this.modelsFor(c) : [target.model];
          if (!models || models.length === 0) {
            fits = true; // unknown: give it a chance
            continue;
          }
          for (const m of models) {
            if (book.fits(c.id, m, estimate, now)) fits = true;
            capacity = Math.max(capacity, book.capacity(c.id, m, now) ?? -1);
          }
        }
        // 2 = known to handle this size, 1 = unknown, 0 = known too small
        const tier = !fits ? 0 : capacity >= estimate ? 2 : 1;
        return { target, index, tier, capacity };
      }),
    );
    const large = estimate >= LARGE_REQUEST_TOKENS;
    scored.sort((a, b) => {
      if (a.tier === 0 || b.tier === 0) return b.tier === 0 ? (a.tier === 0 ? 0 : -1) : 1;
      if (large && a.tier !== b.tier) return b.tier - a.tier;
      if (large && a.capacity !== b.capacity) return b.capacity - a.capacity;
      return a.index - b.index;
    });
    return scored.map((s) => s.target);
  }

  private capacityBook(): CapacityBook {
    if (!this.book) {
      let snapshot = {};
      try {
        snapshot = this.deps.capacity?.load() ?? {};
      } catch {
        // corrupt/missing data: start fresh
      }
      this.book = new CapacityBook(snapshot);
    }
    return this.book;
  }

  private persistCapacity(): void {
    try {
      this.deps.capacity?.save(this.capacityBook().snapshot());
    } catch {
      // persistence must never break a request
    }
  }

  private mark(store: Map<string, Set<string>>, connectionId: string, model: string): void {
    const set = store.get(connectionId) ?? new Set<string>();
    set.add(model);
    store.set(connectionId, set);
  }

  /** A 429 that spells out its limit ("Limit 200000, Used 199383 ... try again in 13m") is a measurement. */
  private learnQuota(connection: Connection, failure: UpstreamFailure): void {
    if (!this.deps.quota || failure.status !== 429) return;
    try {
      const learned = parseQuotaFromError(failure.message, this.deps.clock.now());
      if (learned) this.deps.quota.record(connection.id, [learned]);
    } catch {
      // quota bookkeeping must never break a request
    }
  }

  private async applyFailure(
    connection: Connection,
    classification: FailureClassification,
    failure: UpstreamFailure,
  ): Promise<void> {
    const now = this.deps.clock.now();
    const decision = decideCooldown(
      classification,
      { backoffLevel: connection.backoffLevel, retryAfterMs: failure.retryAfterMs ?? null },
      now,
    );
    if (!decision) return;
    connection.registerFailure(
      {
        message: `[${failure.status ?? 'rede'}] ${failure.message}`,
        cooldownUntil: decision.cooldownUntil,
        backoffLevel: decision.backoffLevel,
      },
      now,
    );
    await this.deps.connections.save(connection);
  }

  private recordUsage(entry: {
    source: string;
    success: boolean;
    providerId?: string | null;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    estimate?: number;
  }): void {
    if (!this.deps.usage) return;
    try {
      // failures count as a request with no tokens; successes fall back to an estimate
      const reported = entry.inputTokens != null && entry.outputTokens != null;
      const estimated = entry.success && !reported;
      this.deps.usage.record({
        at: this.deps.clock.now(),
        source: entry.source,
        providerId: entry.providerId ?? null,
        model: entry.model ?? null,
        success: entry.success,
        inputTokens: entry.inputTokens ?? (entry.success ? (entry.estimate ?? 0) : 0),
        outputTokens: entry.outputTokens ?? 0,
        estimated,
      });
    } catch {
      // usage tracking must never break a request
    }
  }

  private async log(entry: {
    startedAt: number;
    source: string;
    requestedModel: string;
    success: boolean;
    httpStatus: number | null;
    reason: string | null;
    attempts: RequestAttemptDto[];
    providerId?: string | null;
    model?: string | null;
    connectionId?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    /** Estimated input tokens, used when the provider reports none. */
    estimate?: number;
    /** Counts only (never values) of what the privacy firewall did to the request. */
    tokenized?: number;
    imagesUnfiltered?: number;
  }): Promise<void> {
    this.recordUsage(entry);
    try {
      await this.deps.logs.add({
        id: this.deps.ids.next(),
        createdAt: entry.startedAt,
        source: entry.source,
        requestedModel: entry.requestedModel,
        providerId: entry.providerId ?? null,
        model: entry.model ?? null,
        connectionId: entry.connectionId ?? null,
        success: entry.success,
        httpStatus: entry.httpStatus,
        reason: entry.reason,
        latencyMs: this.deps.clock.now() - entry.startedAt,
        inputTokens: entry.inputTokens ?? null,
        outputTokens: entry.outputTokens ?? null,
        attempts: entry.attempts,
        ...(entry.tokenized !== undefined ? { privacyTokenized: entry.tokenized } : {}),
        ...(entry.imagesUnfiltered !== undefined
          ? { imagesUnfiltered: entry.imagesUnfiltered }
          : {}),
      });
    } catch {
      // logging must never break a request
    }
  }
}

function privacyCounts(result: ProtectResult): { tokenized: number; imagesUnfiltered: number } {
  return {
    tokenized: Object.values(result.tokenized).reduce((sum, n) => sum + n, 0),
    imagesUnfiltered: result.imagesUnfiltered,
  };
}

function groupByProvider(connections: Connection[]): Map<string, Connection[]> {
  const map = new Map<string, Connection[]>();
  for (const c of connections) {
    const list = map.get(c.providerId) ?? [];
    list.push(c);
    map.set(c.providerId, list);
  }
  return map;
}

function attemptBase(
  target: { providerId: string; model: string },
  connection?: Connection,
): Omit<RequestAttemptDto, 'reason'> {
  return {
    providerId: target.providerId,
    model: target.model,
    connectionId: connection?.id ?? null,
  };
}

/**
 * Waits for the first upstream event so that failures surfacing at stream start
 * (errors sent as the first SSE frame, connection resets) can still fall over.
 */
export async function peekFirstEvent(
  stream: UpstreamStream,
): Promise<{ ok: true; stream: UpstreamStream } | { ok: false; failure: UpstreamFailure }> {
  const iterator = stream.events[Symbol.asyncIterator]();
  let first: IteratorResult<UpstreamEvent>;
  try {
    first = await iterator.next();
  } catch (err) {
    const status = err instanceof UpstreamStreamError ? err.status : null;
    return { ok: false, failure: { status, message: errorMessage(err) } };
  }
  if (first.done) {
    return {
      ok: false,
      failure: { status: 502, message: 'O provider encerrou o stream sem conteúdo' },
    };
  }
  const head = first.value;
  async function* replay(): AsyncGenerator<UpstreamEvent> {
    let completed = false;
    try {
      yield head;
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          completed = true;
          return;
        }
        yield next.value;
      }
    } finally {
      // consumer stopped early (client disconnected): release the upstream connection
      if (!completed) await iterator.return?.();
    }
  }
  return { ok: true, stream: { format: stream.format, events: replay() } };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
