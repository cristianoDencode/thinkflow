import { RefreshCw, Wifi } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/card';
import { errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { useStorageCheck, useStorageStatus, useStorageSync } from '../../lib/queries';
import { timeAgo } from '../../lib/utils';

const DRIVER_LABELS = {
  local: 'Pasta local',
  s3: 'MinIO / S3',
  memory: 'Memória (testes)',
} as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-muted sm:w-36">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Read-only view of the document storage (secrets live only in the environment). */
export function StorageSettings() {
  const { data, isLoading, error } = useStorageStatus();
  const check = useStorageCheck();
  const sync = useStorageSync();

  const run = async (fn: () => Promise<unknown>, message: (r: unknown) => string) => {
    try {
      const result = await fn();
      notify.success(message(result));
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const testar = () =>
    run(
      () => check.mutateAsync(),
      (r) => {
        const s = r as { available: boolean; reason: string | null };
        return s.available
          ? 'Armazenamento disponível'
          : `Armazenamento indisponível: ${s.reason ?? 'sem detalhes'}`;
      },
    );
  const reenviar = () =>
    run(
      () => sync.mutateAsync(),
      () => 'Reenvio de pendentes iniciado',
    );

  return (
    <div className="text-sm">
      {isLoading && <p className="text-muted">Carregando…</p>}
      {error && <p className="text-danger">{errorMessage(error)}</p>}
      {data === null && <p className="text-muted">Este servidor não informa o armazenamento.</p>}
      {data && (
        <dl className="space-y-1.5">
          <Row label="Driver">{DRIVER_LABELS[data.driver]}</Row>
          <Row label="Guarda">Relatórios gerados e arquivos enviados à Biblioteca</Row>
          <Row label={data.driver === 'local' ? 'Pasta' : 'Endpoint / bucket'}>
            <span className="font-mono text-xs">{data.location}</span>
          </Row>
          {data.driver === 's3' && data.bucket && (
            <Row label="Bucket">
              <span className="font-mono text-xs">{data.bucket}</span>
            </Row>
          )}
          {data.prefix && (
            <Row label="Prefixo">
              <span className="font-mono text-xs">{data.prefix}</span>
            </Row>
          )}
          <Row label="Status">
            <Badge tone={data.available ? 'success' : 'danger'}>
              {data.available ? 'Disponível' : 'Indisponível'}
            </Badge>
            {!data.available && data.reason && <span className="ml-2">{data.reason}</span>}
          </Row>
          <Row label="Última checagem">
            {data.checkedAt ? timeAgo(data.checkedAt) : '—'}
            {data.latencyMs != null && <span className="text-muted"> · {data.latencyMs} ms</span>}
          </Row>
          <Row label="Pendentes">
            {data.pendingUploads}{' '}
            <span className="text-muted">
              {data.pendingUploads === 1
                ? 'documento aguardando envio'
                : 'documentos aguardando envio'}
            </span>
          </Row>
          {data.lastError && (
            <Row label="Último erro">
              <span className="text-danger">{data.lastError}</span>
            </Row>
          )}
        </dl>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={check.isPending}
          onClick={() => void testar()}
        >
          <Wifi className="h-4 w-4" /> Testar
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={sync.isPending}
          onClick={() => void reenviar()}
        >
          <RefreshCw className="h-4 w-4" /> Reenviar pendentes
        </Button>
      </div>
      <p className="mt-4 text-xs text-muted">
        Somente leitura: a configuração (driver, endpoint, bucket e credenciais) é feita por
        variáveis de ambiente do servidor e as credenciais nunca aparecem aqui. Veja{' '}
        <code className="font-mono">deploy/minio/README.md</code> e o README do projeto.
      </p>
    </div>
  );
}
