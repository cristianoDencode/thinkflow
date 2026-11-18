import { useQueryClient } from '@tanstack/react-query';
import type { DatabaseConnectionDto, DatabaseTestResultDto } from '@thinkflow/shared';
import {
  Check,
  Copy,
  Database,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Star,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge, Card, EmptyState, PageHeader } from '../../components/ui/card';
import { ConfirmButton } from '../../components/ui/dialog';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys, useDatabases } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { DatabaseDialog } from './database-dialog';

const READ_ONLY_SQL = `CREATE ROLE thinkflow_leitura LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE meu_banco TO thinkflow_leitura;
GRANT USAGE ON SCHEMA public TO thinkflow_leitura;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO thinkflow_leitura;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO thinkflow_leitura;`;

function ReadOnlyHelp() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(READ_ONLY_SQL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      notify.error('Não foi possível copiar');
    }
  };
  return (
    <details className="mt-4 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        <ShieldCheck className="h-4 w-4 text-accent-text" aria-hidden />
        Como criar um usuário somente leitura
      </summary>
      <p className="mt-2 text-muted">
        O Thinkflow só executa consultas de leitura, mas o mais seguro é conectar com um usuário que
        não tem permissão de escrita. Rode no seu Postgres, trocando os nomes e a senha:
      </p>
      <div className="relative mt-2">
        <pre className="scrollbar-thin overflow-auto rounded-lg bg-bg-elevated p-3 pr-12 font-mono text-xs">
          {READ_ONLY_SQL}
        </pre>
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-2 right-2"
          onClick={() => void copy()}
          aria-label="Copiar SQL"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </details>
  );
}

function aiLabel(c: DatabaseConnectionDto): string {
  return c.aiAccess === 'schema'
    ? 'IA: só estrutura'
    : `IA: amostra mascarada (${c.sampleRows} ${c.sampleRows === 1 ? 'linha' : 'linhas'})`;
}

const SSL_BADGE: Record<DatabaseConnectionDto['sslMode'], string | null> = {
  disable: null,
  require: 'SSL',
  'verify-full': 'SSL (verificado)',
};

function TestResult({ result }: { result: DatabaseTestResultDto }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-lg px-3 py-2 text-xs',
        result.ok ? 'bg-success-soft' : 'bg-danger-soft text-danger',
      )}
      role="status"
    >
      <p className={cn(result.ok && 'text-success')}>
        {result.ok
          ? `Conectado em ${result.latencyMs ?? '—'} ms${
              result.serverVersion ? ` · ${result.serverVersion}` : ''
            }${result.currentUser ? ` · usuário ${result.currentUser}` : ''}`
          : result.message}
      </p>
      {result.ok && result.canWrite && (
        <p className="flex items-start gap-1.5 rounded-md bg-warning-soft px-2 py-1.5 text-warning">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Este usuário pode alterar dados. O Thinkflow só executa leitura, mas prefira um usuário
          somente leitura.
        </p>
      )}
    </div>
  );
}

export function DatabasesPage() {
  const { data: connections = [], isLoading } = useDatabases();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{ open: boolean; editing: DatabaseConnectionDto | null }>({
    open: false,
    editing: null,
  });
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, DatabaseTestResultDto>>({});

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.databases });

  const test = async (c: DatabaseConnectionDto) => {
    setTesting(c.id);
    try {
      const result = await api.post<DatabaseTestResultDto>(`/api/databases/${c.id}/test`);
      setResults((prev) => ({ ...prev, [c.id]: result }));
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setTesting(null);
    }
  };

  const makeDefault = async (c: DatabaseConnectionDto) => {
    try {
      await api.put(`/api/databases/${c.id}`, { isDefault: true });
      notify.success(`${c.name} agora é a conexão padrão`);
      await refresh();
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const remove = async (c: DatabaseConnectionDto) => {
    try {
      await api.del(`/api/databases/${c.id}`);
      notify.success('Conexão excluída');
      await refresh();
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader
        title="Database — conexões Postgres"
        description="Conecte bancos Postgres para consultar em Dados com IA. Tudo é somente leitura, e a senha fica armazenada criptografada."
        actions={
          <Button onClick={() => setDialog({ open: true, editing: null })}>
            <Plus className="h-4 w-4" /> Nova conexão
          </Button>
        }
      />

      {isLoading ? (
        <Card className="p-5 text-sm text-muted">Carregando…</Card>
      ) : connections.length === 0 ? (
        <EmptyState
          icon={<Database className="h-6 w-6" />}
          title="Nenhuma conexão Postgres"
          description="Cadastre um banco para perguntar em português (ou rodar SQL) em Dados com IA. Recomendamos um usuário somente leitura: a IA vê só a estrutura ou uma amostra mascarada, e você vê os resultados completos na tela."
          action={
            <Button onClick={() => setDialog({ open: true, editing: null })}>
              <Plus className="h-4 w-4" /> Nova conexão
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {connections.map((c) => {
            const result = results[c.id];
            const ssl = SSL_BADGE[c.sslMode];
            return (
              <Card key={c.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text">
                    <Database className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-medium">{c.name}</h3>
                      {c.isDefault && <Badge tone="accent">Padrão</Badge>}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted">
                      {c.user}@{c.host}:{c.port}/{c.database}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {ssl && <Badge>{ssl}</Badge>}
                      <Badge tone={c.aiAccess === 'masked' ? 'warning' : 'success'}>
                        {aiLabel(c)}
                      </Badge>
                    </div>
                  </div>
                </div>

                {result && <TestResult result={result} />}

                <div className="flex flex-wrap justify-end gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void test(c)}
                    loading={testing === c.id}
                    aria-label={`Testar ${c.name}`}
                  >
                    {testing !== c.id && <Play className="h-3.5 w-3.5" />} Testar
                  </Button>
                  {!c.isDefault && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void makeDefault(c)}
                      aria-label={`Tornar ${c.name} a conexão padrão`}
                    >
                      <Star className="h-3.5 w-3.5" /> Tornar padrão
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDialog({ open: true, editing: c })}
                    aria-label={`Editar ${c.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <ConfirmButton label={`Excluir ${c.name}`} onConfirm={() => void remove(c)}>
                    <Trash2 className="h-4 w-4" />
                  </ConfirmButton>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <ReadOnlyHelp />

      <DatabaseDialog
        open={dialog.open}
        editing={dialog.editing}
        onClose={() => setDialog({ open: false, editing: null })}
        onSaved={() => void refresh()}
      />
    </div>
  );
}
