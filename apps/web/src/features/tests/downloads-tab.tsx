import {
  DOWNLOAD_SOURCE_LABELS,
  DOWNLOAD_STATUS_LABELS,
  stepTitle,
  type TestDownloadDto,
  type TestSessionDto,
} from '@thinkflow/shared';
import { Download, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { Badge, Card, EmptyState } from '../../components/ui/card';
import { ConfirmButton } from '../../components/ui/dialog';
import { api } from '../../lib/api';
import { useTestDownloads } from '../../lib/queries';
import { cn, formatTime } from '../../lib/utils';
import { formatFileSize } from './format';
import { useScrollToHash } from './use-scroll-to-hash';
import { useSessionAction } from './use-session-action';

const STATUS_TONE = { saved: 'success', failed: 'danger', skipped: 'warning' } as const;

/** A download link styled like a small button (the file is an authenticated same-origin GET). */
export function DownloadLink({ item, className }: { item: TestDownloadDto; className?: string }) {
  if (!item.fileUrl) return null;
  return (
    <a
      href={item.fileUrl}
      download={item.fileName}
      aria-label={`Baixar ${item.fileName}`}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm font-medium text-accent-text hover:bg-accent-soft',
        className,
      )}
    >
      <Download className="h-4 w-4" aria-hidden /> Baixar
    </a>
  );
}

function StepCell({ session, item }: { session: TestSessionDto; item: TestDownloadDto }) {
  if (!item.stepId) return <span className="text-subtle">sem passo</span>;
  const index = session.definition.steps.findIndex((s) => s.id === item.stepId);
  if (index < 0) return <span className="text-subtle">Passo removido</span>;
  return (
    <Link
      to={{ search: '', hash: `#step-${item.stepId}` }}
      className="text-accent-text hover:underline"
    >
      {index + 1}. {stepTitle(session.definition, session.definition.steps[index]!)}
    </Link>
  );
}

function SourceCell({ item }: { item: TestDownloadDto }) {
  if (item.source === 'recording' || !item.runId) return <>{DOWNLOAD_SOURCE_LABELS.recording}</>;
  return (
    <Link
      to={{ search: '?tab=data', hash: `#run-${item.runId}` }}
      className="text-accent-text hover:underline"
    >
      {DOWNLOAD_SOURCE_LABELS.replay}
      {item.runSeq ? ` #${item.runSeq}` : ''}
    </Link>
  );
}

/**
 * Files the browser downloaded while recording or replaying: a history apart from the document,
 * each linked to the step (and run) that triggered it.
 */
export function DownloadsTab({ session }: { session: TestSessionDto }) {
  const busy = session.state !== 'idle';
  const { data, isLoading, error, refetch } = useTestDownloads(session.id, busy);
  const { run, busy: acting } = useSessionAction(session.id);
  const { hash } = useLocation();
  useScrollToHash(data !== undefined);
  // a file captured by the session poll appears without waiting for the list's own timer
  useEffect(() => {
    void refetch();
  }, [session.downloadCount, refetch]);

  if (isLoading) return <p className="text-sm text-muted">Carregando downloads…</p>;
  if (error) {
    return (
      <p role="alert" className="text-sm text-danger">
        Não foi possível carregar os downloads.
      </p>
    );
  }
  const items = data ?? [];
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Download className="h-6 w-6" />}
        title="Nenhum download ainda"
        description="Os arquivos baixados no navegador durante a gravação ou o replay aparecem aqui, ligados ao passo que os gerou. Eles ficam guardados no armazenamento e não fazem parte do documento."
      />
    );
  }
  return (
    <>
      <p className="mb-3 text-xs text-muted">
        Arquivos baixados durante a gravação e os replays. Não fazem parte do documento; exclua os
        que não precisar mais.
      </p>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Data/hora</th>
              <th className="px-3 py-2 font-medium">Arquivo</th>
              <th className="px-3 py-2 font-medium">Tamanho</th>
              <th className="px-3 py-2 font-medium">Origem</th>
              <th className="px-3 py-2 font-medium">Passo</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Ações</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr
                key={d.id}
                id={`download-${d.id}`}
                className={cn(
                  'scroll-mt-4 border-t border-border align-top',
                  hash === `#download-${d.id}` && 'bg-accent-soft/40',
                )}
              >
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">
                  {formatTime(d.createdAt)}
                </td>
                <td className="max-w-64 px-3 py-2">
                  <span className="break-all font-medium">{d.fileName}</span>
                  {d.url && (
                    <span className="block truncate text-xs text-subtle" title={d.url}>
                      {d.url}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {d.size > 0 ? formatFileSize(d.size) : '—'}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <SourceCell item={d} />
                </td>
                <td className="px-3 py-2">
                  <StepCell session={session} item={d} />
                </td>
                <td className="px-3 py-2">
                  <Badge tone={STATUS_TONE[d.status]}>{DOWNLOAD_STATUS_LABELS[d.status]}</Badge>
                  {d.reason && <span className="mt-1 block text-xs text-muted">{d.reason}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <DownloadLink item={d} />
                  <ConfirmButton
                    label={`Excluir ${d.fileName}`}
                    confirmLabel="o arquivo será apagado do armazenamento. Confirmar?"
                    className={acting ? 'pointer-events-none opacity-50' : undefined}
                    onConfirm={() =>
                      void run(
                        'delete-download',
                        () => api.del(`/api/tests/sessions/${session.id}/downloads/${d.id}`),
                        'Download excluído',
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
