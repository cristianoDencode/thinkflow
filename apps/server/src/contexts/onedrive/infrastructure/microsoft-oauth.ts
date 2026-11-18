import { ONEDRIVE_SCOPES } from '../domain/constants';
import { OneDriveError } from '../domain/errors';
import type { FetchFn, MicrosoftOAuth, OAuthClientCredentials, TokenSet } from '../domain/ports';

/**
 * `consumers` = personal Microsoft accounts only (the app registration must allow them; `common` also
 * works when it allows both). https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow
 */
export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/consumers';

interface TokenErrorBody {
  error?: unknown;
  error_description?: unknown;
  error_codes?: unknown;
}

/** AADSTS codes (from `error_codes`) with a pt-BR explanation the analyst can act on. */
const FRIENDLY_CODES: Record<number, string> = {
  700016:
    'O Microsoft não encontrou esse ID do aplicativo (client ID). Confira o valor copiado do portal.',
  7000218:
    'O registro do aplicativo é de cliente confidencial: informe o segredo (client secret) ou ative "Permitir fluxos de cliente público" em Autenticação.',
  7000215:
    'Segredo do cliente inválido. Copie o "Valor" do segredo (não o "ID do segredo") ao criá-lo.',
  7000222: 'O segredo do cliente expirou. Crie um novo segredo no portal e salve aqui.',
  700025:
    'Este aplicativo é cliente público: deixe o segredo (client secret) em branco ou registre a URI na plataforma "Web".',
  50011:
    'A URI de redirecionamento não está registrada no aplicativo. Copie exatamente a URI mostrada aqui para o portal.',
  9002327:
    'A URI foi registrada como "Aplicativo de página única (SPA)". Registre-a em "Aplicativos móveis e de desktop" (sem segredo) ou "Web" (com segredo).',
  700021:
    'O aplicativo não permite fluxo de cliente público. Ative "Permitir fluxos de cliente público" em Autenticação.',
};

function errorCodes(body: TokenErrorBody): number[] {
  return Array.isArray(body.error_codes)
    ? body.error_codes.filter((c): c is number => typeof c === 'number')
    : [];
}

/** Maps a token-endpoint failure. Never echoes the request (codes, secrets) or the raw description. */
export function mapTokenError(
  status: number,
  body: TokenErrorBody,
  phase: 'code' | 'refresh',
): OneDriveError {
  const code = typeof body.error === 'string' ? body.error : '';
  const friendly = errorCodes(body)
    .map((c) => FRIENDLY_CODES[c])
    .find((m) => m !== undefined);
  if (status >= 500 || code === 'temporarily_unavailable' || code === 'server_error') {
    return new OneDriveError(
      'upstream',
      'O login da Microsoft está indisponível. Tente de novo em instantes.',
    );
  }
  if (phase === 'refresh') {
    // revoked consent, password changed, token expired: only a new interactive sign-in recovers
    if (
      ['invalid_grant', 'interaction_required', 'consent_required', 'login_required'].includes(code)
    ) {
      return new OneDriveError(
        'reconnect_required',
        'A autorização do OneDrive expirou ou foi revogada. Reconecte em Configurações.',
      );
    }
  } else if (code === 'invalid_grant') {
    return new OneDriveError(
      'invalid_state',
      'O código de autorização expirou ou já foi usado. Clique em Conectar de novo.',
    );
  }
  if (friendly) return new OneDriveError('bad_request', friendly);
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return new OneDriveError(
      'bad_request',
      'A Microsoft recusou o aplicativo. Confira o ID, o segredo e os tipos de conta do registro.',
    );
  }
  return new OneDriveError(
    'bad_request',
    `A Microsoft recusou o login (${code || `HTTP ${status}`}).`,
  );
}

export class HttpMicrosoftOAuth implements MicrosoftOAuth {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly authority: string = MICROSOFT_AUTHORITY,
  ) {}

  authorizeUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    loginHint?: string;
  }): string {
    const params = new URLSearchParams({
      client_id: input.clientId,
      response_type: 'code',
      redirect_uri: input.redirectUri,
      response_mode: 'query',
      scope: ONEDRIVE_SCOPES.join(' '),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    if (input.loginHint) params.set('login_hint', input.loginHint);
    return `${this.authority}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  exchangeCode(
    input: OAuthClientCredentials & { redirectUri: string; code: string; codeVerifier: string },
  ): Promise<TokenSet> {
    const form = new URLSearchParams({
      client_id: input.clientId,
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      scope: ONEDRIVE_SCOPES.join(' '),
    });
    if (input.clientSecret) form.set('client_secret', input.clientSecret);
    return this.token(form, 'code');
  }

  refresh(input: OAuthClientCredentials & { refreshToken: string }): Promise<TokenSet> {
    const form = new URLSearchParams({
      client_id: input.clientId,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      scope: ONEDRIVE_SCOPES.join(' '),
    });
    if (input.clientSecret) form.set('client_secret', input.clientSecret);
    return this.token(form, 'refresh');
  }

  private async token(form: URLSearchParams, phase: 'code' | 'refresh'): Promise<TokenSet> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.authority}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form.toString(),
      });
    } catch {
      throw new OneDriveError('upstream', 'Não foi possível falar com o login da Microsoft.');
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw mapTokenError(response.status, body as TokenErrorBody, phase);
    const accessToken = body.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new OneDriveError('upstream', 'Resposta de login da Microsoft sem token de acesso.');
    }
    const expires = Number(body.expires_in);
    return {
      accessToken,
      refreshToken:
        typeof body.refresh_token === 'string' && body.refresh_token !== ''
          ? body.refresh_token
          : null,
      expiresInSec: Number.isFinite(expires) && expires > 0 ? expires : 3600,
      scope: typeof body.scope === 'string' ? body.scope : '',
    };
  }
}
