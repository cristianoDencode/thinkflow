import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  close(): void;
}

/** Locates the drizzle migrations folder both in dev (src) and in the bundled build (dist). */
export function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../../../drizzle'), // src/shared/infrastructure/db -> apps/server/drizzle
    path.resolve(here, '../drizzle'), // dist -> apps/server/drizzle
    path.resolve(here, 'drizzle'),
    path.resolve(process.cwd(), 'drizzle'),
  ];
  const found = candidates.find((c) => fs.existsSync(path.join(c, 'meta', '_journal.json')));
  if (!found)
    throw new Error(`Pasta de migrations não encontrada (procurado em: ${candidates.join(', ')})`);
  return found;
}

/** Opens (or creates) the SQLite database and applies pending migrations. Use ':memory:' in tests. */
export function openDatabase(file: string, migrationsDir = defaultMigrationsDir()): DbHandle {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });
  return { db, close: () => sqlite.close() };
}
