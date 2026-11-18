export interface User {
  id: string;
  name: string;
  title: string;
  passwordHash: string;
  createdAt: number;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  keyHash: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface Session {
  id: string;
  expiresAt: number;
  createdAt: number;
}

export interface UserRepository {
  get(): Promise<User | null>;
  save(user: User): Promise<void>;
}

export interface SessionRepository {
  create(session: Session): Promise<void>;
  find(id: string): Promise<Session | null>;
  delete(id: string): Promise<void>;
  purgeExpired(now: number): Promise<void>;
}

export interface ApiKeyRepository {
  list(): Promise<ApiKey[]>;
  findByHash(hash: string): Promise<ApiKey | null>;
  save(key: ApiKey): Promise<void>;
  delete(id: string): Promise<void>;
  touch(id: string, now: number): Promise<void>;
}

/** Password hashing / token hashing port (implemented with node:crypto). */
export interface CredentialHasher {
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, hash: string): Promise<boolean>;
  hashToken(token: string): string;
  randomToken(): string;
}

export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
export const API_KEY_PREFIX = 'tf_';
