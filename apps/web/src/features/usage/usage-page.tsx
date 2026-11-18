import { useQueryClient } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge, Card, EmptyState, PageHeader, Tabs } from '../../components/ui/card';
import { Input, Select } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys, useUsage, useUsageMonths } from '../../lib/queries';
import { cn, formatNumber } from '../../lib/utils';
import { Breakdown, compact, DailyChart, monthLabel, StatCard } from './usage-parts';

type Horizon = 'daily' | 'weekly' | 'monthly' | 'yearly';

const HORIZONS: { value: Horizon; label: string; unit: string }[] = [
  { value: 'daily', label: 'Diária', unit: 'por dia' },
  { value: 'weekly', label: 'Semanal', unit: 'por semana' },
  { value: 'monthly', label: 'Mensal', unit: 'neste mês' },
  { value: 'yearly', label: 'Anual', unit: 'por ano' },
];

const SOURCE_LABELS: Record<string, string> = {
  chat: 'Chat',
  gateway: 'Gateway (/v1)',
  agent: 'Agente',
  'data-ai': 'Dados com IA',
  summary: 'Resumos de histórico',
  'library-ocr': 'Biblioteca — OCR',
  'library-notebooklm': 'Biblioteca — NotebookLM',
  'diagram-repair': 'Diagramas — correção',
  'template-assist': 'Modelos — assistente',
  'report-intake': 'Relatórios — preparação',
  'report-research': 'Relatórios — pesquisa',
  'report-outline': 'Relatórios — roteiro',
  'report-section': 'Relatórios — redação',
};

function pctChange(now: number, before: number): string | null {
  if (before <= 0) return null;
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct > 0 ? '+' : ''}${pct}% vs. mês anterior`;
}

function daysUntil(ts: number): number {
  return Math.max(Math.ceil((ts - Date.now()) / 86_400_000), 0);
}

export function UsagePage() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [horizon, setHorizon] = useState<Horizon>('monthly');
  const [budgetInput, setBudgetInput] = useState('');
  const { data: months } = useUsageMonths();
  const { data: report, isLoading, error } = useUsage(month);

  const budget = report?.budget?.monthlyTokens ?? 0;
  useEffect(() => {
    setBudgetInput(budget > 0 ? String(budget) : '');
  }, [budget]);

  const saveBudget = async (tokens: number) => {
    try {
      await api.put('/api/usage/budget', { monthlyTokens: tokens });
      notify.success(tokens > 0 ? 'Orçamento mensal salvo' : 'Orçamento removido');
      await queryClient.invalidateQueries({ queryKey: keys.usage });
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const options = months?.months ?? (report ? [report.month] : []);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader
        title="Uso"
        description="Tokens consumidos pelo roteador. O contador zera todo dia 1º."
        actions={
          options.length > 0 && (
            <Select
              aria-label="Mês"
              value={report?.month ?? ''}
              onChange={(e) =>
                setMonth(e.target.value === months?.current ? undefined : e.target.value)
              }
              className="w-auto min-w-44"
            >
              {options.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                  {m === months?.current ? ' (atual)' : ''}
                </option>
              ))}
            </Select>
          )
        }
      />

      {error ? (
        <Card className="p-5 text-sm text-danger">{errorMessage(error)}</Card>
      ) : isLoading || !report ? (
        <Card className="p-5 text-sm text-muted">Carregando…</Card>
      ) : report.totals.requests === 0 ? (
        <EmptyState
          icon={<Gauge className="h-6 w-6" />}
          title="Nenhum uso neste mês"
          description="Assim que o chat, o agente ou o Claude Code enviarem requisições pelo Thinkflow, o consumo aparece aqui."
        />
      ) : (
        <div className="space-y-4">
          {report.current && (
            <p className="text-sm text-muted">
              Reinicia em {daysUntil(report.resetsAt)}{' '}
              {daysUntil(report.resetsAt) === 1 ? 'dia' : 'dias'} · dia {report.daysElapsed} de{' '}
              {report.daysInMonth}
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Tokens no mês" value={compact(report.totals.totalTokens)}>
              <p>
                {formatNumber(report.totals.inputTokens)} entrada ·{' '}
                {formatNumber(report.totals.outputTokens)} saída
              </p>
              {report.previous && (
                <p>{pctChange(report.totals.totalTokens, report.previous.totalTokens)}</p>
              )}
            </StatCard>
            <StatCard label="Requisições" value={formatNumber(report.totals.requests)}>
              {report.totals.failures > 0
                ? `${((report.totals.failures / report.totals.requests) * 100).toFixed(1).replace('.', ',')}% com falha`
                : 'Nenhuma falha'}
            </StatCard>
            <StatCard label="Média por dia" value={compact(report.projection.daily)}>
              {report.projection.basis === 'last7days'
                ? `últimos ${report.projection.basisDays} dias com uso`
                : `${report.projection.basisDays} ${report.projection.basisDays === 1 ? 'dia' : 'dias'} do mês`}
            </StatCard>
            <StatCard
              label={report.current ? 'Projeção do mês' : 'Total do mês'}
              value={compact(report.projection.monthly)}
            >
              {report.current ? 'se o ritmo continuar' : 'consumo real'}
            </StatCard>
          </div>

          <Card className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Estimativa</h2>
              <Tabs<Horizon> value={horizon} onChange={setHorizon} items={HORIZONS} />
            </div>
            <p className="text-4xl font-semibold tracking-tight tabular-nums">
              {formatNumber(report.projection[horizon])}
              <span className="ml-2 text-sm font-normal text-muted">
                tokens {HORIZONS.find((h) => h.value === horizon)?.unit}
              </span>
            </p>
            <p className="mt-2 text-sm text-muted">
              {report.projection.basis === 'last7days'
                ? `Baseado na média dos últimos ${report.projection.basisDays} dias com uso (o mês está no início).`
                : `Baseado na média de ${report.projection.basisDays} ${report.projection.basisDays === 1 ? 'dia' : 'dias'} deste mês.`}
            </p>

            <div className="mt-5 border-t border-border pt-4">
              {report.budget && (
                <div className="mb-4">
                  <div className="mb-1 flex justify-between text-xs text-muted">
                    <span>
                      {formatNumber(report.totals.totalTokens)} de{' '}
                      {formatNumber(report.budget.monthlyTokens)} tokens
                    </span>
                    <span>{report.budget.usedPct.toFixed(1).replace('.', ',')}% usado</span>
                  </div>
                  <div className="relative h-2.5 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        report.budget.usedPct >= 100 ? 'bg-danger' : 'bg-accent',
                      )}
                      style={{ width: `${Math.min(report.budget.usedPct, 100)}%` }}
                    />
                    {report.current && (
                      <div
                        className="absolute inset-y-0 w-0.5 bg-warning"
                        style={{ left: `${Math.min(report.budget.projectedPct, 100)}%` }}
                        title={`Projeção: ${report.budget.projectedPct.toFixed(0)}% do orçamento`}
                      />
                    )}
                  </div>
                  {report.current && report.budget.projectedPct > 100 && (
                    <p className="mt-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
                      Nesse ritmo você deve passar do orçamento mensal (projeção de{' '}
                      {report.budget.projectedPct.toFixed(0)}%).
                    </p>
                  )}
                </div>
              )}
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveBudget(Number(budgetInput) || 0);
                }}
              >
                <label htmlFor="usage-budget" className="text-sm text-muted">
                  Orçamento mensal (tokens)
                </label>
                <Input
                  id="usage-budget"
                  type="number"
                  min={0}
                  step={1000}
                  inputMode="numeric"
                  placeholder="sem orçamento"
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value)}
                  className="h-9 w-40"
                />
                <Button type="submit" size="sm" variant="secondary">
                  Salvar
                </Button>
                {budget > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void saveBudget(0)}
                  >
                    Remover
                  </Button>
                )}
              </form>
            </div>
          </Card>

          <Card className="p-5 sm:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">Tokens por dia</h2>
              {report.totals.estimatedRequests > 0 && (
                <Badge tone="warning">{report.totals.estimatedRequests} estimadas</Badge>
              )}
            </div>
            <DailyChart report={report} />
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Breakdown
              title="Por provider"
              total={report.totals.totalTokens}
              rows={report.byProvider.map((p) => ({
                key: p.providerId,
                label: p.providerId || 'Sem conexão',
                tokens: p.inputTokens + p.outputTokens,
                requests: p.requests,
              }))}
            />
            <Breakdown
              title="Top modelos"
              total={report.totals.totalTokens}
              rows={report.byModel.map((m) => ({
                key: `${m.providerId}/${m.model}`,
                label: m.model || 'Sem modelo',
                sub: m.providerId,
                tokens: m.inputTokens + m.outputTokens,
                requests: m.requests,
              }))}
            />
          </div>
          <Breakdown
            title="Por origem"
            total={report.totals.totalTokens}
            rows={report.bySource.map((s) => ({
              key: s.source,
              label: SOURCE_LABELS[s.source] ?? s.source,
              tokens: s.totalTokens,
              requests: s.requests,
            }))}
          />

          {report.totals.estimatedRequests > 0 && (
            <p className="text-sm text-muted">
              {report.totals.estimatedRequests}{' '}
              {report.totals.estimatedRequests === 1
                ? 'requisição sem contagem do provider'
                : 'requisições sem contagem do provider'}{' '}
              — tokens de entrada estimados (~4 caracteres por token).
            </p>
          )}
        </div>
      )}

      <details className="mt-6 rounded-2xl border border-border bg-surface p-5 text-sm text-muted">
        <summary className="cursor-pointer font-semibold text-fg">Como é calculado</summary>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
          <li>
            Conta toda requisição que passa pelo roteador (chat, agente e Claude Code via /v1), com
            os tokens de entrada e saída informados pelo provider.
          </li>
          <li>
            O mês vai do dia 1º às 00:00 ao último dia, no fuso horário do servidor. No dia 1º o
            contador recomeça; os meses anteriores continuam disponíveis no seletor.
          </li>
          <li>
            Média diária = tokens do mês ÷ dias decorridos (dias sem uso contam). Semanal = média ×
            7; anual = média × 365; mensal = tokens até agora + média × dias restantes.
          </li>
          <li>
            Nos 2 primeiros dias do mês, a média usa os últimos dias com uso (até 7), para não
            distorcer a projeção.
          </li>
          <li>
            Quando o provider não informa o uso, a entrada é estimada (~4 caracteres por token) e a
            saída conta como 0. O histórico é mantido por 13 meses.
          </li>
        </ul>
      </details>
    </div>
  );
}
