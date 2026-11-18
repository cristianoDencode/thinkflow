import { REPORT_STATUS_LABELS, TEMPLATE_KIND_LABELS, type TemplateKind } from '@thinkflow/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, Download, ExternalLink, FileText, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { isReportActive, keys, useReport } from '../../lib/queries';
import { ReportProgressBar, ReportStatusBadge } from '../reports/report-progress';

/**
 * Progress/result card of a document started from the chat (decision 6: only a card with a link,
 * never the full document as a message). Polls the report while the job runs.
 */
export function ReportJobCard({
  report,
}: {
  report: { id: string; title: string; kind: TemplateKind };
}) {
  const { data, isError, error } = useReport(report.id);
  const queryClient = useQueryClient();
  const [canceling, setCanceling] = useState(false);

  const status = data?.status;
  const active = isReportActive(status);
  const prototype = (data?.kind ?? report.kind) === 'prototype';

  const cancel = async () => {
    setCanceling(true);
    try {
      await api.post(`/api/reports/${report.id}/cancel`);
      await queryClient.invalidateQueries({ queryKey: keys.reports });
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setCanceling(false);
    }
  };

  return (
    <section
      className="mt-3 rounded-xl border border-border bg-surface px-4 py-3"
      aria-label={`${TEMPLATE_KIND_LABELS[report.kind]} em geração`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="h-4 w-4 shrink-0 text-accent-text" aria-hidden />
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          title={data?.title ?? report.title}
        >
          {data?.title ?? report.title}
        </span>
        {status && <ReportStatusBadge status={status} />}
      </div>

      {isError && !data && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-danger" role="alert">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {/não encontrad/i.test(errorMessage(error))
            ? 'Este documento foi excluído.'
            : 'Não foi possível consultar o andamento.'}
        </p>
      )}

      {data && active && (
        <div className="mt-2">
          <ReportProgressBar report={data} />
        </div>
      )}
      {data?.status === 'error' && data.error && (
        <p className="mt-2 text-xs text-danger" role="alert">
          {data.error}
        </p>
      )}
      {data?.status === 'canceled' && (
        <p className="mt-2 text-xs text-muted">
          {REPORT_STATUS_LABELS.canceled}. Retome em Relatórios.
        </p>
      )}

      {(data || !isError) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Link
            to={`/reports/${report.id}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-accent px-3 text-xs font-medium text-accent-fg hover:bg-accent-hover"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Abrir
          </Link>
          {active && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void cancel()}
              loading={canceling}
              disabled={data?.cancelRequested}
            >
              <Ban className="h-3.5 w-3.5" aria-hidden />
              {data?.cancelRequested ? 'Cancelando…' : 'Cancelar'}
            </Button>
          )}
          {status === 'done' && (
            <a
              href={
                prototype
                  ? `/api/reports/${report.id}/html?download=1`
                  : `/api/reports/${report.id}/pdf`
              }
              download
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-border bg-surface-2 px-3 text-xs font-medium hover:bg-surface-hover"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              {prototype ? 'Baixar HTML' : 'Baixar PDF'}
            </a>
          )}
        </div>
      )}
    </section>
  );
}
