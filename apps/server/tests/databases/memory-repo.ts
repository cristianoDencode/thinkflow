import type { DatabaseConnection } from '../../src/contexts/databases/domain/database-connection';
import type { DatabaseConnectionRepository } from '../../src/contexts/databases/domain/repository';
import { DatabaseConnection as Aggregate } from '../../src/contexts/databases/domain/database-connection';

/** In-memory repository for unit tests (stores snapshots, like a real database would). */
export class MemoryDatabaseRepository implements DatabaseConnectionRepository {
  private rows = new Map<string, ReturnType<DatabaseConnection['toSnapshot']>>();

  async list(): Promise<DatabaseConnection[]> {
    return [...this.rows.values()].map((r) => Aggregate.restore(r));
  }
  async findById(id: string): Promise<DatabaseConnection | null> {
    const r = this.rows.get(id);
    return r ? Aggregate.restore(r) : null;
  }
  async findByName(name: string): Promise<DatabaseConnection | null> {
    const r = [...this.rows.values()].find((x) => x.name === name);
    return r ? Aggregate.restore(r) : null;
  }
  async save(connection: DatabaseConnection): Promise<void> {
    this.rows.set(connection.id, connection.toSnapshot());
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
  async clearDefault(exceptId: string | null): Promise<void> {
    for (const [id, r] of this.rows)
      if (id !== exceptId) this.rows.set(id, { ...r, isDefault: false });
  }
}
