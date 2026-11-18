import { afterEach, describe, expect, it } from 'vitest';
import type { OneDriveStatusDto } from '@thinkflow/shared';
import { createTestApp, type TestApp } from '../integration/test-app';
import { FakeMicrosoft, folderItem, ME, TOKEN_URL, tokenResponse } from './fake-microsoft';
import { CLIENT_ID, GRAPH_ME } from './harness';

const BASE = '/api/integrations/onedrive';

describe('OneDrive routes', () => {
  let ctx: TestApp | undefined;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  async function boot() {
    const fake = new FakeMicrosoft();
    fake.on('GET', GRAPH_ME, ME);
    fake.on('POST', TOKEN_URL, () => tokenResponse());
    ctx = await createTestApp({ fetchFn: fake.fetch });
    return { ctx, fake };
  }

  it('requires a session on every route except the Microsoft callback', async () => {
    const { ctx: app } = await boot();
    for (const [method, url] of [
      ['GET', BASE],
      ['PUT', BASE],
      ['POST', `${BASE}/connect`],
      ['POST', `${BASE}/disconnect`],
      ['GET', `${BASE}/folders`],
      ['PUT', `${BASE}/default-folder`],
      ['POST', `${BASE}/file-name`],
    ] as const) {
      const res = await app.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    // the callback is not behind the session cookie; without a valid state it only redirects back
    const cb = await app.app.inject({ method: 'GET', url: `${BASE}/callback?code=x&state=forged` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toMatch(/^\/settings\?onedrive=error&reason=/);
  });

  it('derives the redirect URI from the address the browser used', async () => {
    const { ctx: app } = await boot();
    const local = await app.app.inject({
      method: 'GET',
      url: BASE,
      headers: { cookie: app.cookie, host: 'localhost:5173' },
    });
    expect((local.json() as OneDriveStatusDto).redirectUri).toBe(
      'http://localhost:5173/api/integrations/onedrive/callback',
    );
    const proxied = await app.app.inject({
      method: 'GET',
      url: BASE,
      headers: {
        cookie: app.cookie,
        host: 'internal:3737',
        'x-forwarded-host': 'analista.exemplo.com',
        'x-forwarded-proto': 'https',
      },
    });
    const body = proxied.json() as OneDriveStatusDto;
    expect(body.redirectUri).toBe(
      'https://analista.exemplo.com/api/integrations/onedrive/callback',
    );
    expect(body.redirectUriWarning).toBeNull();

    const loopback = await app.app.inject({
      method: 'GET',
      url: BASE,
      headers: { cookie: app.cookie, host: '127.0.0.1:3737' },
    });
    expect((loopback.json() as OneDriveStatusDto).redirectUriWarning).toMatch(/127\.0\.0\.1/);
  });

  it('saves settings, validates the client ID and never returns the secret', async () => {
    const { ctx: app } = await boot();
    const bad = await app.api('PUT', BASE, { clientId: 'nao-e-guid' });
    expect(bad.status).toBe(400);

    const ok = await app.api<OneDriveStatusDto>('PUT', BASE, {
      clientId: CLIENT_ID,
      clientSecret: 'shh-secret',
      namingPattern: 'CT {ticketId} - {title}.docx',
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      clientId: CLIENT_ID,
      hasClientSecret: true,
      state: 'disconnected',
    });
    expect(JSON.stringify(ok.json)).not.toContain('shh-secret');

    const cleared = await app.api<OneDriveStatusDto>('PUT', BASE, { clearClientSecret: true });
    expect(cleared.json.hasClientSecret).toBe(false);
  });

  it('refuses to connect without a client ID', async () => {
    const { ctx: app } = await boot();
    const res = await app.api<{ error: { code: string } }>('POST', `${BASE}/connect`);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('onedrive_not_configured');
  });

  it('runs the whole flow: connect -> callback -> folders -> default folder -> file name -> disconnect', async () => {
    const { ctx: app, fake } = await boot();
    await app.api('PUT', BASE, { clientId: CLIENT_ID });

    const start = await app.api<{ authorizeUrl: string }>('POST', `${BASE}/connect`);
    expect(start.status).toBe(200);
    const url = new URL(start.json.authorizeUrl);
    expect(url.hostname).toBe('login.microsoftonline.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state') ?? '';

    const cb = await app.app.inject({
      method: 'GET',
      url: `${BASE}/callback?code=CODE&state=${state}`,
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/settings?onedrive=connected');

    const status = await app.api<OneDriveStatusDto>('GET', BASE);
    expect(status.json).toMatchObject({
      state: 'connected',
      account: { name: 'Ana Analista', email: 'ana@outlook.com' },
    });

    fake.on('GET', /\/me\/drive\/root\/children/, { value: [folderItem('F1', 'Testes', 2)] });
    const folders = await app.api<{ parent: { id: string }; folders: { id: string }[] }>(
      'GET',
      `${BASE}/folders`,
    );
    expect(folders.json.parent.id).toBe('root');
    expect(folders.json.folders.map((f) => f.id)).toEqual(['F1']);

    fake.on('GET', /\/me\/drive\/items\/F1\?/, folderItem('F1', 'Testes'));
    const def = await app.api<OneDriveStatusDto>('PUT', `${BASE}/default-folder`, { id: 'F1' });
    expect(def.json.defaultFolder).toEqual({ id: 'F1', name: 'Testes', path: '/Testes' });

    const name = await app.api<{ fileName: string }>('POST', `${BASE}/file-name`, {
      ticketId: '893.687',
      title: 'Login: erro',
    });
    expect(name.json.fileName).toBe('CT 893.687 - Login- erro.docx');

    const bye = await app.api<OneDriveStatusDto>('POST', `${BASE}/disconnect`);
    expect(bye.json).toMatchObject({ state: 'disconnected', account: null });

    // the same state cannot be replayed
    const replay = await app.app.inject({
      method: 'GET',
      url: `${BASE}/callback?code=CODE&state=${state}`,
    });
    expect(replay.headers.location).toMatch(/onedrive=error/);
  });

  it('turns an access_denied redirect into a friendly settings message', async () => {
    const { ctx: app } = await boot();
    await app.api('PUT', BASE, { clientId: CLIENT_ID });
    const start = await app.api<{ authorizeUrl: string }>('POST', `${BASE}/connect`);
    const state = new URL(start.json.authorizeUrl).searchParams.get('state') ?? '';
    const cb = await app.app.inject({
      method: 'GET',
      url: `${BASE}/callback?error=access_denied&state=${state}`,
    });
    const location = new URL(cb.headers.location as string, 'http://x');
    expect(location.searchParams.get('onedrive')).toBe('error');
    expect(location.searchParams.get('reason')).toMatch(/cancelada/);
  });

  it('exposes uploadNewDocument on the container', async () => {
    const { ctx: app } = await boot();
    expect(typeof app.container.onedrive.uploadNewDocument).toBe('function');
  });
});
