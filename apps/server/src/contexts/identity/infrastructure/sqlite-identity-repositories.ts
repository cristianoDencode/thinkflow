import { asc, eq, lt } from 'drizzle-orm';
import type { Db } from '../../../shared/infrastructure/db/client';
import { apiKeys, sessions, users } from '../../../shared/infrastructure/db/schema';
import {
  hashPassword,
  randomToken,
  sha256,
  verifyPassword,
} from '../../../shared/infrastructure/crypto';
import type {
  ApiKey,
  ApiKeyRepository,
  CredentialHasher,
  Session,
  SessionRepository,
  User,
  UserRepository,
} from '../domain/model';

export class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  async get(): Promise<User | null> {
    return this.db.select().from(users).orderBy(asc(users.createdAt)).limit(1).get() ?? null;
  }

  async save(user: User): Promise<void> {
    this.db.insert(users).values(user).onConflictDoUpdate({ target: users.id, set: user }).run();
  }
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: Db) {}

  async create(session: Session): Promise<void> {
    this.db.insert(sessions).values(session).run();
  }

  async find(id: string): Promise<Session | null> {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get() ?? null;
  }

  async delete(id: string): Promise<void> {
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
  }

  async purgeExpired(now: number): Promise<void> {
    this.db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  }
}

export class SqliteApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<ApiKey[]> {
    return this.db.select().from(apiKeys).orderBy(asc(apiKeys.createdAt)).all();
  }

  async findByHash(hash: string): Promise<ApiKey | null> {
    return this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).get() ?? null;
  }

  async save(key: ApiKey): Promise<void> {
    this.db.insert(apiKeys).values(key).onConflictDoUpdate({ target: apiKeys.id, set: key }).run();
  }

  async delete(id: string): Promise<void> {
    this.db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
  }

  async touch(id: string, now: number): Promise<void> {
    this.db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, id)).run();
  }
}

export const nodeCredentialHasher: CredentialHasher = {
  hashPassword,
  verifyPassword,
  hashToken: sha256,
  randomToken: () => randomToken(24),
};
