import {
  ONEDRIVE_DEFAULT_NAMING_PATTERN,
  type OneDriveFolderListingDto,
  type OneDriveFolderRefDto,
  type OneDriveSettingsUpdate,
  type OneDriveStatusDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import {
  CHUNK_UNIT,
  DEFAULT_CHUNK_SIZE,
  DOCX_CONTENT_TYPE,
  ONEDRIVE_SCOPES,
  SMALL_UPLOAD_LIMIT,
} from '../domain/constants';
import { notConfigured, notConnected, OneDriveError, reconnectRequired } from '../domain/errors';
import { buildFileName, sanitizeFileName, withCounter, type NamingVars } from '../domain/file-name';
import { codeChallengeS256, newCodeVerifier, newState } from '../domain/pkce';
import type {
  DriveItem,
  FolderRef,
  MicrosoftOAuth,
  OneDriveGraph,
  OneDriveRecord,
  OneDriveStore,
  TokenSet,
} from '../domain/ports';

const AUTH_REQUEST_TTL_MS = 10 * 60_000;
/** Refresh a little before the token really expires. */
const EXPIRY_SKEW_MS = 60_000;
const MAX_NAME_ATTEMPTS = 50;
const CHUNK_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 60_000;

export interface OneDriveServiceDeps {
  store: OneDriveStore;
  oauth: MicrosoftOAuth;
  graph: OneDriveGraph;
  clock: Clock;
  /** Waits between retries (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
  /** Overrides for tests: smaller files exercise the upload session without megabytes of data. */
  smallUploadLimit?: number;
  chunkSize?: number;
}

export interface UploadDocumentInput {
  /** Drive item id of the destination folder. Wins over `path`. */
  folderId?: string;
  /** Folder path from the drive root ("/Testes/2026"). Used when `folderId` is absent. */
  path?: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface UploadedDocument {
  id: string;
  webUrl: string;
  /** Final name in OneDrive: differs from `fileName` when " (2)" was needed. */
  name: string;
}

export interface OAuthCallbackInput {
  code?: string;
  state?: string;
  error?: string;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Warns about redirect URIs Microsoft will not accept. */
export function redirectUriWarning(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'URI de redirecionamento inválida.';
  }
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') {
    return 'O portal da Microsoft não aceita "http://127.0.0.1" no campo de URI. Abra o app por http://localhost:<porta> ou use HTTPS.';
  }
  if (url.protocol === 'http:' && url.hostname !== 'localhost') {
    return 'A Microsoft só aceita "http" em localhost. Para outro endereço, use HTTPS (ou informe a URI manualmente).';
  }
  return null;
}

export class OneDriveService {
  private readonly store: OneDriveStore;
  private readonly oauth: MicrosoftOAuth;
  private readonly graph: OneDriveGraph;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly smallLimit: number;
  private readonly chunkSize: number;
  private refreshing: Promise<string> | null = null;

  constructor(deps: OneDriveServiceDeps) {
    this.store = deps.store;
    this.oauth = deps.oauth;
    this.graph = deps.graph;
    this.clock = deps.clock;
    this.sleep = deps.sleep ?? realSleep;
    this.smallLimit = deps.smallUploadLimit ?? SMALL_UPLOAD_LIMIT;
    const chunk = deps.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (chunk <= 0 || chunk % CHUNK_UNIT !== 0) {
      throw new Error('chunkSize precisa ser múltiplo de 320 KiB');
    }
    this.chunkSize = chunk;
  }

  /* ---------------------------- settings / status ---------------------------- */

  /** `derivedRedirectUri` comes from the address the browser used to reach the server. */
  status(derivedRedirectUri: string): OneDriveStatusDto {
    const r = this.store.load();
    const redirectUri = r.redirectUriOverride || derivedRedirectUri;
    return {
      clientId: r.clientId,
      hasClientSecret: r.clientSecret !== '',
      redirectUri,
      redirectUriOverride: r.redirectUriOverride,
      redirectUriWarning: redirectUriWarning(redirectUri),
      state: r.state,
      account: r.account ? { name: r.account.name, email: r.account.email } : null,
      connectedAt: r.connectedAt,
      defaultFolder: r.defaultFolder,
      namingPattern: r.namingPattern,
      defaultNamingPattern: ONEDRIVE_DEFAULT_NAMING_PATTERN,
      scopes: [...ONEDRIVE_SCOPES],
    };
  }

  updateSettings(update: OneDriveSettingsUpdate): void {
    const r = this.store.load();
    const next: OneDriveRecord = { ...r };
    if (update.clientId !== undefined) next.clientId = update.clientId;
    if (update.clearClientSecret) next.clientSecret = '';
    else if (update.clientSecret) next.clientSecret = update.clientSecret;
    if (update.namingPattern !== undefined) next.namingPattern = update.namingPattern;
    if (update.redirectUriOverride !== undefined)
      next.redirectUriOverride = update.redirectUriOverride;

    // tokens belong to one app registration: changing it requires connecting again
    const registrationChanged =
      next.clientId !== r.clientId || next.clientSecret !== r.clientSecret;
    if (registrationChanged && r.state !== 'disconnected') {
      next.state = 'disconnected';
      next.tokens = null;
      next.connectedAt = null;
    }
    this.store.save(next);
  }

  suggestFileName(vars: NamingVars): string {
    return buildFileName(this.store.load().namingPattern, vars);
  }

  /* ------------------------------ authorization ------------------------------ */

  /** Starts the authorization code + PKCE flow; the browser must be sent to the returned URL. */
  startAuthorization(derivedRedirectUri: string): { authorizeUrl: string } {
    const r = this.store.load();
    if (!r.clientId) throw notConfigured();
    const redirectUri = r.redirectUriOverride || derivedRedirectUri;
    const now = this.clock.now();
    this.store.purgeAuthRequests(now - AUTH_REQUEST_TTL_MS);

    const state = newState();
    const codeVerifier = newCodeVerifier();
    this.store.putAuthRequest(state, { codeVerifier, redirectUri, createdAt: now });
    const loginHint = r.state === 'reconnect_required' ? r.account?.email : undefined;
    return {
      authorizeUrl: this.oauth.authorizeUrl({
        clientId: r.clientId,
        redirectUri,
        state,
        codeChallenge: codeChallengeS256(codeVerifier),
        ...(loginHint ? { loginHint } : {}),
      }),
    };
  }

  /** Finishes the flow from the redirect Microsoft sent to our callback route. */
  async completeAuthorization(input: OAuthCallbackInput): Promise<void> {
    // the pending request is consumed first: a state is valid exactly once
    const pending = input.state ? this.store.takeAuthRequest(input.state) : null;
    if (!pending || this.clock.now() - pending.createdAt > AUTH_REQUEST_TTL_MS) {
      throw new OneDriveError(
        'invalid_state',
        'Solicitação de login inválida ou expirada. Clique em Conectar de novo.',
      );
    }
    if (input.error) {
      throw new OneDriveError(
        'bad_request',
        input.error === 'access_denied'
          ? 'A autorização do OneDrive foi cancelada.'
          : `A Microsoft não concluiu o login (${input.error.slice(0, 60)}).`,
      );
    }
    if (!input.code) {
      throw new OneDriveError('bad_request', 'A Microsoft não devolveu o código de autorização.');
    }

    const r = this.store.load();
    if (!r.clientId) throw notConfigured();
    const tokens = await this.oauth.exchangeCode({
      clientId: r.clientId,
      clientSecret: r.clientSecret,
      redirectUri: pending.redirectUri,
      code: input.code,
      codeVerifier: pending.codeVerifier,
    });
    if (!tokens.refreshToken) {
      throw new OneDriveError(
        'upstream',
        'A Microsoft não devolveu o token de renovação (permissão offline_access).',
      );
    }
    const account = await this.graph.me(tokens.accessToken);
    const sameAccount = r.account?.id === account.id;
    this.store.save({
      ...r,
      state: 'connected',
      account,
      tokens: this.toStored(tokens, tokens.refreshToken),
      connectedAt: this.clock.now(),
      // a folder id of another account would be meaningless
      defaultFolder: sameAccount ? r.defaultFolder : null,
    });
  }

  /** Forgets the tokens and the account (the app registration settings stay). */
  disconnect(): void {
    const r = this.store.load();
    this.store.save({
      ...r,
      state: 'disconnected',
      account: null,
      tokens: null,
      connectedAt: null,
    });
  }

  /* ---------------------------------- folders --------------------------------- */

  async listFolder(folderId: string | null): Promise<OneDriveFolderListingDto> {
    const id = folderId || 'root';
    return this.withToken(async (token) => {
      if (id === 'root') {
        return {
          parent: { id: 'root', name: 'OneDrive', path: '/', parentId: null },
          folders: toFolders(await this.graph.listChildren(token, id)),
        };
      }
      const [children, self] = await Promise.all([
        this.graph.listChildren(token, id),
        this.graph.getItem(token, { id }),
      ]);
      const parent = {
        id: self.id,
        name: self.name,
        path: joinPath(self.parentPath, self.name),
        parentId: self.parentId,
      };
      return {
        parent,
        folders: toFolders(children),
      };
    });
  }

  /** Validates the folder in OneDrive and stores it as the default destination (null clears). */
  async setDefaultFolder(folderId: string | null): Promise<OneDriveFolderRefDto | null> {
    const r = this.store.load();
    if (folderId === null) {
      this.store.save({ ...r, defaultFolder: null });
      return null;
    }
    const folder = await this.withToken((token) => this.graph.getItem(token, { id: folderId }));
    if (!folder.isFolder) {
      throw new OneDriveError('bad_request', 'O item escolhido não é uma pasta.');
    }
    const ref: FolderRef = {
      id: folder.id,
      name: folder.name,
      path: folderId === 'root' ? '/' : joinPath(folder.parentPath, folder.name),
    };
    this.store.save({ ...this.store.load(), defaultFolder: ref });
    return ref;
  }

  /* ---------------------------------- upload ---------------------------------- */

  /**
   * Creates a NEW file in OneDrive and returns where to open it. It never replaces an existing
   * file: on a name clash it tries "name (2).ext", "name (3).ext", ...
   */
  async uploadNewDocument(input: UploadDocumentInput): Promise<UploadedDocument> {
    const baseName = sanitizeFileName(input.fileName);
    const { parentId, fromDefault } = await this.resolveParent(input);
    const contentType = baseName.toLowerCase().endsWith('.docx')
      ? DOCX_CONTENT_TYPE
      : 'application/octet-stream';

    let item: DriveItem | null = null;
    for (let n = 1; n <= MAX_NAME_ATTEMPTS && !item; n++) {
      const name = withCounter(baseName, n);
      try {
        item =
          input.bytes.byteLength < this.smallLimit
            ? await this.withToken((token) =>
                this.graph.putSmall(token, parentId, name, input.bytes, contentType),
              )
            : await this.uploadWithSession(parentId, name, input.bytes);
      } catch (err) {
        if (err instanceof OneDriveError && err.kind === 'conflict') continue;
        if (fromDefault && err instanceof OneDriveError && err.kind === 'not_found') {
          throw new OneDriveError(
            'not_found',
            'A pasta padrão do OneDrive não existe mais. Escolha outra em Configurações.',
          );
        }
        throw err;
      }
    }
    if (!item) {
      throw new OneDriveError(
        'conflict',
        'Não foi possível encontrar um nome livre na pasta do OneDrive.',
      );
    }
    const final = item;
    const webUrl = final.webUrl
      ? final.webUrl
      : (await this.withToken((token) => this.graph.getItem(token, { id: final.id }))).webUrl;
    return { id: final.id, webUrl, name: final.name };
  }

  /** PDF rendition of a Word file already in OneDrive (Graph converts server-side). */
  downloadPdf(itemId: string): Promise<Uint8Array> {
    return this.withToken((token) => this.graph.downloadPdf(token, itemId));
  }

  private async resolveParent(
    input: UploadDocumentInput,
  ): Promise<{ parentId: string; fromDefault: boolean }> {
    if (input.folderId) return { parentId: input.folderId, fromDefault: false };
    if (input.path !== undefined && input.path.replace(/\//g, '') !== '') {
      const folder = await this.withToken((token) =>
        this.graph.getItem(token, { path: input.path ?? '' }),
      );
      if (!folder.isFolder)
        throw new OneDriveError('bad_request', 'O caminho informado não é uma pasta.');
      return { parentId: folder.id, fromDefault: false };
    }
    const def = this.store.load().defaultFolder;
    return def ? { parentId: def.id, fromDefault: true } : { parentId: 'root', fromDefault: false };
  }

  private async uploadWithSession(
    parentId: string,
    name: string,
    bytes: Uint8Array,
  ): Promise<DriveItem> {
    const { uploadUrl } = await this.withToken((token) =>
      this.graph.createUploadSession(token, parentId, name),
    );
    const total = bytes.byteLength;
    let offset = 0;
    // each round advances the offset; this only stops a server that never does
    let rounds = Math.ceil(total / this.chunkSize) * 3 + 5;
    try {
      while (rounds-- > 0) {
        const end = Math.min(offset + this.chunkSize, total);
        const result = await this.putChunkWithRetry(
          uploadUrl,
          bytes.subarray(offset, end),
          offset,
          total,
        );
        if (result.done) return result.item;
        offset = result.next < end ? Math.max(0, result.next) : end;
        if (offset >= total) break;
      }
      throw new OneDriveError('upstream', 'O OneDrive não confirmou o fim do envio do arquivo.');
    } catch (err) {
      // free the temporary data (a name clash on the last fragment keeps the session alive)
      await this.graph.cancelUploadSession(uploadUrl);
      throw err;
    }
  }

  private async putChunkWithRetry(
    uploadUrl: string,
    chunk: Uint8Array,
    start: number,
    total: number,
  ) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.graph.putChunk(uploadUrl, chunk, start, total);
      } catch (err) {
        const retryable =
          err instanceof OneDriveError && (err.kind === 'rate_limited' || err.kind === 'upstream');
        if (!retryable || attempt >= CHUNK_ATTEMPTS) throw err;
        const waitMs =
          err.retryAfterSec !== undefined ? err.retryAfterSec * 1000 : 1000 * 2 ** (attempt - 1);
        await this.sleep(Math.min(waitMs, MAX_RETRY_WAIT_MS));
      }
    }
  }

  /* --------------------------------- tokens ----------------------------------- */

  /** Runs `fn` with a valid access token; on a 401 refreshes once and retries. */
  private async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken(false);
    try {
      return await fn(token);
    } catch (err) {
      if (!(err instanceof OneDriveError) || err.kind !== 'unauthorized') throw err;
    }
    const fresh = await this.accessToken(true);
    try {
      return await fn(fresh);
    } catch (err) {
      if (err instanceof OneDriveError && err.kind === 'unauthorized') {
        this.markReconnect();
        throw reconnectRequired();
      }
      throw err;
    }
  }

  private async accessToken(forceRefresh: boolean): Promise<string> {
    const r = this.store.load();
    if (r.state === 'reconnect_required') throw reconnectRequired();
    if (r.state !== 'connected' || !r.tokens) throw notConnected();
    if (
      !forceRefresh &&
      r.tokens.expiresAt - this.clock.now() > EXPIRY_SKEW_MS &&
      r.tokens.accessToken
    ) {
      return r.tokens.accessToken;
    }
    // concurrent callers share one refresh (the refresh token rotates)
    this.refreshing ??= this.refreshTokens().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshTokens(): Promise<string> {
    const r = this.store.load();
    if (!r.tokens) throw notConnected();
    let set: TokenSet;
    try {
      set = await this.oauth.refresh({
        clientId: r.clientId,
        clientSecret: r.clientSecret,
        refreshToken: r.tokens.refreshToken,
      });
    } catch (err) {
      if (err instanceof OneDriveError && err.kind === 'reconnect_required') this.markReconnect();
      throw err;
    }
    // Microsoft usually rotates the refresh token: always keep the newest one
    const stored = this.toStored(set, set.refreshToken ?? r.tokens.refreshToken);
    this.store.save({ ...this.store.load(), tokens: stored });
    return stored.accessToken;
  }

  private markReconnect(): void {
    const r = this.store.load();
    if (r.state === 'connected')
      this.store.save({ ...r, state: 'reconnect_required', tokens: null });
  }

  private toStored(set: TokenSet, refreshToken: string) {
    return {
      accessToken: set.accessToken,
      refreshToken,
      expiresAt: this.clock.now() + set.expiresInSec * 1000,
    };
  }
}

function toFolders(items: DriveItem[]): OneDriveFolderListingDto['folders'] {
  return items
    .filter((c) => c.isFolder)
    .map((c) => ({ id: c.id, name: c.name, childCount: c.childCount }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

function joinPath(parentPath: string | null, name: string): string {
  const base = !parentPath || parentPath === '/' ? '' : parentPath;
  return `${base}/${name}`;
}
