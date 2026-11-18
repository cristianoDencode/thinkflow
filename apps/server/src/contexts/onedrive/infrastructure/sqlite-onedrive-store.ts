import { eq, lt } from 'drizzle-orm';
import { ONEDRIVE_DEFAULT_NAMING_PATTERN, type OneDriveConnectionState } from '@thinkflow/shared';
import type { SecretBox } from '../../../shared/infrastructure/crypto';
import type { Db } from '../../../shared/infrastructure/db/client';
import { onedriveAccount, onedriveAuthRequests } from '../../../shared/infrastructure/db/schema';
import type { Clock } from '../../../shared/kernel/clock';
import type { OneDriveRecord, OneDriveStore, PendingAuth } from '../domain/ports';

const ROW_ID = 'default';
type Row = typeof onedriveAccount.$inferSelect;

const STATES: readonly OneDriveConnectionState[] = [
  'disconnected',
  'connected',
  'reconnect_required',
];

export const emptyRecord = (): OneDriveRecord => ({
  clientId: '',
  clientSecret: '',
  redirectUriOverride: '',
  namingPattern: ONEDRIVE_DEFAULT_NAMING_PATTERN,
  defaultFolder: null,
  state: 'disconnected',
  account: null,
  tokens: null,
  connectedAt: null,
});

/** Single-row store; client secret, access token, refresh token and PKCE verifiers are encrypted. */
export class SqliteOneDriveStore implements OneDriveStore {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
    private readonly clock: Clock,
  ) {}

  load(): OneDriveRecord {
    const row = this.db.select().from(onedriveAccount).where(eq(onedriveAccount.id, ROW_ID)).get();
    return row ? this.toRecord(row) : emptyRecord();
  }

  save(record: OneDriveRecord): void {
    const row: Row = {
      id: ROW_ID,
      clientId: record.clientId,
      clientSecretEnc: this.secrets.encrypt(record.clientSecret),
      redirectUriOverride: record.redirectUriOverride,
      namingPattern: record.namingPattern,
      defaultFolderId: record.defaultFolder?.id ?? null,
      defaultFolderName: record.defaultFolder?.name ?? null,
      defaultFolderPath: record.defaultFolder?.path ?? null,
      state: record.state,
      accountId: record.account?.id ?? null,
      accountName: record.account?.name ?? null,
      accountEmail: record.account?.email ?? null,
      accessTokenEnc: this.secrets.encrypt(record.tokens?.accessToken ?? ''),
      refreshTokenEnc: this.secrets.encrypt(record.tokens?.refreshToken ?? ''),
      accessTokenExpiresAt: record.tokens?.expiresAt ?? null,
      connectedAt: record.connectedAt,
      updatedAt: this.clock.now(),
    };
    this.db
      .insert(onedriveAccount)
      .values(row)
      .onConflictDoUpdate({ target: onedriveAccount.id, set: row })
      .run();
  }

  putAuthRequest(state: string, request: PendingAuth): void {
    this.db
      .insert(onedriveAuthRequests)
      .values({
        state,
        codeVerifierEnc: this.secrets.encrypt(request.codeVerifier),
        redirectUri: request.redirectUri,
        createdAt: request.createdAt,
      })
      .run();
  }

  takeAuthRequest(state: string): PendingAuth | null {
    const row = this.db
      .select()
      .from(onedriveAuthRequests)
      .where(eq(onedriveAuthRequests.state, state))
      .get();
    if (!row) return null;
    // single use, whatever happens next
    this.db.delete(onedriveAuthRequests).where(eq(onedriveAuthRequests.state, state)).run();
    return {
      codeVerifier: this.secrets.decrypt(row.codeVerifierEnc),
      redirectUri: row.redirectUri,
      createdAt: row.createdAt,
    };
  }

  purgeAuthRequests(olderThan: number): void {
    this.db.delete(onedriveAuthRequests).where(lt(onedriveAuthRequests.createdAt, olderThan)).run();
  }

  private toRecord(row: Row): OneDriveRecord {
    const refreshToken = this.safeDecrypt(row.refreshTokenEnc);
    const accessToken = this.safeDecrypt(row.accessTokenEnc);
    const state = STATES.find((s) => s === row.state) ?? 'disconnected';
    return {
      clientId: row.clientId,
      clientSecret: this.safeDecrypt(row.clientSecretEnc),
      redirectUriOverride: row.redirectUriOverride,
      namingPattern: row.namingPattern || ONEDRIVE_DEFAULT_NAMING_PATTERN,
      defaultFolder:
        row.defaultFolderId && row.defaultFolderName !== null
          ? {
              id: row.defaultFolderId,
              name: row.defaultFolderName,
              path: row.defaultFolderPath ?? `/${row.defaultFolderName}`,
            }
          : null,
      // tokens that cannot be decrypted (secret rotated) behave like a revoked consent
      state: state === 'connected' && !refreshToken ? 'reconnect_required' : state,
      account: row.accountId
        ? { id: row.accountId, name: row.accountName ?? '', email: row.accountEmail ?? '' }
        : null,
      tokens: refreshToken
        ? { accessToken, refreshToken, expiresAt: row.accessTokenExpiresAt ?? 0 }
        : null,
      connectedAt: row.connectedAt,
    };
  }

  private safeDecrypt(payload: string): string {
    try {
      return this.secrets.decrypt(payload);
    } catch {
      return '';
    }
  }
}
