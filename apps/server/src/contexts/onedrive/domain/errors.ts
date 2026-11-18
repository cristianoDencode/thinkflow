import { DomainError } from '../../../shared/kernel/errors';

export type OneDriveErrorKind =
  | 'not_configured'
  | 'not_connected'
  | 'reconnect_required'
  | 'invalid_state'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'quota'
  | 'bad_request'
  | 'upstream';

const HTTP: Record<OneDriveErrorKind, number> = {
  not_configured: 400,
  not_connected: 409,
  // never 401: the web app treats a 401 from the API as "session expired" and logs the user out
  reconnect_required: 409,
  invalid_state: 400,
  unauthorized: 409,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  quota: 507,
  bad_request: 400,
  upstream: 502,
};

/** Expected OneDrive/Microsoft failure. Messages are pt-BR and never contain tokens or secrets. */
export class OneDriveError extends DomainError {
  constructor(
    public readonly kind: OneDriveErrorKind,
    message: string,
    public readonly options: { retryAfterSec?: number } = {},
  ) {
    super(message, `onedrive_${kind}`, HTTP[kind]);
    this.name = 'OneDriveError';
  }

  get retryAfterSec(): number | undefined {
    return this.options.retryAfterSec;
  }
}

export const notConfigured = () =>
  new OneDriveError(
    'not_configured',
    'Informe o ID do aplicativo (client ID) do OneDrive nas configurações.',
  );
export const notConnected = () =>
  new OneDriveError('not_connected', 'O OneDrive não está conectado. Conecte em Configurações.');
export const reconnectRequired = () =>
  new OneDriveError(
    'reconnect_required',
    'A autorização do OneDrive expirou ou foi revogada. Reconecte em Configurações.',
  );
