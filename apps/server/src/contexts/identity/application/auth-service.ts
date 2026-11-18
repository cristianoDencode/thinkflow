import {
  apiKeyInputSchema,
  loginSchema,
  profileSchema,
  setupSchema,
  type ApiKeyDto,
  type AuthStatusDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import type { IdGenerator } from '../../../shared/kernel/ids';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../../shared/kernel/errors';
import {
  API_KEY_PREFIX,
  SESSION_TTL_MS,
  type ApiKeyRepository,
  type CredentialHasher,
  type SessionRepository,
  type UserRepository,
} from '../domain/model';

export interface AuthServiceDeps {
  users: UserRepository;
  sessions: SessionRepository;
  apiKeys: ApiKeyRepository;
  hasher: CredentialHasher;
  clock: Clock;
  ids: IdGenerator;
}

export class AuthService {
  /** Keys minted at runtime for internal callers (e.g. the Agent SDK subprocess). Never persisted. */
  private readonly internalKeys = new Set<string>();

  constructor(private readonly deps: AuthServiceDeps) {}

  async status(sessionToken: string | undefined): Promise<AuthStatusDto> {
    const user = await this.deps.users.get();
    if (!user) return { setupRequired: true, authenticated: false, user: null };
    const authenticated = await this.verifySession(sessionToken);
    return {
      setupRequired: false,
      authenticated,
      user: authenticated ? { name: user.name, title: user.title } : null,
    };
  }

  async setup(input: unknown): Promise<string> {
    if (await this.deps.users.get()) throw new ConflictError('O Thinkflow já foi configurado');
    const data = setupSchema.parse(input);
    await this.deps.users.save({
      id: this.deps.ids.next(),
      name: data.name,
      title: data.title,
      passwordHash: await this.deps.hasher.hashPassword(data.password),
      createdAt: this.deps.clock.now(),
    });
    return this.createSession();
  }

  async login(input: unknown): Promise<string> {
    const { password } = loginSchema.parse(input);
    const user = await this.deps.users.get();
    if (!user || !(await this.deps.hasher.verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedError('Senha inválida');
    }
    return this.createSession();
  }

  async logout(sessionToken: string | undefined): Promise<void> {
    if (sessionToken) await this.deps.sessions.delete(this.deps.hasher.hashToken(sessionToken));
  }

  async verifySession(sessionToken: string | undefined): Promise<boolean> {
    if (!sessionToken) return false;
    const session = await this.deps.sessions.find(this.deps.hasher.hashToken(sessionToken));
    return !!session && session.expiresAt > this.deps.clock.now();
  }

  async updateProfile(input: unknown): Promise<{ name: string; title: string }> {
    const data = profileSchema.parse(input);
    const user = await this.deps.users.get();
    if (!user) throw new NotFoundError('Usuário');
    await this.deps.users.save({ ...user, name: data.name, title: data.title });
    return { name: data.name, title: data.title };
  }

  async changePassword(current: string, next: string): Promise<void> {
    const user = await this.deps.users.get();
    if (!user || !(await this.deps.hasher.verifyPassword(current, user.passwordHash))) {
      throw new UnauthorizedError('Senha atual inválida');
    }
    const parsed = setupSchema.shape.password.parse(next);
    await this.deps.users.save({
      ...user,
      passwordHash: await this.deps.hasher.hashPassword(parsed),
    });
  }

  /* ---------------------------- API keys ---------------------------- */

  async listApiKeys(): Promise<ApiKeyDto[]> {
    return (await this.deps.apiKeys.list()).map(({ keyHash: _hash, ...dto }) => dto);
  }

  async createApiKey(input: unknown): Promise<{ apiKey: ApiKeyDto; key: string }> {
    const { name } = apiKeyInputSchema.parse(input);
    const key = `${API_KEY_PREFIX}${this.deps.hasher.randomToken()}`;
    const record = {
      id: this.deps.ids.next(),
      name,
      prefix: key.slice(0, 10),
      keyHash: this.deps.hasher.hashToken(key),
      createdAt: this.deps.clock.now(),
      lastUsedAt: null,
    };
    await this.deps.apiKeys.save(record);
    const { keyHash: _hash, ...apiKey } = record;
    return { apiKey, key };
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.deps.apiKeys.delete(id);
  }

  async verifyApiKey(key: string | undefined): Promise<boolean> {
    if (!key) return false;
    if (this.internalKeys.has(key)) return true;
    const record = await this.deps.apiKeys.findByHash(this.deps.hasher.hashToken(key));
    if (!record) return false;
    void this.deps.apiKeys.touch(record.id, this.deps.clock.now());
    return true;
  }

  /** True for the keys issued to Thinkflow's own components (the app's agent mode), never for user API keys. */
  isInternalKey(key: string | undefined): boolean {
    return !!key && this.internalKeys.has(key);
  }

  issueInternalKey(): string {
    const key = `${API_KEY_PREFIX}internal_${this.deps.hasher.randomToken()}`;
    this.internalKeys.add(key);
    return key;
  }

  private async createSession(): Promise<string> {
    const token = this.deps.hasher.randomToken();
    const now = this.deps.clock.now();
    await this.deps.sessions.purgeExpired(now);
    await this.deps.sessions.create({
      id: this.deps.hasher.hashToken(token),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    return token;
  }
}
