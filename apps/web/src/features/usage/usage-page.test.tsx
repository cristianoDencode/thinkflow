import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UsageReportDto } from '@thinkflow/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../lib/theme';
import { UsagePage } from './usage-page';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function makeReport(overrides: Partial<UsageReportDto> = {}): UsageReportDto {
  const daily = Array.from({ length: 30 }, (_, i) => ({
    day: `2026-11-${String(i + 1).padStart(2, '0')}`,
    inputTokens: i < 10 ? 1000 : 0,
    outputTokens: i < 10 ? 500 : 0,
    requests: i < 10 ? 3 : 0,
    failures: 0,
  }));
  return {
    month: '2026-11',
    current: true,
    daysInMonth: 30,
    daysElapsed: 10,
    resetsAt: new Date(2026, 11, 1).getTime(),
    totals: {
      requests: 30,
      failures: 3,
      inputTokens: 10000,
      outputTokens: 5000,
      totalTokens: 15000,
      estimatedRequests: 2,
    },
    previous: { totalTokens: 10000, requests: 20 },
    daily,
    byProvider: [
      { providerId: 'groq', requests: 30, failures: 3, inputTokens: 10000, outputTokens: 5000 },
    ],
    byModel: [
      {
        providerId: 'groq',
        model: 'llama-3.3',
        requests: 30,
        inputTokens: 10000,
        outputTokens: 5000,
      },
    ],
    bySource: [{ source: 'gateway', requests: 30, totalTokens: 15000 }],
    projection: {
      basis: 'month',
      basisDays: 10,
      daily: 1500,
      weekly: 10500,
      monthly: 45000,
      yearly: 547500,
    },
    budget: { monthlyTokens: 30000, usedPct: 50, projectedPct: 150 },
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/', element: <UsagePage /> }]);
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('UsagePage', () => {
  let report: UsageReportDto;

  beforeEach(() => {
    report = makeReport();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/usage/months'))
          return json({ current: '2026-11', months: ['2026-11', '2026-10'] });
        if (url.startsWith('/api/usage')) return json(report);
        return json({});
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows totals, projection, budget warning and breakdowns', async () => {
    renderPage();
    expect(await screen.findByText('Tokens no mês')).toBeInTheDocument();
    expect(screen.getByText('+50% vs. mês anterior')).toBeInTheDocument();
    expect(screen.getByText('Baseado na média de 10 dias deste mês.')).toBeInTheDocument();
    expect(screen.getByText(/passar do orçamento mensal/)).toBeInTheDocument();
    expect(screen.getByText('llama-3.3')).toBeInTheDocument();
    expect(screen.getByText('Gateway (/v1)')).toBeInTheDocument();
    expect(screen.getByText(/sem contagem do provider/)).toBeInTheDocument();
    expect(screen.getByText('Como é calculado')).toBeInTheDocument();
  });

  it('switches the projection horizon', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Tokens no mês');
    expect(screen.getByText('45.000')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Anual' }));
    expect(screen.getByText('547.500')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Semanal' }));
    expect(screen.getByText('10.500')).toBeInTheDocument();
  });

  it('shows an empty state when there is no usage', async () => {
    report = makeReport({
      totals: {
        requests: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedRequests: 0,
      },
      budget: null,
      previous: null,
    });
    renderPage();
    expect(await screen.findByText('Nenhum uso neste mês')).toBeInTheDocument();
  });
});
