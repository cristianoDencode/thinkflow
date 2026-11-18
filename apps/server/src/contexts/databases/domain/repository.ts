import type { DatabaseConnection } from './database-connection';

/** Persistence of the registered connections (the password is encrypted by the adapter). */
export interface DatabaseConnectionRepository {
  list(): Promise<DatabaseConnection[]>;
  findById(id: string): Promise<DatabaseConnection | null>;
  findByName(name: string): Promise<DatabaseConnection | null>;
  save(connection: DatabaseConnection): Promise<void>;
  delete(id: string): Promise<void>;
  /** Clears `is_default` on every connection except `exceptId` (null = all). */
  clearDefault(exceptId: string | null): Promise<void>;
}
