import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OneDriveError } from '../../src/contexts/onedrive/domain/errors';
import { jsonResponse, TOKEN_URL } from './fake-microsoft';
import { CLIENT_ID, connect, GRAPH_ME, REDIRECT, setup, storedRows } from './harness';

describe('OneDrive authorization (code + PKCE)', () => {
  it('builds a consumers authorize URL with S256 PKCE, state and least-privilege scopes', () => {
    const ctx = setup();
    ctx.service.updateSettings({ clientId: CLIENT_ID });
    const url = new URL(ctx.service.startAuthorization(REDIRECT).authorizeUrl);

    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
    );
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe(REDIRECT);
    expect(q.get('scope')).toBe('Files.ReadWrite offline_access User.Read');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')?.length).toBeGreaterThanOrEqual(40);
  });

  it('requires the client ID before starting', () => {
    const ctx = setup();
    expect(() => ctx.service.startAuthorization(REDIRECT)).toThrowError(/client ID/);
  });

  it('sends the verifier whose SHA-256 is the challenge, with no secret for a public client', async () => {
    const ctx = setup();
    ctx.service.updateSettings({ clientId: CLIENT_ID });
    const url = new URL(ctx.service.startAuthorization(REDIRECT).authorizeUrl);
    const state = url.searchParams.get('state') ?? '';
    await ctx.service.completeAuthorization({ code: 'CODE-1', state });

    const [exchange] = ctx.fake.callsTo('POST', TOKEN_URL);
    expect(exchange?.form.get('grant_type')).toBe('authorization_code');
    expect(exchange?.form.get('code')).toBe('CODE-1');
    expect(exchange?.form.get('redirect_uri')).toBe(REDIRECT);
    expect(exchange?.form.has('client_secret')).toBe(false);
    const verifier = exchange?.form.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
  });

  it('sends the client secret when one is configured', async () => {
    const ctx = setup();
    await connect(ctx, 'super-secret');
    expect(ctx.fake.callsTo('POST', TOKEN_URL)[0]?.form.get('client_secret')).toBe('super-secret');
  });

  it('rejects an unknown, reused or expired state', async () => {
    const ctx = setup();
    ctx.service.updateSettings({ clientId: CLIENT_ID });
    await expect(
      ctx.service.completeAuthorization({ code: 'c', state: 'forged' }),
    ).rejects.toMatchObject({ kind: 'invalid_state' });
    await expect(ctx.service.completeAuthorization({ code: 'c' })).rejects.toMatchObject({
      kind: 'invalid_state',
    });

    const state =
      new URL(ctx.service.startAuthorization(REDIRECT).authorizeUrl).searchParams.get('state') ??
      '';
    await ctx.service.completeAuthorization({ code: 'c', state });
    // a state is single-use
    await expect(ctx.service.completeAuthorization({ code: 'c', state })).rejects.toMatchObject({
      kind: 'invalid_state',
    });

    const stale =
      new URL(ctx.service.startAuthorization(REDIRECT).authorizeUrl).searchParams.get('state') ??
      '';
    ctx.clock.advance(11 * 60_000);
    await expect(
      ctx.service.completeAuthorization({ code: 'c', state: stale }),
    ).rejects.toMatchObject({
      kind: 'invalid_state',
    });
    // nothing was exchanged for the rejected states
    expect(ctx.fake.callsTo('POST', TOKEN_URL)).toHaveLength(1);
  });

  it('consumes the state when the user denies access', async () => {
    const ctx = setup();
    ctx.service.updateSettings({ clientId: CLIENT_ID });
    const state =
      new URL(ctx.service.startAuthorization(REDIRECT).authorizeUrl).searchParams.get('state') ??
      '';
    await expect(
      ctx.service.completeAuthorization({ error: 'access_denied', state }),
    ).rejects.toThrowError(/cancelada/);
    await expect(ctx.service.completeAuthorization({ code: 'c', state })).rejects.toMatchObject({
      kind: 'invalid_state',
    });
  });

  it('stores the account, encrypts the tokens and never exposes them in the status', async () => {
    const ctx = setup();
    await connect(ctx, 'super-secret');

    const status = ctx.service.status(REDIRECT);
    expect(status).toMatchObject({
      state: 'connected',
      account: { name: 'Ana Analista', email: 'ana@outlook.com' },
      hasClientSecret: true,
    });
    expect(JSON.stringify(status)).not.toMatch(/AT-1|RT-1|super-secret/);

    const raw = storedRows(ctx).account;
    expect(raw).not.toMatch(/AT-1|RT-1|super-secret/);
    expect(raw).toContain('v1:'); // AES-GCM payloads
    const requests = storedRows(ctx).authRequests;
    expect(requests).toBe('[]');
  });

  it('maps token endpoint failures to actionable pt-BR messages', async () => {
    const ctx = setup();
    ctx.service.updateSettings({ clientId: CLIENT_ID });
    ctx.fake.on('POST', TOKEN_URL, () =>
      jsonResponse(401, {
        error: 'invalid_client',
        error_description:
          'AADSTS7000218: The request body must contain client_assertion or client_secret.',
        error_codes: [7000218],
      }),
    );
    const state =
      new URL(ctx.service.startAuthorization(REDIRECT).authorizeUrl).searchParams.get('state') ??
      '';
    const err = await ctx.service
      .completeAuthorization({ code: 'c', state })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneDriveError);
    expect((err as OneDriveError).message).toMatch(/fluxos de cliente público/);
    expect((err as OneDriveError).message).not.toMatch(/AADSTS/);
  });

  it('changing the app registration disconnects; disconnect forgets the account', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.service.updateSettings({ namingPattern: 'CT {ticketId}.docx' });
    expect(ctx.service.status(REDIRECT).state).toBe('connected');

    ctx.service.updateSettings({ clientId: '99999999-2222-3333-4444-555555555555' });
    expect(ctx.service.status(REDIRECT)).toMatchObject({ state: 'disconnected' });

    ctx.service.disconnect();
    expect(ctx.service.status(REDIRECT).account).toBeNull();
    expect(ctx.fake.callsTo('GET', GRAPH_ME)).toHaveLength(1);
  });
});
