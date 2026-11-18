import { notify } from '../../lib/notify';
import { friendlyError } from '../../lib/friendly-error';
import { useQueryClient } from '@tanstack/react-query';
import type { ConnectionDto, ConnectionStatus, TestConnectionResultDto } from '@thinkflow/shared';
import { Pencil, Play, Plug, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge, Card, EmptyState } from '../../components/ui/card';
import { ConfirmButton } from '../../components/ui/dialog';
import { Switch } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { keys } from '../../lib/queries';
import { formatCountdown, timeAgo } from '../../lib/utils';
import { quotaLabels, quotaLine } from './quota-format';

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function StatusBadge({
  status,
  cooldownUntil,
  now,
}: {
  status: ConnectionStatus;
  cooldownUntil: number | null;
  now: number;
}) {
  switch (status) {
    case 'ok':
      return <Badge tone="success">● OK</Badge>;
    case 'cooldown':
      return (
        <Badge tone="warning">
          ⏳ Cooldown {cooldownUntil ? formatCountdown(cooldownUntil - now) : ''}
        </Badge>
      );
    case 'error':
      return <Badge tone="danger">● Erro</Badge>;
    case 'disabled':
      return <Badge>Desativada</Badge>;
    default:
      return <Badge tone="accent">Não testada</Badge>;
  }
}

export function ConnectionsTab({
  connections,
  onEdit,
  onCreate,
}: {
  connections: ConnectionDto[];
  onEdit(c: ConnectionDto): void;
  onCreate(): void;
}) {
  const queryClient = useQueryClient();
  const now = useNow();
  const [testing, setTesting] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.connections }),
      queryClient.invalidateQueries({ queryKey: keys.models }),
    ]);

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      if (success) notify.success(success);
      await refresh();
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const test = async (c: ConnectionDto) => {
    setTesting(c.id);
    try {
      const result = await api.post<TestConnectionResultDto>(`/api/connections/${c.id}/test`);
      const quota = quotaLabels(result.quota ?? [], Date.now()).join(' · ');
      if (result.ok)
        notify.success(
          `${c.name}: ${result.message} (${result.latencyMs} ms)${quota ? ` — ${quota}` : ''}`,
        );
      else notify.error(`${c.name}: ${result.message}`);
      // a test also clears stale errors and refreshes the quota shown on the card
      await refresh();
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setTesting(null);
    }
  };

  if (connections.length === 0) {
    return (
      <EmptyState
        icon={<Plug className="h-6 w-6" />}
        title="Nenhuma conexão cadastrada"
        description="Adicione chaves de providers gratuitos (OpenRouter, Groq, Mistral…) e o Thinkflow alterna entre elas quando uma estoura o limite."
        action={<Button onClick={onCreate}>Adicionar conexão</Button>}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      {connections.map((c) => (
        <Card key={c.id} className="flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate font-medium">{c.name}</h3>
                <StatusBadge status={c.status} cooldownUntil={c.cooldownUntil} now={now} />
              </div>
              <p className="mt-0.5 truncate text-xs text-muted">
                {c.providerName} · prioridade {c.priority}
                {c.defaultModel ? ` · ${c.defaultModel}` : ''}
                {c.apiKeyPreview ? ` · ${c.apiKeyPreview}` : ''}
              </p>
            </div>
            <Switch
              checked={c.enabled}
              label={`Ativar ${c.name}`}
              onChange={(enabled) =>
                void run(() => api.put(`/api/connections/${c.id}`, { enabled }))
              }
            />
          </div>

          {c.lastError && c.status !== 'ok' && (
            <p
              className="line-clamp-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs break-words text-danger"
              title={c.lastError}
            >
              {friendlyError(c.lastError).title}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1 basis-48">
              <p className="text-xs text-subtle">
                ✓ {c.successCount} · ✕ {c.failureCount} · usado {timeAgo(c.lastUsedAt, now)}
              </p>
              <p
                className="mt-0.5 text-xs break-words text-muted"
                data-testid="connection-quota"
                title="Cota informada pelo provider; o uso do app conta só o que passou por aqui (a mesma chave pode ser usada em outros lugares)"
              >
                {quotaLine(c.quota, c.usageToday, now)}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {c.status === 'cooldown' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void run(() => api.post(`/api/connections/${c.id}/reset`), 'Cooldown liberado')
                  }
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Liberar
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void test(c)}
                loading={testing === c.id}
              >
                {testing !== c.id && <Play className="h-3.5 w-3.5" />} Testar
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onEdit(c)}
                aria-label={`Editar ${c.name}`}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <ConfirmButton
                label={`Excluir ${c.name}`}
                onConfirm={() =>
                  void run(() => api.del(`/api/connections/${c.id}`), 'Conexão excluída')
                }
              >
                <Trash2 className="h-4 w-4" />
              </ConfirmButton>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
