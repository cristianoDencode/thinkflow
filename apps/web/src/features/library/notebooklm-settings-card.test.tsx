import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NotebookLmLoginStatusDto, NotebookLmSettingsDto } from '@thinkflow/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notify } from '../../lib/notify';
import { ThemeProvider } from '../../lib/theme';
import { NotebookLmSettingsCard } from './notebooklm-settings-card';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const settings = (over: Partial<NotebookLmSettingsDto> = {}): NotebookLmSettingsDto => ({
  enabled: false,
  hasCredentials: false,
  credentialsUpdatedAt: null,
  cliCommand: '/home/u/.local/share/thinkflow/notebooklm-venv/bin/notebooklm',
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
  queriesToday: 3,
  timeoutSec: 120,
  fallbackToLocal: true,
  lastCheck: null,
  loginSupported: true,
  localProfileAvailable: false,
  ...over,
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <NotebookLmSettingsCard />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('NotebookLmSettingsCard', () => {
  let current: NotebookLmSettingsDto;
  let login: NotebookLmLoginStatusDto;
  let fetchMock: ReturnType<typeof vi.fn>;
  const calls = (method: string, url: string) =>
    fetchMock.mock.calls.filter(
      ([u, i]) => u === url && ((i as RequestInit | undefined)?.method ?? 'GET') === method,
    );

  beforeEach(() => {
    current = settings();
    login = { state: 'idle', message: '' };
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const base = '/api/library/notebooklm';
      if (url === base && method === 'GET') return json(current);
      if (url === base && method === 'PUT') {
        current = { ...current, ...JSON.parse(init!.body as string), authJson: undefined };
        if (JSON.parse(init!.body as string).authJson) current.hasCredentials = true;
        return json(current);
      }
      if (url === `${base}/login` && method === 'GET') return json(login);
      if (url === `${base}/login` && method === 'POST') {
        login = { state: 'waiting', message: 'janela aberta' };
        return json(login, 202);
      }
      if (url === `${base}/login` && method === 'DELETE') {
        login = { state: 'idle', message: '' };
        return json(login);
      }
      if (url === `${base}/import-local`) {
        current = settings({
          hasCredentials: true,
          credentialsUpdatedAt: Date.now(),
          localProfileAvailable: true,
        });
        return json(current);
      }
      if (url === `${base}/refresh`) return json({ ...current, credentialsUpdatedAt: Date.now() });
      if (url === `${base}/test`) return json({ ok: true, message: 'Conectado como a@b.c' });
      if (url === `${base}/credentials`) {
        current = settings();
        return json(current);
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    notify.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('warns about the experimental, unofficial nature and data leaving the server', async () => {
    renderCard();
    expect(await screen.findByText('NotebookLM (experimental)')).toBeTruthy();
    expect(screen.getByText(/não oficial/)).toBeTruthy();
    expect(screen.getByText(/saem do servidor/)).toBeTruthy();
    expect(screen.getByText(/conta Google separada/)).toBeTruthy();
    expect(screen.getByText('Não conectado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Importar login existente/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Renovar agora/ })).toBeNull();
    expect(screen.getByText(/Consultas hoje: 3\/50/)).toBeTruthy();
    expect(
      (screen.getByRole('switch', { name: 'Ativar o NotebookLM' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('starts the Google login and offers to cancel it while waiting', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: /Entrar com Google/ }));
    expect(await screen.findByText(/Uma janela de login do Google foi aberta/)).toBeTruthy();
    expect(calls('POST', '/api/library/notebooklm/login')).toHaveLength(1);
    expect(
      (screen.getByRole('button', { name: /Entrar com Google/ }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(calls('DELETE', '/api/library/notebooklm/login')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/Uma janela de login/)).toBeNull());
  });

  it('announces a finished login once and refreshes the status', async () => {
    const success = vi.spyOn(notify, 'success');
    login = { state: 'done', message: 'Login concluído. Conectado como a@b.c' };
    current = settings({
      hasCredentials: true,
      credentialsUpdatedAt: Date.now(),
      lastCheck: { at: Date.now(), ok: true, message: 'Conectado como a@b.c', account: 'a@b.c' },
    });
    renderCard();
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith('Login concluído. Conectado como a@b.c'),
    );
    expect(success).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(calls('DELETE', '/api/library/notebooklm/login')).toHaveLength(1));
    expect(await screen.findByText('Conectado')).toBeTruthy();
    expect(screen.getByText(/Conectado como a@b.c/)).toBeTruthy();
  });

  it('shows login errors', async () => {
    const error = vi.spyOn(notify, 'error');
    login = { state: 'error', message: 'O login não foi concluído (tempo esgotado).' };
    renderCard();
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('O login não foi concluído (tempo esgotado).'),
    );
  });

  it('disables the login button with a hint when the server has no display', async () => {
    current = settings({ loginSupported: false });
    login = {
      state: 'unsupported',
      message:
        "O servidor não tem tela para abrir o login. Use 'Importar login existente' ou cole o storage_state.json.",
    };
    renderCard();
    const button = (await screen.findByRole('button', {
      name: /Entrar com Google/,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await waitFor(() => expect(button.title).toContain('Importar login existente'));
  });

  it('imports the existing local login', async () => {
    const user = userEvent.setup();
    current = settings({ localProfileAvailable: true });
    renderCard();
    await user.click(await screen.findByRole('button', { name: /Importar login existente/ }));
    await waitFor(() =>
      expect(calls('POST', '/api/library/notebooklm/import-local')).toHaveLength(1),
    );
    expect(await screen.findByRole('button', { name: /Renovar agora/ })).toBeTruthy();
  });

  it('renews, tests and removes the credentials', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    current = settings({
      hasCredentials: true,
      enabled: true,
      credentialsUpdatedAt: Date.now() - 3600_000,
      lastCheck: { at: Date.now(), ok: false, message: 'Credenciais expiradas', account: null },
    });
    renderCard();
    expect(await screen.findByText('Sessão com problema')).toBeTruthy();
    expect(screen.getByText(/Credenciais expiradas/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Renovar agora/ }));
    await waitFor(() => expect(calls('POST', '/api/library/notebooklm/refresh')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Testar conexão' }));
    await waitFor(() => expect(calls('POST', '/api/library/notebooklm/test')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Remover credenciais' }));
    await waitFor(() =>
      expect(calls('DELETE', '/api/library/notebooklm/credentials')).toHaveLength(1),
    );
    expect(await screen.findByText('Não conectado')).toBeTruthy();
  });

  it('sends pasted credentials only when provided, and never shows them back', async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByText('Não conectado');
    const save = screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await user.click(screen.getByText('Colar manualmente'));
    const box = screen.getByLabelText('storage_state.json') as HTMLTextAreaElement;
    await user.click(box);
    await user.paste('{"cookies":[{"name":"SID"}]}');
    await user.click(save);

    await waitFor(() => expect(calls('PUT', '/api/library/notebooklm')).toHaveLength(1));
    const body = JSON.parse(
      (calls('PUT', '/api/library/notebooklm')[0]![1] as RequestInit).body as string,
    );
    expect(body.authJson).toBe('{"cookies":[{"name":"SID"}]}');
    await waitFor(() =>
      expect((screen.getByLabelText('storage_state.json') as HTMLTextAreaElement).value).toBe(''),
    );
  });

  it('saves settings without credentials when the textarea is empty', async () => {
    const user = userEvent.setup();
    renderCard();
    const timeout = await screen.findByLabelText('Tempo limite (s)');
    await user.clear(timeout);
    await user.type(timeout, '90');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(calls('PUT', '/api/library/notebooklm')).toHaveLength(1));
    const body = JSON.parse(
      (calls('PUT', '/api/library/notebooklm')[0]![1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({ timeoutSec: 90 });
    expect(body).not.toHaveProperty('authJson');
  });
  it('shows the plan selector defaulting to automatic, with the table values per plan', async () => {
    renderCard();
    const select = (await screen.findByLabelText('Plano da conta')) as HTMLSelectElement;
    expect(select.value).toBe('auto');
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels[0]).toBe('Automático (detectar)');
    expect(labels).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Gratuito'),
        expect.stringContaining('Plus'),
        expect.stringContaining('Pro — 300 fontes, 500 consultas/dia'),
        expect.stringContaining('Ultra 20 TB'),
        expect.stringContaining('Ultra 30 TB'),
        expect.stringContaining('Workspace Expanded'),
      ]),
    );
    expect(
      screen.getByText(/Em uso: até 50 fontes por notebook e 50 consultas por dia/),
    ).toBeTruthy();
  });

  it('sends the chosen plan and leaves the daily limit following the plan', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.selectOptions(await screen.findByLabelText('Plano da conta'), 'pro');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(calls('PUT', '/api/library/notebooklm')).toHaveLength(1));
    const body = JSON.parse(
      (calls('PUT', '/api/library/notebooklm')[0]![1] as RequestInit).body as string,
    );
    expect(body.plan).toBe('pro');
    expect(body).not.toHaveProperty('dailyQueryLimit');
  });

  it('sends the daily limit only when the user edits it', async () => {
    const user = userEvent.setup();
    renderCard();
    const limit = await screen.findByLabelText('Limite diário de consultas');
    await user.clear(limit);
    await user.type(limit, '120');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(calls('PUT', '/api/library/notebooklm')).toHaveLength(1));
    const body = JSON.parse(
      (calls('PUT', '/api/library/notebooklm')[0]![1] as RequestInit).body as string,
    );
    expect(body.dailyQueryLimit).toBe(120);
  });

  it('shows what was detected in the account', async () => {
    current = settings({
      hasCredentials: true,
      sourceLimit: 300,
      dailyQueryLimit: 500,
      detection: {
        at: new Date(2026, 10, 13, 14, 5).getTime(),
        sourceLimit: 300,
        notebookLimit: 500,
        tier: 2,
        planLabel: 'Pro',
        unavailableReason: null,
      },
    });
    renderCard();
    expect(
      await screen.findByText(
        'Detectado: Pro — 300 fontes por notebook, 500 consultas/dia (em 13/11 14:05)',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Em uso: até 300 fontes por notebook e 500 consultas por dia/),
    ).toBeTruthy();
  });

  it('explains why detection is not available', async () => {
    current = settings({
      hasCredentials: true,
      detection: {
        at: null,
        sourceLimit: null,
        notebookLimit: null,
        tier: null,
        planLabel: null,
        unavailableReason:
          'Detecção automática indisponível: o comando da CLI usa um lançador (ex.: uvx) em vez do executável notebooklm. Escolha o plano da conta manualmente.',
      },
    });
    renderCard();
    expect(
      await screen.findByText(/Detecção automática indisponível: o comando da CLI/),
    ).toBeTruthy();
  });

  it('goes back to the plan limit when the daily limit was customised', async () => {
    const user = userEvent.setup();
    current = settings({ dailyQueryLimit: 77, dailyQueryLimitCustom: true });
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Usar o limite do plano' }));
    await waitFor(() => expect(calls('PUT', '/api/library/notebooklm')).toHaveLength(1));
    const body = JSON.parse(
      (calls('PUT', '/api/library/notebooklm')[0]![1] as RequestInit).body as string,
    );
    expect(body).toEqual({ dailyQueryLimit: null });
  });
});
