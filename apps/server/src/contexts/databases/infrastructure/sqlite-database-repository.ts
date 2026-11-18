import { asc, eq, ne } from 'drizzle-orm';
import type { DatabaseAiAccess, DatabaseSslMode } from '@thinkflow/shared';
import type { SecretBox } from '../../../shared/infrastructure/crypto';
import type { Db } from '../../../shared/infrastructure/db/client';
import { databaseConnections } from '../../../shared/infrastructure/db/schema';
import { DatabaseConnection } from '../domain/database-connection';
import type { DatabaseConnectionRepository } from '../domain/repository';

type Row = typeof databaseConnections.$inferSelect;

function parseList(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export class SqliteDatabaseConnectionRepository implements DatabaseConnectionRepository {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
  ) {}

  async list(): Promise<DatabaseConnection[]> {
    return this.db
      .select()
      .from(databaseConnections)
      .orderBy(asc(databaseConnections.name))
      .all()
      .map((r) => this.toDomain(r));
  }

  async findById(id: string): Promise<DatabaseConnection | null> {
    const row = this.db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, id))
      .get();
    return row ? this.toDomain(row) : null;
  }

  async findByName(name: string): Promise<DatabaseConnection | null> {
    const row = this.db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.name, name))
      .get();
    return row ? this.toDomain(row) : null;
  }

  async save(connection: DatabaseConnection): Promise<void> {
    const s = connection.toSnapshot();
    const row: Row = {
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      database: s.database,
      user: s.user,
      passwordEnc: this.secrets.encrypt(s.password),
      sslMode: s.sslMode,
      schemas: JSON.stringify(s.schemas),
      aiAccess: s.aiAccess,
      sampleRows: s.sampleRows,
      sensitiveColumns: JSON.stringify(s.sensitiveColumns),
      revealColumns: JSON.stringify(s.revealColumns),
      statementTimeoutSec: s.statementTimeoutSec,
      maxRows: s.maxRows,
      isDefault: s.isDefault,
      metadataMcpServerId: s.metadataMcpServerId,
      metadataMcpProject: s.metadataMcpProject,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
    this.db
      .insert(databaseConnections)
      .values(row)
      .onConflictDoUpdate({ target: databaseConnections.id, set: row })
      .run();
  }

  async delete(id: string): Promise<void> {
    this.db.delete(databaseConnections).where(eq(databaseConnections.id, id)).run();
  }

  async clearDefault(exceptId: string | null): Promise<void> {
    const q = this.db.update(databaseConnections).set({ isDefault: false });
    if (exceptId === null) q.run();
    else q.where(ne(databaseConnections.id, exceptId)).run();
  }

  private toDomain(row: Row): DatabaseConnection {
    let password: string;
    try {
      password = this.secrets.decrypt(row.passwordEnc);
    } catch {
      password = ''; // secret rotated — the password must be typed again
    }
    return DatabaseConnection.restore({
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      database: row.database,
      user: row.user,
      password,
      sslMode: row.sslMode as DatabaseSslMode,
      schemas: parseList(row.schemas),
      aiAccess: row.aiAccess as DatabaseAiAccess,
      sampleRows: row.sampleRows,
      sensitiveColumns: parseList(row.sensitiveColumns),
      revealColumns: parseList(row.revealColumns),
      statementTimeoutSec: row.statementTimeoutSec,
      maxRows: row.maxRows,
      isDefault: row.isDefault,
      metadataMcpServerId: row.metadataMcpServerId,
      metadataMcpProject: row.metadataMcpProject,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
