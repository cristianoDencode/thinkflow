import { useQueryClient } from '@tanstack/react-query';
import {
  REPORT_STATUS_LABELS,
  reportStatusSchema,
  TEMPLATE_KIND_LABELS,
  TEMPLATE_KINDS,
  type ReportDto,
  type ReportStatus,
  type TemplateKind,
} from '@thinkflow/shared';
import { Download, ExternalLink, FileText, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { Badge, Card, EmptyState } from '../../components/ui/card';
import { ConfirmButton } from '../../components/ui/dialog';
import { Select } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys, useReportRenderer, useReports } from '../../lib/queries';
import { timeAgo } from '../../lib/utils';
import { NewReportDialog } from './new-report-dialog';
import { ReportProgressBar, ReportStatusBadge } from './report-progress';
import { RendererNotice } from './renderer-notice';
import { StorageNotice } from './storage-notice';

function ReportRow({ report: r, pdfAvailable }: { report: ReportDto; pdfAvailable: boolean }) {
  const queryClient = useQueryClient();
  const remove = async () => {
    try {
      await api.del(`/api/reports/${r.id}`);
      await queryClient.invalidateQueries({ queryKey: keys.reports });
      notify.success('Relatório excluído');
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };
  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{TEMPLATE_KIND_LABELS[r.kind]}</Badge>
          <ReportStatusBadge status={r.status} />
          <span className="text-xs text-subtle">{timeAgo(r.createdAt)}</span>
        </div>
        <Link
          to={`/reports/${r.id}`}
          className="mt-1.5 block truncate font-medium hover:text-accent-text"
        >
          {r.title}
        </Link>
        <p className="truncate text-xs text-muted">{r.templateName}</p>
        <div className="mt-2 max-w-md">
          <ReportProgressBar report={r} />
        </div>
        {r.status === 'error' && r.error && (
          <p className="mt-1 line-clamp-2 text-xs text-danger">{r.error}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Link to={`/reports/${r.id}`} aria-label={`Abrir ${r.title}`}>
          <Button variant="ghost" size="sm" tabIndex={-1}>
            <ExternalLink className="h-4 w-4" /> Abrir
          </Button>
        </Link>
        {r.status === 'done' && r.kind !== 'prototype' && pdfAvailable && (
          <a
            href={`/api/reports/${r.id}/pdf`}
            download
            aria-label={`Baixar PDF de ${r.title}`}
            className="inline-flex"
          >
            <Button variant="ghost" size="sm" tabIndex={-1}>
              <Download className="h-4 w-4" /> PDF
            </Button>
          </a>
        )}
        <ConfirmButton label={`Excluir ${r.title}`} onConfirm={() => void remove()}>
          <Trash2 className="h-4 w-4" />
        </ConfirmButton>
      </div>
    </Card>
  );
}

export function ReportsList() {
  const [kind, setKind] = useState<TemplateKind | ''>('');
  const [status, setStatus] = useState<ReportStatus | ''>('');
  const [creating, setCreating] = useState(false);
  const {
    data: reports,
    isLoading,
    error,
  } = useReports({
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
  });
  const { data: renderer } = useReportRenderer();
  const filtered = Boolean(kind || status);

  return (
    <>
      <RendererNotice />
      <StorageNotice />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> Novo relatório
        </Button>
        <div className="ml-auto flex flex-wrap gap-2">
          <Select
            aria-label="Filtrar por tipo"
            className="h-9 w-auto"
            value={kind}
            onChange={(e) => setKind(e.target.value as TemplateKind | '')}
          >
            <option value="">Todos os tipos</option>
            {TEMPLATE_KINDS.map((k) => (
              <option key={k} value={k}>
                {TEMPLATE_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filtrar por status"
            className="h-9 w-auto"
            value={status}
            onChange={(e) => setStatus(e.target.value as ReportStatus | '')}
          >
            <option value="">Todos os status</option>
            {reportStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {REPORT_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted">Carregando relatórios…</p>
      ) : error ? (
        <p role="alert" className="text-sm text-danger">
          Não foi possível carregar os relatórios: {errorMessage(error)}
        </p>
      ) : !reports || reports.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-6 w-6" />}
          title={filtered ? 'Nenhum relatório com esses filtros' : 'Nenhum relatório gerado ainda'}
          description={
            filtered
              ? 'Ajuste ou limpe os filtros para ver outros relatórios.'
              : 'Escolha um modelo, informe o tema e deixe a IA pesquisar e escrever o documento em segundo plano.'
          }
          action={
            filtered ? undefined : (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> Novo relatório
              </Button>
            )
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {reports.map((r) => (
            <li key={r.id}>
              <ReportRow report={r} pdfAvailable={Boolean(r.hasPdf || renderer?.pdf)} />
            </li>
          ))}
        </ul>
      )}
      {creating && <NewReportDialog onClose={() => setCreating(false)} />}
    </>
  );
}
