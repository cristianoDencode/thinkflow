import {
  columnRuleInputSchema,
  DATABASE_LIMITS,
  databaseConnectionInputSchema,
  databaseConnectionUpdateSchema,
  type AiReviewDto,
  type ColumnRuleDto,
  type DatabaseConnectionDto,
  type DatabaseTestResultDto,
  type MetadataMcpServerDto,
  type QueryResultDto,
  type SqlValidationDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { ConflictError, DomainError, NotFoundError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import type { ColumnRuleRepository } from '../../privacy/domain/ports';
import type { Vault } from '../../privacy/domain/vault';
import { DatabaseConnection } from '../domain/database-connection';
import type { MetadataLookup, PgGateway } from '../domain/ports';
import type { DatabaseConnectionRepository } from '../domain/repository';
import { buildDataChatTools, type DataChatToolsShape, type ReviewDecision } from './data-toolset';
import { friendlyConnectError } from './pg-errors';
import { checkSqlWithoutRunning } from './check-sql';
import { runGuardedQuery } from './run-query';

export type { DataChatToolsShape } from './data-toolset';

export interface DatabaseServiceDeps {
  repo: DatabaseConnectionRepository;
  gateway: PgGateway;
  clock: Clock;
  ids: IdGenerator;
  /** What the AI may see of each column (privacy rules per connection). */
  rules: ColumnRuleRepository;
  /** Optional data dictionary (e.g. an MCP server) used to suggest names in SQL validation. */
  metadata?: MetadataLookup;
}

const WRITE_WARNING =
  'Conectado. Atenção: este usuário pode alterar dados — o Thinkflow só executa leitura, mas prefira um usuário somente leitura.';

/** Registered Postgres connections + the read-only query/tool surface of "Dados com IA". */
export class DatabaseService {
  constructor(private readonly deps: DatabaseServiceDeps) {}

  async list(): Promise<DatabaseConnectionDto[]> {
    const all = await this.deps.repo.list();
    return all
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
      .map(toDto);
  }

  async get(id: string): Promise<DatabaseConnectionDto> {
    return toDto(await this.require(id));
  }

  async create(body: unknown): Promise<DatabaseConnectionDto> {
    const data = databaseConnectionInputSchema.parse(body);
    const existing = await this.deps.repo.list();
    if (existing.length >= DATABASE_LIMITS.maxConnections)
      throw new DomainError(
        `Limite de ${DATABASE_LIMITS.maxConnections} conexões de banco atingido`,
        'limit_reached',
        400,
      );
    if (await this.deps.repo.findByName(data.name))
      throw new ConflictError(`Já existe uma conexão de banco chamada "${data.name}"`);

    const connection = DatabaseConnection.create(
      { ...data, isDefault: data.isDefault || existing.length === 0 },
      this.deps.clock.now(),
      this.deps.ids.next(),
    );
    if (connection.isDefault) await this.deps.repo.clearDefault(connection.id);
    await this.deps.repo.save(connection);
    return toDto(connection);
  }

  async update(id: string, body: unknown): Promise<DatabaseConnectionDto> {
    const parsed = databaseConnectionUpdateSchema.parse(body);
    // zod fills the defaults of fields that were not sent: an edit must only touch what was sent
    const sent = (body ?? {}) as Record<string, unknown>;
    const data = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key in sent),
    ) as typeof parsed;
    const connection = await this.require(id);
    if (data.name && data.name !== connection.name) {
      const same = await this.deps.repo.findByName(data.name);
      if (same && same.id !== id)
        throw new ConflictError(`Já existe uma conexão de banco chamada "${data.name}"`);
    }
    const { password, ...rest } = data;
    connection.update(
      // empty/absent password keeps the stored one
      { ...rest, ...(password ? { password } : {}) },
      this.deps.clock.now(),
    );
    if (data.isDefault) await this.deps.repo.clearDefault(id);
    await this.deps.repo.save(connection);
    await this.deps.gateway.invalidate(id);
    return toDto(connection);
  }

  async delete(id: string): Promise<void> {
    const connection = await this.require(id);
    await this.deps.repo.delete(id);
    await this.deps.gateway.invalidate(id);
    if (connection.isDefault) {
      const next = (await this.deps.repo.list()).sort((a, b) => a.name.localeCompare(b.name))[0];
      if (next) {
        next.setDefault(true);
        await this.deps.repo.save(next);
      }
    }
  }

  /** Never throws (besides "not found"): failures come back as `ok: false` with a pt-BR message. */
  async test(id: string): Promise<DatabaseTestResultDto> {
    const connection = await this.require(id);
    const params = connection.toParams();
    const started = this.deps.clock.now();
    try {
      const info = await this.deps.gateway.test(params);
      return {
        ok: true,
        message: info.canWrite ? WRITE_WARNING : 'Conexão OK — acesso somente leitura.',
        latencyMs: this.deps.clock.now() - started,
        serverVersion: info.serverVersion,
        currentUser: info.currentUser,
        canWrite: info.canWrite,
      };
    } catch (err) {
      return {
        ok: false,
        message: friendlyConnectError(err, params),
        latencyMs: this.deps.clock.now() - started,
        serverVersion: null,
        currentUser: null,
        canWrite: null,
      };
    }
  }

  /** The analyst's own SQL. Never throws (besides "not found"): errors go in `result.error`. */
  async runDirect(id: string, sql: string, signal?: AbortSignal): Promise<QueryResultDto> {
    const connection = await this.require(id);
    const { result } = await runGuardedQuery(
      {
        connection,
        gateway: this.deps.gateway,
        newId: () => this.deps.ids.next(),
        metadata: this.deps.metadata,
      },
      { sql, source: 'direct', purpose: null, ...(signal ? { signal } : {}) },
    );
    return result;
  }

  /**
   * Checks a SQL against the database WITHOUT running it (guard + names + EXPLAIN). Never throws
   * (besides "not found"): an unreachable database comes back as `unchecked`.
   */
  async validate(id: string, sql: string, signal?: AbortSignal): Promise<SqlValidationDto> {
    const connection = await this.require(id);
    const { validation } = await checkSqlWithoutRunning(
      {
        connection,
        gateway: this.deps.gateway,
        newId: () => this.deps.ids.next(),
        metadata: this.deps.metadata,
      },
      { sql, source: 'direct', ...(signal ? { signal } : {}) },
    );
    return validation;
  }

  /** Enabled MCP servers that expose a data dictionary (for the connection's settings). */
  async metadataServers(): Promise<MetadataMcpServerDto[]> {
    return this.deps.metadata ? this.deps.metadata.listServers() : [];
  }

  /** Projects of a dictionary server (`list_projects`); empty when it is unreachable. */
  async metadataProjects(serverId: string): Promise<string[]> {
    return this.deps.metadata ? this.deps.metadata.listProjects(serverId) : [];
  }

  async name(id: string): Promise<string | null> {
    return (await this.deps.repo.findById(id))?.name ?? null;
  }

  /** Per-turn tools for the chat's data mode; `null` when the connection no longer exists. */
  async chatTools(
    id: string,
    opts: {
      maxOutputChars: number;
      onResult: (r: QueryResultDto) => void;
      /** Vault of the conversation (reversible tokens). */
      vault?: Vault;
      /** Asks the analyst about unclassified columns (see `buildDataChatTools`). */
      requestReview?: (review: AiReviewDto, signal?: AbortSignal) => Promise<ReviewDecision[]>;
    },
  ): Promise<DataChatToolsShape | null> {
    const connection = await this.deps.repo.findById(id);
    if (!connection) return null;
    return buildDataChatTools({
      connection,
      gateway: this.deps.gateway,
      newId: () => this.deps.ids.next(),
      maxOutputChars: opts.maxOutputChars,
      onResult: opts.onResult,
      rules: this.deps.rules,
      ...(this.deps.metadata ? { metadata: this.deps.metadata } : {}),
      ...(opts.vault ? { vault: opts.vault } : {}),
      ...(opts.requestReview ? { requestReview: opts.requestReview } : {}),
    });
  }

  /* ------------------------- AI privacy rules ------------------------- */

  async listRules(id: string): Promise<ColumnRuleDto[]> {
    await this.require(id);
    return this.deps.rules.list(id);
  }

  /** Creates or replaces the rule for (schema, table, column); always an analyst decision. */
  async saveRule(id: string, body: unknown): Promise<ColumnRuleDto> {
    await this.require(id);
    const data = columnRuleInputSchema.parse(body);
    return this.deps.rules.upsert({ ...data, connectionId: id, origin: 'analyst' });
  }

  async deleteRule(id: string, ruleId: string): Promise<void> {
    await this.require(id);
    await this.deps.rules.delete(id, ruleId);
  }

  private async require(id: string): Promise<DatabaseConnection> {
    const connection = await this.deps.repo.findById(id);
    if (!connection) throw new NotFoundError('Conexão de banco');
    return connection;
  }
}

function toDto(c: DatabaseConnection): DatabaseConnectionDto {
  const s = c.toSnapshot();
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    database: s.database,
    user: s.user,
    passwordSet: s.password !== '',
    sslMode: s.sslMode,
    schemas: s.schemas,
    aiAccess: s.aiAccess,
    sampleRows: s.sampleRows,
    sensitiveColumns: s.sensitiveColumns,
    revealColumns: s.revealColumns,
    statementTimeoutSec: s.statementTimeoutSec,
    maxRows: s.maxRows,
    isDefault: s.isDefault,
    metadataMcpServerId: s.metadataMcpServerId,
    metadataMcpProject: s.metadataMcpProject,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
