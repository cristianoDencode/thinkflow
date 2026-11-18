import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OneDriveStatusDto } from '@thinkflow/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json } from '../reports/fixtures';
import { OneDriveSettings } from './onedrive-settings';

const base: OneDriveStatusDto = {
  clientId: '',
  hasClientSecret: false,
  redirectUri: 'http://localhost:5173/api/integrations/onedrive/callback',
  redirectUriOverride: '',
  redirectUriWarning: null,
  state: 'disconnected',
  account: null,
  connectedAt: null,
  defaultFolder: null,
  namingPattern: 'CT {ticketId} - {title}.docx',
  defaultNamingPattern: 'CT {ticketId} - {title}.docx',
  scopes: ['Files.ReadWrite', 'offline_access', 'User.Read'],
};
const CLIENT_ID = '11111111-2222-3333-4444-555555555555';

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('OneDriveSettings', () => {
  let status: OneDriveStatusDto;
  let calls: { url: string; method: string; body: unknown }[];

  beforeEach(() => {
    status = base;
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (url === '/api/integrations/onedrive' && method === 'GET') return json(status);
        if (url === '/api/integrations/onedrive' && method === 'PUT') {
          status = { ...status, clientId: body.clientId ?? status.clientId };
          return json(status);
        }
        if (url === '/api/integrations/onedrive/connect')
          return json({
            authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1',
          });
        if (url === '/api/integrations/onedrive/disconnect') {
          status = { ...base, clientId: status.clientId };
          return json(status);
        }
        if (url === '/api/integrations/onedrive/folders')
          return json({
            parent: { id: 'root', name: 'OneDrive', path: '/', parentId: null },
            folders: [{ id: 'F1', name: 'Testes', childCount: 2 }],
          });
        if (url === '/api/integrations/onedrive/folders?parentId=F1')
          return json({
            parent: { id: 'F1', name: 'Testes', path: '/Testes', parentId: 'root' },
            folders: [],
          });
        if (url === '/api/integrations/onedrive/default-folder') {
          status = { ...status, defaultFolder: { id: body.id, name: 'Testes', path: '/Testes' } };
          return json(status);
        }
        return json({}, 404);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the redirect URI to copy and the setup guide', async () => {
    wrap(<OneDriveSettings />);
    const field = (await screen.findByLabelText('URI de redirecionamento')) as HTMLInputElement;
    expect(field.value).toBe('http://localhost:5173/api/integrations/onedrive/callback');
    expect(screen.getByText(/Aplicativos móveis e de desktop/, { selector: 'li' })).toBeTruthy();
    expect(screen.getByText('Não conectado')).toBeTruthy();
  });

  it('saves the settings and sends the browser to Microsoft on Conectar', async () => {
    const navigate = vi.fn();
    wrap(<OneDriveSettings navigate={navigate} />);
    const input = await screen.findByLabelText('ID do aplicativo (client ID)');
    const connect = screen.getByRole('button', { name: /Conectar/ }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);

    await userEvent.type(input, CLIENT_ID);
    await userEvent.click(screen.getByRole('button', { name: /Conectar/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(navigate.mock.calls[0]?.[0]).toMatch(
      /^https:\/\/login\.microsoftonline\.com\/consumers/,
    );
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({ clientId: CLIENT_ID });
    // the secret is only sent when typed
    expect(put?.body).not.toHaveProperty('clientSecret');
    expect(
      calls.map((c) => `${c.method} ${c.url}`).indexOf('POST /api/integrations/onedrive/connect'),
    ).toBeGreaterThan(
      calls.map((c) => `${c.method} ${c.url}`).indexOf('PUT /api/integrations/onedrive'),
    );
  });

  it('shows the connected account, lets the user pick a folder and disconnect', async () => {
    status = {
      ...base,
      clientId: CLIENT_ID,
      state: 'connected',
      account: { name: 'Ana Analista', email: 'ana@outlook.com' },
    };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap(<OneDriveSettings />);

    expect(await screen.findByText('Conectado')).toBeTruthy();
    expect(screen.getByText(/ana@outlook.com/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Escolher pasta/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Testes/ }));
    await waitFor(() => expect(screen.getByTestId('onedrive-path').textContent).toBe('/Testes'));
    await userEvent.click(screen.getByRole('button', { name: 'Usar esta pasta' }));
    await waitFor(() =>
      expect(screen.getByTestId('onedrive-default-folder').textContent).toBe('/Testes'),
    );
    expect(calls.find((c) => c.url.endsWith('/default-folder'))?.body).toEqual({ id: 'F1' });

    await userEvent.click(screen.getByRole('button', { name: /Desconectar/ }));
    await waitFor(() => expect(screen.getByText('Não conectado')).toBeTruthy());
  });

  it('prompts to reconnect when the authorization was revoked', async () => {
    status = {
      ...base,
      clientId: CLIENT_ID,
      state: 'reconnect_required',
      account: { name: 'Ana', email: 'a@b.com' },
    };
    wrap(<OneDriveSettings />);
    expect(await screen.findByText(/expirou ou foi revogada/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reconectar/ })).toBeTruthy();
  });

  it('shows the redirect URI warning from the server', async () => {
    status = { ...base, redirectUriWarning: 'O portal da Microsoft não aceita "http://127.0.0.1"' };
    wrap(<OneDriveSettings />);
    expect(await screen.findByText(/não aceita "http:\/\/127\.0\.0\.1"/)).toBeTruthy();
  });
});
