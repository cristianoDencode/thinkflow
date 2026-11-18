import {
  comboInputSchema,
  connectionInputSchema,
  connectionUpdateSchema,
  type ComboDto,
  type ConnectionDto,
  type ConnectionUsageTodayDto,
  type ModelOptionDto,
  type ProviderDto,
  type QuotaSnapshotDto,
  type TestConnectionResultDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import type { IdGenerator } from '../../../shared/kernel/ids';
import { ConflictError, DomainError, NotFoundError } from '../../../shared/kernel/errors';
import { Combo } from '../domain/combo';
import { Connection } from '../domain/connection';
import type {
  ComboRepository,
  ConnectionProbe,
  ConnectionRepository,
  ConnectionUsageReader,
  QuotaStore,
} from '../domain/ports';
import { providerCatalog, type ProviderDefinition } from '../domain/provider-catalog';
import { activeQuota, startOfLocalDay } from '../domain/quota';
import { pickAutoModel } from '../../routing/domain/auto-model';

export interface ConnectionServiceDeps {
  connections: ConnectionRepository;
  combos: ComboRepository;
  probe: ConnectionProbe;
  quota: QuotaStore;
  usage: ConnectionUsageReader;
  clock: Clock;
  ids: IdGenerator;
}

export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  listProviders(): ProviderDto[] {
    return providerCatalog.list().map((p) => ({
      id: p.id,
      name: p.name,
      format: p.format,
      baseUrl: p.baseUrl,
      requiresApiKey: p.requiresApiKey,
      requiresBaseUrl: p.requiresBaseUrl,
      freeTier: p.freeTier,
      description: p.description,
      ...(p.keyUrl ? { keyUrl: p.keyUrl } : {}),
      suggestedModels: p.suggestedModels,
    }));
  }

  async list(): Promise<ConnectionDto[]> {
    const now = this.deps.clock.now();
    const view = this.view(now);
    return (await this.deps.connections.list()).map((c) => toDto(c, now, view(c.id)));
  }

  async create(input: unknown): Promise<ConnectionDto> {
    const data = connectionInputSchema.parse(input);
    const provider = providerCatalog.get(data.providerId);
    if (!provider) throw new DomainError(`Provider desconhecido: ${data.providerId}`);
    if (provider.requiresApiKey && !data.apiKey)
      throw new DomainError('Este provider exige uma API key');
    if (provider.requiresBaseUrl && !data.baseUrl)
      throw new DomainError('Este provider exige a Base URL');
    const connection = Connection.create(
      {
        id: this.deps.ids.next(),
        providerId: data.providerId,
        name: data.name,
        apiKey: data.apiKey,
        baseUrl: data.baseUrl,
        priority: data.priority,
        enabled: data.enabled,
        defaultModel: data.defaultModel,
      },
      this.deps.clock.now(),
    );
    await this.deps.connections.save(connection);
    return this.present(connection);
  }

  async update(id: string, input: unknown): Promise<ConnectionDto> {
    const data = connectionUpdateSchema.parse(input);
    const connection = await this.get(id);
    // empty apiKey on update means "keep current"
    connection.update({ ...data, apiKey: data.apiKey ? data.apiKey : undefined });
    await this.deps.connections.save(connection);
    return this.present(connection);
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.deps.connections.delete(id);
  }

  async resetCooldown(id: string): Promise<ConnectionDto> {
    const connection = await this.get(id);
    connection.resetCooldown();
    await this.deps.connections.save(connection);
    return this.present(connection);
  }

  async test(id: string): Promise<TestConnectionResultDto> {
    const connection = await this.get(id);
    const started = this.deps.clock.now();
    const finish = (ok: boolean, message: string, models?: string[]): TestConnectionResultDto => {
      const now = this.deps.clock.now();
      const view = this.view(now)(connection.id);
      return {
        ok,
        message,
        latencyMs: now - started,
        ...(models ? { models } : {}),
        quota: view.quota,
        usageToday: view.usageToday,
      };
    };
    let models: string[];
    try {
      models = await this.deps.probe.listModels(connection);
    } catch (err) {
      return finish(false, err instanceof Error ? err.message : String(err));
    }

    const provider = providerCatalog.get(connection.providerId);
    const model =
      provider && provider.auth !== 'none' ? pickProbeModel(connection, provider, models) : '';
    // no model list and no model to call: nothing reached the provider, so nothing was verified
    if (!model && provider && provider.auth !== 'none' && !provider.modelsUrl)
      return finish(
        false,
        'Este provider não lista modelos: informe o "Modelo padrão" da conexão para poder testar',
      );
    if (model) {
      try {
        const chat = await this.deps.probe.chat(connection, model);
        this.deps.quota.record(connection.id, chat.quota);
        if (!chat.ok)
          return finish(false, `Chamada de teste ao modelo "${model}" falhou — ${chat.message}`);
      } catch (err) {
        return finish(false, err instanceof Error ? err.message : String(err));
      }
    }
    // the credential works right now: stale errors/cooldown on the card no longer apply
    connection.registerProbeSuccess();
    await this.deps.connections.save(connection);
    return finish(
      true,
      models.length ? `Conexão OK — ${models.length} modelo(s) disponível(is)` : 'Conexão OK',
      models,
    );
  }

  async listModels(id: string): Promise<string[]> {
    return this.deps.probe.listModels(await this.get(id));
  }

  /* ----------------------------- combos ----------------------------- */

  async listCombos(): Promise<ComboDto[]> {
    return (await this.deps.combos.list()).map(comboToDto);
  }

  async createCombo(input: unknown): Promise<ComboDto> {
    const data = comboInputSchema.parse(input);
    this.assertTargets(data.targets);
    if (await this.deps.combos.findByName(data.name))
      throw new ConflictError(`Já existe um combo "${data.name}"`);
    const combo = Combo.create({
      id: this.deps.ids.next(),
      name: data.name,
      strategy: data.strategy,
      targets: data.targets,
      createdAt: this.deps.clock.now(),
    });
    await this.deps.combos.save(combo);
    return comboToDto(combo);
  }

  async updateCombo(id: string, input: unknown): Promise<ComboDto> {
    const data = comboInputSchema.parse(input);
    this.assertTargets(data.targets);
    const combo = await this.deps.combos.findById(id);
    if (!combo) throw new NotFoundError('Combo');
    const sameName = await this.deps.combos.findByName(data.name);
    if (sameName && sameName.id !== id)
      throw new ConflictError(`Já existe um combo "${data.name}"`);
    combo.update({ name: data.name, strategy: data.strategy, targets: data.targets });
    await this.deps.combos.save(combo);
    return comboToDto(combo);
  }

  async deleteCombo(id: string): Promise<void> {
    if (!(await this.deps.combos.findById(id))) throw new NotFoundError('Combo');
    await this.deps.combos.delete(id);
  }

  /** Models selectable in the chat: combos first, then each connection's default model. */
  async modelOptions(): Promise<ModelOptionDto[]> {
    const [combos, connections] = await Promise.all([
      this.deps.combos.list(),
      this.deps.connections.list(),
    ]);
    const hasEnabled = connections.some((c) => c.enabled);
    const options: ModelOptionDto[] = combos.map((c) => ({
      id: c.name,
      label: `${c.name} (combo)`,
      kind: 'combo',
    }));
    if (hasEnabled)
      options.unshift({ id: 'auto', label: 'Auto (escolhe o melhor disponível)', kind: 'combo' });
    const seen = new Set(options.map((o) => o.id));
    for (const c of connections) {
      if (!c.enabled) continue;
      const provider = providerCatalog.get(c.providerId);
      const models = c.defaultModel
        ? [c.defaultModel]
        : (provider?.suggestedModels.map((m) => m.id) ?? []);
      for (const model of models) {
        const id = `${c.providerId}/${model}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const toolCalling = provider?.suggestedModels.find((m) => m.id === model)?.toolCalling;
        options.push({
          id,
          label: `${provider?.name ?? c.providerId} · ${model}`,
          kind: 'model',
          ...(toolCalling !== undefined ? { toolCalling } : {}),
        });
      }
    }
    return options;
  }

  private assertTargets(targets: { providerId: string }[]): void {
    for (const t of targets) {
      if (!providerCatalog.has(t.providerId))
        throw new DomainError(`Provider desconhecido no combo: ${t.providerId}`);
    }
  }

  private async present(connection: Connection): Promise<ConnectionDto> {
    const now = this.deps.clock.now();
    return toDto(connection, now, this.view(now)(connection.id));
  }

  /** Per-connection quota + today's own usage, read once for however many connections follow. */
  private view(now: number): (id: string) => ConnectionView {
    const usage = this.deps.usage.since(startOfLocalDay(now));
    const quota = this.deps.quota.listAll();
    return (id) => ({
      usageToday: usage.get(id) ?? { requests: 0, tokens: 0 },
      quota: activeQuota(quota.get(id) ?? [], now),
    });
  }

  private async get(id: string): Promise<Connection> {
    const connection = await this.deps.connections.findById(id);
    if (!connection) throw new NotFoundError('Conexão');
    return connection;
  }
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

interface ConnectionView {
  usageToday: ConnectionUsageTodayDto;
  quota: QuotaSnapshotDto[];
}

/** Model for the 1-token test call: the connection's own, else a chat model from its list. */
function pickProbeModel(
  connection: Connection,
  provider: ProviderDefinition,
  models: string[],
): string {
  if (connection.defaultModel) return connection.defaultModel;
  const cheapClaude = provider.format === 'anthropic' && models.find((m) => /haiku/i.test(m));
  return cheapClaude || pickAutoModel(models) || provider.suggestedModels[0]?.id || '';
}

function toDto(c: Connection, now: number, view: ConnectionView): ConnectionDto {
  const s = c.toSnapshot();
  return {
    id: s.id,
    providerId: s.providerId,
    providerName: providerCatalog.get(s.providerId)?.name ?? s.providerId,
    name: s.name,
    apiKeyPreview: maskKey(s.apiKey),
    baseUrl: s.baseUrl,
    priority: s.priority,
    enabled: s.enabled,
    defaultModel: s.defaultModel,
    status: c.status(now),
    cooldownUntil: c.isInCooldown(now) ? s.cooldownUntil : null,
    backoffLevel: s.backoffLevel,
    lastError: s.lastError,
    lastErrorAt: s.lastErrorAt,
    lastUsedAt: s.lastUsedAt,
    successCount: s.successCount,
    failureCount: s.failureCount,
    createdAt: s.createdAt,
    usageToday: view.usageToday,
    quota: view.quota,
  };
}

function comboToDto(c: Combo): ComboDto {
  const s = c.toSnapshot();
  return {
    id: s.id,
    name: s.name,
    strategy: s.strategy,
    targets: s.targets,
    createdAt: s.createdAt,
  };
}
