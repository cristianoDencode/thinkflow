import { describe, expect, it } from 'vitest';
import { folderItem, jsonResponse, TOKEN_URL, tokenResponse } from './fake-microsoft';
import { connect, REDIRECT, setup, storedRows } from './harness';

const CHILDREN = /graph\.microsoft\.com\/v1\.0\/me\/drive\/root\/children/;

describe('OneDrive tokens', () => {
  it('uses the stored access token while it is valid', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('GET', CHILDREN, { value: [] });
    ctx.fake.on('GET', /\/me\/drive\/root\?/, folderItem('root', 'root'));

    await ctx.service.listFolder(null);
    expect(ctx.fake.callsTo('POST', TOKEN_URL)).toHaveLength(1); // only the code exchange
    expect(ctx.fake.callsTo('GET', CHILDREN)[0]?.headers.authorization).toBe('Bearer AT-1');
  });

  it('refreshes an expired token, rotates the refresh token and stores it encrypted', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('POST', TOKEN_URL, () => tokenResponse({ access: 'AT-2', refresh: 'RT-2' }));
    ctx.fake.on('GET', CHILDREN, { value: [] });
    ctx.fake.on('GET', /\/me\/drive\/root\?/, folderItem('root', 'root'));

    ctx.clock.advance(3_600_000); // the 1 h token is gone
    await ctx.service.listFolder(null);

    const refresh = ctx.fake.callsTo('POST', TOKEN_URL).at(-1);
    expect(refresh?.form.get('grant_type')).toBe('refresh_token');
    expect(refresh?.form.get('refresh_token')).toBe('RT-1');
    expect(ctx.fake.callsTo('GET', CHILDREN)[0]?.headers.authorization).toBe('Bearer AT-2');

    // the next refresh uses the rotated token
    ctx.clock.advance(3_600_000);
    await ctx.service.listFolder(null);
    expect(ctx.fake.callsTo('POST', TOKEN_URL).at(-1)?.form.get('refresh_token')).toBe('RT-2');

    const raw = storedRows(ctx).account;
    expect(raw).not.toMatch(/AT-2|RT-2/);
  });

  it('keeps the stored refresh token when Microsoft does not rotate it', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('POST', TOKEN_URL, () => tokenResponse({ access: 'AT-2', refresh: null }));
    ctx.fake.on('GET', CHILDREN, { value: [] });
    ctx.fake.on('GET', /\/me\/drive\/root\?/, folderItem('root', 'root'));

    ctx.clock.advance(3_600_000);
    await ctx.service.listFolder(null);
    ctx.clock.advance(3_600_000);
    await ctx.service.listFolder(null);
    expect(ctx.fake.callsTo('POST', TOKEN_URL).at(-1)?.form.get('refresh_token')).toBe('RT-1');
  });

  it('shares one refresh between concurrent calls', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('GET', CHILDREN, { value: [] });
    ctx.fake.on('GET', /\/me\/drive\/root\?/, folderItem('root', 'root'));
    ctx.clock.advance(3_600_000);
    const before = ctx.fake.callsTo('POST', TOKEN_URL).length;

    await Promise.all([ctx.service.listFolder(null), ctx.service.listFolder(null)]);
    expect(ctx.fake.callsTo('POST', TOKEN_URL).length - before).toBe(1);
  });

  it('asks to reconnect when the refresh is rejected (revoked consent) and stays that way', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('POST', TOKEN_URL, () =>
      jsonResponse(400, {
        error: 'invalid_grant',
        error_description: 'AADSTS70008: expired',
        error_codes: [70008],
      }),
    );
    ctx.clock.advance(3_600_000);

    await expect(ctx.service.listFolder(null)).rejects.toMatchObject({
      kind: 'reconnect_required',
      code: 'onedrive_reconnect_required',
      httpStatus: 409, // never 401: the web app would log the user out
    });
    expect(ctx.service.status(REDIRECT).state).toBe('reconnect_required');
    const hits = ctx.fake.callsTo('POST', TOKEN_URL).length;
    await expect(ctx.service.listFolder(null)).rejects.toMatchObject({
      kind: 'reconnect_required',
    });
    expect(ctx.fake.callsTo('POST', TOKEN_URL)).toHaveLength(hits); // no more calls while it is revoked

    // reconnecting recovers and hints the account
    const url = new URL(ctx.service.startAuthorization(REDIRECT).authorizeUrl);
    expect(url.searchParams.get('login_hint')).toBe('ana@outlook.com');
    ctx.fake.on('POST', TOKEN_URL, () => tokenResponse({ access: 'AT-9', refresh: 'RT-9' }));
    await ctx.service.completeAuthorization({
      code: 'c',
      state: url.searchParams.get('state') ?? '',
    });
    expect(ctx.service.status(REDIRECT).state).toBe('connected');
  });

  it('does not lose the connection on a temporary Microsoft outage', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('POST', TOKEN_URL, () => jsonResponse(503, { error: 'temporarily_unavailable' }));
    ctx.clock.advance(3_600_000);
    await expect(ctx.service.listFolder(null)).rejects.toMatchObject({ kind: 'upstream' });
    expect(ctx.service.status(REDIRECT).state).toBe('connected');
  });

  it('refreshes once and retries when Graph answers 401', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('POST', TOKEN_URL, () => tokenResponse({ access: 'AT-2', refresh: 'RT-2' }));
    ctx.fake.on('GET', CHILDREN, (call) =>
      call.headers.authorization === 'Bearer AT-2'
        ? jsonResponse(200, { value: [folderItem('F1', 'Testes')] })
        : jsonResponse(401, { error: { code: 'InvalidAuthenticationToken' } }),
    );
    ctx.fake.on('GET', /\/me\/drive\/root\?/, folderItem('root', 'root'));

    const listing = await ctx.service.listFolder(null);
    expect(listing.folders.map((f) => f.name)).toEqual(['Testes']);
  });

  it('asks to reconnect when Graph keeps answering 401 after a refresh', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('GET', CHILDREN, () =>
      jsonResponse(401, { error: { code: 'InvalidAuthenticationToken' } }),
    );
    ctx.fake.on('GET', /\/me\/drive\/root\?/, folderItem('root', 'root'));

    await expect(ctx.service.listFolder(null)).rejects.toMatchObject({
      kind: 'reconnect_required',
    });
    expect(ctx.service.status(REDIRECT).state).toBe('reconnect_required');
  });

  it('requires a connection first', async () => {
    const ctx = setup();
    await expect(ctx.service.listFolder(null)).rejects.toMatchObject({ kind: 'not_connected' });
  });
});
