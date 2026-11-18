import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../../shared/infrastructure/db/client';
import { combos, connectionQuota, connections } from '../../../shared/infrastructure/db/schema';
import type { SecretBox } from '../../../shared/infrastructure/crypto';
import { Combo, type ComboStrategy, type ComboTarget } from '../domain/combo';
import { Connection } from '../domain/connection';
import type { ComboRepository, ConnectionRepository } from '../domain/ports';

type ConnectionRow = typeof connections.$inferSelect;

export class SqliteConnectionRepository implements ConnectionRepository {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
  ) {}

  async list(): Promise<Connection[]> {
    const rows = this.db
      .select()
      .from(connections)
      .orderBy(asc(connections.priority), asc(connections.createdAt))
      .all();
    return rows.map((r) => this.toDomain(r));
  }

  async findById(id: string): Promise<Connection | null> {
    const row = this.db.select().from(connections).where(eq(connections.id, id)).get();
    return row ? this.toDomain(row) : null;
  }

  async findByProvider(providerId: string): Promise<Connection[]> {
    const rows = this.db
      .select()
      .from(connections)
      .where(eq(connections.providerId, providerId))
      .all();
    return rows.map((r) => this.toDomain(r));
  }

  async save(connection: Connection): Promise<void> {
    const s = connection.toSnapshot();
    const row: ConnectionRow = {
      id: s.id,
      providerId: s.providerId,
      name: s.name,
      apiKeyEnc: this.secrets.encrypt(s.apiKey),
      baseUrl: s.baseUrl,
      priority: s.priority,
      enabled: s.enabled,
      defaultModel: s.defaultModel,
      cooldownUntil: s.cooldownUntil,
      backoffLevel: s.backoffLevel,
      lastError: s.lastError,
      lastErrorAt: s.lastErrorAt,
      lastUsedAt: s.lastUsedAt,
      successCount: s.successCount,
      failureCount: s.failureCount,
      createdAt: s.createdAt,
    };
    this.db
      .insert(connections)
      .values(row)
      .onConflictDoUpdate({ target: connections.id, set: row })
      .run();
  }

  async delete(id: string): Promise<void> {
    this.db.transaction((tx) => {
      tx.delete(connectionQuota).where(eq(connectionQuota.connectionId, id)).run();
      tx.delete(connections).where(eq(connections.id, id)).run();
    });
  }

  private toDomain(row: ConnectionRow): Connection {
    let apiKey: string;
    try {
      apiKey = this.secrets.decrypt(row.apiKeyEnc);
    } catch {
      apiKey = ''; // secret rotated — connection must be re-keyed
    }
    return Connection.restore({
      id: row.id,
      providerId: row.providerId,
      name: row.name,
      apiKey,
      baseUrl: row.baseUrl,
      priority: row.priority,
      enabled: row.enabled,
      defaultModel: row.defaultModel,
      cooldownUntil: row.cooldownUntil,
      backoffLevel: row.backoffLevel,
      lastError: row.lastError,
      lastErrorAt: row.lastErrorAt,
      lastUsedAt: row.lastUsedAt,
      successCount: row.successCount,
      failureCount: row.failureCount,
      createdAt: row.createdAt,
    });
  }
}

type ComboRow = typeof combos.$inferSelect;

export class SqliteComboRepository implements ComboRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<Combo[]> {
    return this.db.select().from(combos).orderBy(asc(combos.createdAt)).all().map(toCombo);
  }

  async findById(id: string): Promise<Combo | null> {
    const row = this.db.select().from(combos).where(eq(combos.id, id)).get();
    return row ? toCombo(row) : null;
  }

  async findByName(name: string): Promise<Combo | null> {
    const row = this.db.select().from(combos).where(eq(combos.name, name)).get();
    return row ? toCombo(row) : null;
  }

  async save(combo: Combo): Promise<void> {
    const s = combo.toSnapshot();
    const row: ComboRow = {
      id: s.id,
      name: s.name,
      strategy: s.strategy,
      targets: JSON.stringify(s.targets),
      createdAt: s.createdAt,
    };
    this.db.insert(combos).values(row).onConflictDoUpdate({ target: combos.id, set: row }).run();
  }

  async delete(id: string): Promise<void> {
    this.db.delete(combos).where(eq(combos.id, id)).run();
  }
}

function toCombo(row: ComboRow): Combo {
  return Combo.restore({
    id: row.id,
    name: row.name,
    strategy: row.strategy as ComboStrategy,
    targets: JSON.parse(row.targets) as ComboTarget[],
    createdAt: row.createdAt,
  });
}
