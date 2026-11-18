import type { RequestLogDto } from '@thinkflow/shared';
import { Activity } from 'lucide-react';
import { Badge, Card, EmptyState } from '../../components/ui/card';
import { formatNumber, formatTime } from '../../lib/utils';

const REASONS: Record<string, string> = {
  success: 'ok',
  rate_limited: 'limite de taxa',
  quota_exhausted: 'cota esgotada',
  capacity: 'sobrecarregado',
  server: 'erro no servidor',
  network: 'rede/timeout',
  auth: 'chave inválida',
  model_unavailable: 'modelo indisponível',
  context_length: 'contexto excedido',
  bad_request: 'requisição inválida',
  no_available_connection: 'sem conexão livre',
  unknown_provider: 'provider desconhecido',
};

export function ActivityTab({ logs }: { logs: RequestLogDto[] }) {
  if (logs.length === 0) {
    return (
      <EmptyState
        icon={<Activity className="h-6 w-6" />}
        title="Nenhuma requisição ainda"
        description="Cada chamada ao roteador (chat, Claude Code, clientes OpenAI) aparece aqui com as tentativas de fallback."
      />
    );
  }
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-border text-xs text-muted">
          <tr>
            <th className="px-4 py-3 font-medium">Quando</th>
            <th className="px-4 py-3 font-medium">Origem</th>
            <th className="px-4 py-3 font-medium">Modelo pedido</th>
            <th className="px-4 py-3 font-medium">Atendido por</th>
            <th className="px-4 py-3 font-medium">Tentativas</th>
            <th className="px-4 py-3 text-right font-medium">Tokens</th>
            <th className="px-4 py-3 text-right font-medium">Tempo</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.id} className="border-b border-border last:border-0">
              <td className="px-4 py-2.5 whitespace-nowrap text-muted">
                {formatTime(log.createdAt)}
              </td>
              <td className="px-4 py-2.5 text-xs">{log.source}</td>
              <td className="px-4 py-2.5 font-mono text-xs">{log.requestedModel}</td>
              <td className="px-4 py-2.5">
                {log.success ? (
                  <span className="text-xs">
                    <Badge tone="success">ok</Badge>{' '}
                    <span className="font-mono">
                      {log.providerId}/{log.model}
                    </span>
                  </span>
                ) : (
                  <Badge tone="danger">{REASONS[log.reason ?? ''] ?? log.reason ?? 'erro'}</Badge>
                )}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex flex-wrap gap-1">
                  {log.attempts.map((a, i) => (
                    <Badge
                      key={i}
                      tone={a.reason === 'success' ? 'success' : 'warning'}
                      className="font-mono"
                    >
                      <span title={a.message ?? ''}>
                        {a.providerId}
                        {a.status ? ` ${a.status}` : ''} · {REASONS[a.reason] ?? a.reason}
                      </span>
                    </Badge>
                  ))}
                </div>
              </td>
              <td className="px-4 py-2.5 text-right text-xs whitespace-nowrap text-muted">
                {formatNumber(log.inputTokens)} / {formatNumber(log.outputTokens)}
              </td>
              <td className="px-4 py-2.5 text-right text-xs whitespace-nowrap text-muted">
                {(log.latencyMs / 1000).toFixed(1)}s
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
