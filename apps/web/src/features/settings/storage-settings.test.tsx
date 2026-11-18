import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StorageStatusDto } from '@thinkflow/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json } from '../reports/fixtures';
import { StorageNotice } from '../reports/storage-notice';
import { StorageSettings } from './storage-settings';

const base: StorageStatusDto = {
  driver: 's3',
  available: true,
  reason: null,
  location: 'http://minio:9000/thinkflow',
  bucket: 'thinkflow',
  prefix: 'docs/',
  checkedAt: Date.now(),
  latencyMs: 12,
  pendingUploads: 0,
  lastError: null,
};

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('storage UI', () => {
  let status: StorageStatusDto;
  let calls: { url: string; method: string }[];

  beforeEach(() => {
    status = base;
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method });
        if (url === '/api/storage/sync') return json({ accepted: true }, 202);
        if (url.startsWith('/api/storage/')) return json(status);
        return json({}, 404);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('settings shows driver, bucket, status and read-only note', async () => {
    wrap(<StorageSettings />);
    expect(await screen.findByText('MinIO / S3')).toBeTruthy();
    expect(screen.getByText('Disponível')).toBeTruthy();
    expect(screen.getByText('thinkflow')).toBeTruthy();
    expect(screen.getByText('12 ms', { exact: false })).toBeTruthy();
    expect(screen.getByText(/variáveis de ambiente/)).toBeTruthy();
  });

  it('settings shows unavailable state with reason, pending and last error', async () => {
    status = {
      ...base,
      available: false,
      reason: 'sem permissão no bucket thinkflow',
      pendingUploads: 3,
      lastError: 'falha no envio',
    };
    wrap(<StorageSettings />);
    expect(await screen.findByText('Indisponível')).toBeTruthy();
    expect(screen.getByText('sem permissão no bucket thinkflow')).toBeTruthy();
    expect(screen.getByText('falha no envio')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('Testar and Reenviar pendentes call the routes', async () => {
    const user = userEvent.setup();
    wrap(<StorageSettings />);
    await screen.findByText('MinIO / S3');
    await user.click(screen.getByRole('button', { name: /Testar/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/storage/check' && c.method === 'POST')).toBe(true),
    );
    await user.click(screen.getByRole('button', { name: /Reenviar pendentes/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/storage/sync' && c.method === 'POST')).toBe(true),
    );
  });

  it('notice hides when healthy and shows when unavailable or pending', async () => {
    const { unmount } = wrap(<StorageNotice />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('status')).toBeNull();
    unmount();

    status = { ...base, available: false, reason: 'MinIO fora do ar' };
    wrap(<StorageNotice />);
    expect(await screen.findByText('Armazenamento de documentos indisponível')).toBeTruthy();
    expect(screen.getByText(/MinIO fora do ar/)).toBeTruthy();
  });

  it('notice shows pending uploads even when available', async () => {
    status = { ...base, pendingUploads: 2 };
    wrap(<StorageNotice />);
    expect(await screen.findByText('Documentos aguardando envio')).toBeTruthy();
    expect(screen.getByText(/2 documentos serão enviados/)).toBeTruthy();
  });
});
