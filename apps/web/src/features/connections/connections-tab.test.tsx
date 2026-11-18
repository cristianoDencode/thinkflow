import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ConnectionDto } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import { ConnectionsTab } from './connections-tab';

const connection = (over: Partial<ConnectionDto> = {}): ConnectionDto => ({
  id: 'c1',
  providerId: 'groq',
  providerName: 'Groq',
  name: 'Groq pessoal',
  apiKeyPreview: 'gsk_…abcd',
  baseUrl: '',
  priority: 10,
  enabled: true,
  defaultModel: '',
  status: 'ok',
  cooldownUntil: null,
  backoffLevel: 0,
  lastError: null,
  lastErrorAt: null,
  lastUsedAt: null,
  successCount: 3,
  failureCount: 1,
  createdAt: 0,
  usageToday: { requests: 42, tokens: 310_000 },
  quota: [],
  ...over,
});

function renderTab(connections: ConnectionDto[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConnectionsTab connections={connections} onEdit={() => {}} onCreate={() => {}} />
    </QueryClientProvider>,
  );
}

describe('ConnectionsTab quota line', () => {
  it('shows only the app usage when the provider reported nothing', () => {
    renderTab([connection()]);
    expect(screen.getByTestId('connection-quota').textContent).toBe(
      'usado pelo app hoje: 42 req · 310k tokens',
    );
  });

  it('shows provider-reported limits before the app usage', () => {
    renderTab([
      connection({
        quota: [
          {
            metric: 'requests',
            window: 'day',
            limit: 1000,
            remaining: 999,
            used: 1,
            resetAt: Date.now() + 10 * 60_000,
            model: 'm',
            source: 'headers',
            observedAt: Date.now(),
          },
          {
            metric: 'tokens',
            window: 'minute',
            limit: 8000,
            remaining: null,
            used: null,
            resetAt: null,
            model: 'm',
            source: 'headers',
            observedAt: Date.now(),
          },
        ],
      }),
    ]);
    const text = screen.getByTestId('connection-quota').textContent!;
    expect(text).toContain('Requisições/dia: 1/1k usadas (zera em 10 min)');
    expect(text).toContain('8k tokens/min');
    expect(text).toMatch(/usado pelo app hoje: 42 req · 310k tokens$/);
  });
});
