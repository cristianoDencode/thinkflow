import fs from 'node:fs';
import path from 'node:path';
import type { NotebookLmLoginStatusDto, NotebookLmSettingsDto } from '@thinkflow/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fakeCliCommand,
  fakeStorageState,
  readFakeCliLog,
  starts,
} from '../library/notebooklm-helpers';
import { createTestApp, type TestApp } from './test-app';

const BASE = '/api/library/notebooklm';
const HOUR = 3_600_000;

describe('NotebookLM settings (fake CLI, no Google)', () => {
  let t: TestApp;
  let logFile: string;

  async function setup(knobs: Record<string, string> = {}, overrides = {}) {
    t = await createTestApp(overrides);
    logFile = path.join(t.notebookLmDir, 'fake-cli.log');
    await useCli(knobs);
  }
  const useCli = async (knobs: Record<string, string> = {}) => {
    const res = await t.api('PUT', BASE, {
      cliCommand: fakeCliCommand({ log: logFile, ...knobs }),
    });
    expect(res.status).toBe(200);
  };
  const dto = async () => (await t.api<NotebookLmSettingsDto>('GET', BASE)).json;
  const loginState = async () =>
    (await t.api<NotebookLmLoginStatusDto>('GET', `${BASE}/login`)).json;
  const waitLogin = (state: string) =>
    vi.waitFor(async () => expect((await loginState()).state).toBe(state), { timeout: 8000 });

  afterEach(async () => t?.close());

  it('requires a session on every route', async () => {
    t = await createTestApp();
    const routes: [string, string][] = [
      ['GET', BASE],
      ['PUT', BASE],
      ['POST', `${BASE}/test`],
      ['DELETE', `${BASE}/credentials`],
      ['POST', `${BASE}/login`],
      ['GET', `${BASE}/login`],
      ['DELETE', `${BASE}/login`],
      ['POST', `${BASE}/import-local`],
      ['POST', `${BASE}/refresh`],
    ];
    for (const [method, url] of routes) {
      const res = await t.app.inject({ method: method as 'GET', url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('starts unconfigured', async () => {
    t = await createTestApp();
    expect(await dto()).toEqual({
      enabled: false,
      hasCredentials: false,
      credentialsUpdatedAt: null,
      cliCommand: 'notebooklm',
      plan: 'auto',
      detection: {
        at: null,
        sourceLimit: null,
        notebookLimit: null,
        tier: null,
        planLabel: null,
        unavailableReason: null,
      },
      sourceLimit: 50,
      notebookLimit: 100,
      dailyQueryLimit: 50,
      dailyQueryLimitCustom: false,
      queriesToday: 0,
      timeoutSec: 120,
      fallbackToLocal: true,
      lastCheck: null,
      loginSupported: true,
      localProfileAvailable: false,
    });
  });

  describe('pasted credentials', () => {
    it('rejects content that is not a storage_state.json', async () => {
      await setup();
      for (const authJson of ['not json', '{"cookies":[]}', '[]']) {
        const res = await t.api<{ error: { message: string } }>('PUT', BASE, { authJson });
        expect(res.status).toBe(400);
        expect(res.json.error.message).toContain('storage_state.json');
      }
      expect((await dto()).hasCredentials).toBe(false);
    });

    it('stores them encrypted, never returns them, and records the first check', async () => {
      await setup();
      const secret = 'super-secret-cookie-value-123';
      const put = await t.api<NotebookLmSettingsDto>('PUT', BASE, {
        authJson: fakeStorageState(secret),
        enabled: true,
        dailyQueryLimit: 10,
      });
      expect(put.status).toBe(200);
      expect(put.json).toMatchObject({
        enabled: true,
        hasCredentials: true,
        dailyQueryLimit: 10,
        lastCheck: { ok: true, account: 'fake.user@example.com' },
      });
      expect(put.json.credentialsUpdatedAt).toBeGreaterThan(0);

      const get = await t.app.inject({ method: 'GET', url: BASE, headers: { cookie: t.cookie } });
      expect(get.body).not.toContain(secret);
      expect(JSON.stringify(put.json)).not.toContain(secret);

      // ciphertext at rest
      const raw = JSON.stringify(t.container.settings.get('notebooklm', {}));
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain('cookies');
      expect(
        t.container.settings.get<{ authEnc: string }>('notebooklm', { authEnc: '' }).authEnc,
      ).toMatch(/^v1:/);
      // ...but the server can use it
      expect(t.container.notebookLm.config.get().authJson).toContain(secret);
    });

    it('keeps the credentials when other fields are saved', async () => {
      await setup();
      await t.api('PUT', BASE, { authJson: fakeStorageState('abc') });
      const res = await t.api<NotebookLmSettingsDto>('PUT', BASE, { timeoutSec: 60 });
      expect(res.json).toMatchObject({ hasCredentials: true, timeoutSec: 60 });
      expect(t.container.notebookLm.config.get().authJson).toContain('abc');
    });

    it('does not enable without credentials', async () => {
      await setup();
      const res = await t.api<{ error: { code: string } }>('PUT', BASE, { enabled: true });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('notebooklm_not_configured');
    });

    it('tests the connection and updates lastCheck', async () => {
      await setup();
      await t.api('PUT', BASE, { authJson: fakeStorageState('abc') });
      const ok = await t.api<{ ok: boolean; message: string }>('POST', `${BASE}/test`);
      expect(ok.json).toMatchObject({ ok: true });
      expect(ok.json.message).toContain('fake.user@example.com');

      await t.api('PUT', BASE, { authJson: fakeStorageState('expired-1') });
      const bad = await t.api<{ ok: boolean; message: string }>('POST', `${BASE}/test`);
      expect(bad.json.ok).toBe(false);
      expect(bad.json.message).toContain('expiradas');
      expect((await dto()).lastCheck).toMatchObject({ ok: false, message: bad.json.message });
    });

    it('reports a missing CLI in the test result', async () => {
      await setup();
      await t.api('PUT', BASE, {
        authJson: fakeStorageState('abc'),
        cliCommand: '/nonexistent/nlm',
      });
      const res = await t.api<{ ok: boolean; message: string }>('POST', `${BASE}/test`);
      expect(res.json.ok).toBe(false);
      expect(res.json.message).toContain('CLI do NotebookLM não encontrada');
    });

    it('removes the credentials', async () => {
      await setup();
      await t.api('PUT', BASE, { authJson: fakeStorageState('abc'), enabled: true });
      const res = await t.api<NotebookLmSettingsDto>('DELETE', `${BASE}/credentials`);
      expect(res.json).toMatchObject({
        hasCredentials: false,
        enabled: false,
        credentialsUpdatedAt: null,
        lastCheck: null,
      });
      expect(
        t.container.settings.get<{ authEnc: string }>('notebooklm', { authEnc: 'x' }).authEnc,
      ).toBe('');
      expect(t.container.notebookLm.config.get().authJson).toBeNull();
    });
  });

  describe('in-app Google login', () => {
    const loginDirs = () => fs.readdirSync(t.notebookLmDir).filter((n) => n.startsWith('login-'));

    it('waiting -> done: stores the session encrypted and deletes every plaintext file', async () => {
      await setup();
      const start = await t.api<NotebookLmLoginStatusDto>('POST', `${BASE}/login`);
      expect(start.status).toBe(202);
      expect(start.json.state).toBe('waiting');
      expect(start.json.message).toContain('janela de login');

      await waitLogin('done');
      const done = await loginState();
      expect(done.message).toContain('fake.user@example.com');

      const settings = await dto();
      expect(settings).toMatchObject({ hasCredentials: true, lastCheck: { ok: true } });
      expect(t.container.notebookLm.config.get().authJson).toContain('fake-login-cookie');
      expect(JSON.stringify(t.container.settings.get('notebooklm', {}))).not.toContain(
        'fake-login-cookie',
      );

      // plaintext storage file + Chromium profile were removed
      expect(loginDirs()).toEqual([]);
      // the CLI was spawned without the env-auth var and with the display variables
      const login = starts(readFakeCliLog(logFile)).find((e) => e.argv?.[0] === 'login')!;
      expect(login.hasAuthEnv).toBe(false);
      expect(login.envKeys).toContain('DISPLAY');
      expect(login.argv).toContain('--browser-timeout');
      const target = login.argv![login.argv!.indexOf('--storage') + 1]!;
      expect(target.startsWith(t.notebookLmDir)).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    });

    it('reports a failed login', async () => {
      await setup({ login: 'fail' });
      await t.api('POST', `${BASE}/login`);
      await waitLogin('error');
      expect((await loginState()).message).toContain('login não foi concluído');
      expect((await dto()).hasCredentials).toBe(false);
      expect(loginDirs()).toEqual([]);
    });

    it('rejects a login that produced no usable credentials', async () => {
      await setup({ login: 'invalid' });
      await t.api('POST', `${BASE}/login`);
      await waitLogin('error');
      expect((await loginState()).message).toContain('credenciais válidas');
      await t.api('DELETE', `${BASE}/login`);
      await useCli({ login: 'nofile' });
      await t.api('POST', `${BASE}/login`);
      await waitLogin('error');
      expect((await loginState()).message).toContain('sem salvar');
      expect(loginDirs()).toEqual([]);
    });

    it('cancels a running login and kills the process', async () => {
      await setup({ login: 'sleep' });
      await t.api('POST', `${BASE}/login`);
      expect((await loginState()).state).toBe('waiting');
      const second = await t.api('POST', `${BASE}/login`);
      expect(second.status).toBe(409);

      await vi.waitFor(() =>
        expect(starts(readFakeCliLog(logFile)).some((e) => e.argv?.[0] === 'login')).toBe(true),
      );
      const pid = starts(readFakeCliLog(logFile)).find((e) => e.argv?.[0] === 'login')!.pid;

      const cancel = await t.api<NotebookLmLoginStatusDto>('DELETE', `${BASE}/login`);
      expect(cancel.json.state).toBe('idle');
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
      await vi.waitFor(() => expect(loginDirs()).toEqual([]));
      expect((await dto()).hasCredentials).toBe(false);
      expect((await loginState()).state).toBe('idle');

      // a new login can start afterwards
      await useCli();
      expect((await t.api('POST', `${BASE}/login`)).status).toBe(202);
      await waitLogin('done');
    });

    it('is unsupported without a display (or in a container)', async () => {
      await setup({}, { notebookLm: { env: { PATH: process.env.PATH ?? '' } } });
      expect((await dto()).loginSupported).toBe(false);
      const state = await loginState();
      expect(state.state).toBe('unsupported');
      expect(state.message).toContain('Importar login existente');
      const res = await t.api<{ error: { code: string } }>('POST', `${BASE}/login`);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('notebooklm_login_unsupported');
      await t.close();

      await setup({}, { notebookLm: { isContainer: () => true } });
      expect((await dto()).loginSupported).toBe(false);
    });

    it('reports a missing CLI', async () => {
      await setup();
      await t.api('PUT', BASE, { cliCommand: '/nonexistent/notebooklm' });
      await t.api('POST', `${BASE}/login`);
      await waitLogin('error');
      expect((await loginState()).message).toContain('CLI do NotebookLM não encontrada');
    });
  });

  describe('import of the existing CLI login', () => {
    const profile = (t: TestApp) => path.join(t.homeDir, '.notebooklm', 'profiles', 'default');

    it('is only offered when the profile exists, and 404s otherwise', async () => {
      await setup();
      expect((await dto()).localProfileAvailable).toBe(false);
      const res = await t.api<{ error: { code: string } }>('POST', `${BASE}/import-local`);
      expect(res.status).toBe(404);
      expect(res.json.error.code).toBe('notebooklm_no_local_profile');
    });

    it('imports it (encrypted) and leaves the CLI file untouched', async () => {
      await setup();
      fs.mkdirSync(profile(t), { recursive: true });
      const file = path.join(profile(t), 'storage_state.json');
      const content = fakeStorageState('cli-profile-cookie');
      fs.writeFileSync(file, content, { mode: 0o600 });

      expect((await dto()).localProfileAvailable).toBe(true);
      const res = await t.api<NotebookLmSettingsDto>('POST', `${BASE}/import-local`);
      expect(res.status).toBe(200);
      // a working login switches the integration on by itself
      expect(res.json).toMatchObject({
        hasCredentials: true,
        enabled: true,
        lastCheck: { ok: true },
      });
      expect(JSON.stringify(res.json)).not.toContain('cli-profile-cookie');
      expect(t.container.notebookLm.config.get().authJson).toContain('cli-profile-cookie');
      expect(JSON.stringify(t.container.settings.get('notebooklm', {}))).not.toContain(
        'cli-profile-cookie',
      );
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    });

    it('rejects an invalid profile file', async () => {
      await setup();
      fs.mkdirSync(profile(t), { recursive: true });
      fs.writeFileSync(path.join(profile(t), 'storage_state.json'), 'garbage');
      const res = await t.api('POST', `${BASE}/import-local`);
      expect(res.status).toBe(400);
      expect((await dto()).hasCredentials).toBe(false);
    });

    it('ignores any path sent by the client', async () => {
      await setup();
      const outside = path.join(t.notebookLmDir, 'evil.json');
      fs.writeFileSync(outside, fakeStorageState('evil'));
      const res = await t.api('POST', `${BASE}/import-local`, { path: outside, profile: '../x' });
      expect(res.status).toBe(404);
    });
  });

  describe('renewal', () => {
    it('renews before the next gateway call when the credentials are older than 12 h', async () => {
      await setup();
      await t.api('PUT', BASE, { authJson: fakeStorageState('old-cookie') });
      t.container.notebookLm.config.set({ credentialsUpdatedAt: Date.now() - 13 * HOUR });
      fs.rmSync(logFile, { force: true });

      const nb = await t.container.notebookLm.gateway.createNotebook('Thinkflow — Teste');
      expect(nb.id).toMatch(/^nb_/);

      const log = starts(readFakeCliLog(logFile));
      expect(log.map((e) => e.argv?.[0])).toEqual(['auth', 'create']);
      expect(log[0]!.hasAuthEnv).toBe(false);
      expect(log[1]!.marker).toMatch(/^fake-refreshed-/);
      const cfg = t.container.notebookLm.config.get();
      expect(cfg.credentialsUpdatedAt!).toBeGreaterThan(Date.now() - HOUR);
      expect(JSON.stringify(t.container.settings.get('notebooklm', {}))).not.toContain(
        'fake-refreshed',
      );
    });

    it('"Renovar agora" rotates the credentials and re-checks', async () => {
      await setup();
      await t.api('PUT', BASE, { authJson: fakeStorageState('old-cookie') });
      t.container.notebookLm.config.set({ credentialsUpdatedAt: 1000 });
      const res = await t.api<NotebookLmSettingsDto>('POST', `${BASE}/refresh`);
      expect(res.status).toBe(200);
      expect(res.json.credentialsUpdatedAt!).toBeGreaterThan(Date.now() - HOUR);
      expect(res.json.lastCheck?.ok).toBe(true);
      expect(t.container.notebookLm.config.get().authJson).toContain('fake-refreshed-');
    });

    it('"Renovar agora" explains failures and needs credentials', async () => {
      await setup();
      const none = await t.api<{ error: { code: string } }>('POST', `${BASE}/refresh`);
      expect(none.status).toBe(400);

      await t.api('PUT', BASE, { authJson: fakeStorageState('old-cookie') });
      await useCli({ refresh: 'fail' });
      const res = await t.api<{ error: { code: string; message: string } }>(
        'POST',
        `${BASE}/refresh`,
      );
      expect(res.status).toBe(502);
      expect(res.json.error.code).toBe('notebooklm_auth');
      expect(res.json.error.message).toContain('Entre novamente');
    });
  });
});
