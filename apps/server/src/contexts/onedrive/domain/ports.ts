import type { OneDriveConnectionState } from '@thinkflow/shared';

/** `fetch`-compatible function (tests inject a fake; no live calls to Microsoft). */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface FolderRef {
  id: string;
  name: string;
  path: string;
}

export interface OneDriveTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token stops being valid. */
  expiresAt: number;
}

export interface OneDriveAccountInfo {
  id: string;
  name: string;
  email: string;
}

/** What is stored: app registration + connected account + tokens (plain text in memory only). */
export interface OneDriveRecord {
  clientId: string;
  clientSecret: string;
  redirectUriOverride: string;
  namingPattern: string;
  defaultFolder: FolderRef | null;
  state: OneDriveConnectionState;
  account: OneDriveAccountInfo | null;
  tokens: OneDriveTokens | null;
  connectedAt: number | null;
}

export interface PendingAuth {
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

export interface OneDriveStore {
  load(): OneDriveRecord;
  save(record: OneDriveRecord): void;
  putAuthRequest(state: string, request: PendingAuth): void;
  /** Returns and deletes the request (single use); null when unknown. */
  takeAuthRequest(state: string): PendingAuth | null;
  purgeAuthRequests(olderThan: number): void;
}

export interface TokenSet {
  accessToken: string;
  /** Absent when Microsoft did not rotate it: keep the stored one. */
  refreshToken: string | null;
  expiresInSec: number;
  scope: string;
}

export interface OAuthClientCredentials {
  clientId: string;
  /** Empty for a public client (no secret). */
  clientSecret: string;
}

export interface MicrosoftOAuth {
  authorizeUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    loginHint?: string;
  }): string;
  exchangeCode(
    input: OAuthClientCredentials & { redirectUri: string; code: string; codeVerifier: string },
  ): Promise<TokenSet>;
  refresh(input: OAuthClientCredentials & { refreshToken: string }): Promise<TokenSet>;
}

export interface DriveItem {
  id: string;
  name: string;
  webUrl: string;
  isFolder: boolean;
  childCount: number | null;
  /** Parent folder id (absent for the drive root). */
  parentId: string | null;
  /** Path of the parent folder as Graph reports it, already stripped of the `/drive/root:` prefix. */
  parentPath: string | null;
}

/** `next` = first byte the service still expects (it may differ from the end of the chunk). */
export type ChunkResult = { done: false; next: number } | { done: true; item: DriveItem };

export interface OneDriveGraph {
  me(token: string): Promise<OneDriveAccountInfo>;
  /** `ref` is a drive item id or `{ path }` relative to the drive root. */
  getItem(token: string, ref: { id: string } | { path: string }): Promise<DriveItem>;
  listChildren(token: string, parentId: string): Promise<DriveItem[]>;
  /** Throws OneDriveError('conflict') when the name is taken (never replaces). */
  putSmall(
    token: string,
    parentId: string,
    name: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<DriveItem>;
  /** Throws OneDriveError('conflict') when the name is taken (never replaces). */
  createUploadSession(
    token: string,
    parentId: string,
    name: string,
  ): Promise<{ uploadUrl: string }>;
  /** The upload URL is pre-authenticated: it must not receive the bearer token. */
  putChunk(
    uploadUrl: string,
    chunk: Uint8Array,
    start: number,
    total: number,
  ): Promise<ChunkResult>;
  /** First byte Microsoft is still waiting for (resume after a 416). */
  uploadStatus(uploadUrl: string): Promise<number>;
  cancelUploadSession(uploadUrl: string): Promise<void>;
  downloadPdf(token: string, itemId: string): Promise<Uint8Array>;
}
