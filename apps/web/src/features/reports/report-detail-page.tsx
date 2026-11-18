import { useQueryClient } from '@tanstack/react-query';
import {
  TEMPLATE_KIND_LABELS,
  type ReportDetailDto,
  type ReportSectionDto,
} from '@thinkflow/shared';
import {
  ArrowLeft,
  Ban,
  BookPlus,
  Check,
  Download,
  FileCode,
  FileText,
  Pencil,
  Play,
  Printer,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button } from '../../components/ui/button';
import { Badge, Card } from '../../components/ui/card';
import { ConfirmButton } from '../../components/ui/dialog';
import { Input } from '../../components/ui/form';
import { api, ApiError, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { isReportActive, keys, useReport, useReportRenderer } from '../../lib/queries';
import { formatTime, timeAgo } from '../../lib/utils';
import { DiagramContext } from '../chat/diagram-context';
import { Markdown } from '../chat/markdown';
import { AddToLibraryDialog, RegenerateSectionDialog } from './report-dialogs';
import { ReportProgressBar, ReportStatusBadge } from './report-progress';

async function downloadFile(url: string, fallbackName: string): Promise<void> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    let message = `Erro ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(message, response.status);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? fallbackName;
  const href = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function Title({ report }: { report: ReportDetailDto }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(report.title);

  const save = async () => {
    const title = draft.trim();
    if (!title || title === report.title) return setEditing(false);
    try {
      await api.patch(`/api/reports/${report.id}`, { title });
      await queryClient.invalidateQueries({ queryKey: keys.reports });
      setEditing(false);
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  if (editing)
    return (
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input
          aria-label="Título do relatório"
          value={draft}
          maxLength={300}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" size="icon-sm" aria-label="Salvar título">
          <Check className="h-4 w-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Cancelar edição"
          onClick={() => setEditing(false)}
        >
          <X className="h-4 w-4" />
        </Button>
      </form>
    );
  return (
    <div className="flex min-w-0 items-start gap-2">
      <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight">{report.title}</h1>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Renomear relatório"
        onClick={() => {
          setDraft(report.title);
          setEditing(true);
        }}
      >
        <Pencil className="h-4 w-4" />
      </Button>
    </div>
  );
}

function SectionView({
  report,
  section,
  index,
  onRegenerate,
}: {
  report: ReportDetailDto;
  section: ReportSectionDto;
  index: number;
  onRegenerate(): void;
}) {
  const canRegenerate = section.status === 'done' && !isReportActive(report.status);
  return (
    <section
      id={`sec-${section.ordinal}`}
      className="scroll-mt-20"
      aria-labelledby={`h-${section.ordinal}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={`h-${section.ordinal}`} className="text-lg font-semibold">
          {index + 1}. {section.title}
        </h2>
        {canRegenerate && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRegenerate}
            aria-label={`Regenerar a seção ${section.title}`}
          >
            <RefreshCw className="h-4 w-4" /> Regenerar
          </Button>
        )}
      </div>
      {section.status === 'done' ? (
        <Markdown content={section.markdown} />
      ) : section.status === 'error' ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          Não foi possível escrever esta seção{section.error ? `: ${section.error}` : '.'}
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted">
          {section.status === 'writing' ? 'Escrevendo…' : 'Aguardando…'}
        </p>
      )}
      {section.warnings.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {section.warnings.map((w, i) => (
            <li key={i}>
              <Badge tone="warning" className="whitespace-normal text-left">
                {w}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AboutCard({ report }: { report: ReportDetailDto }) {
  const { meta } = report;
  return (
    <Card className="p-4 text-sm">
      <h2 className="font-semibold">Sobre este documento</h2>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Modelo de documento</dt>
        <dd>{report.templateName}</dd>
        <dt className="text-muted">Modelo de IA</dt>
        <dd>{meta.models.length > 0 ? meta.models.join(', ') : report.model}</dd>
        <dt className="text-muted">Gerado em</dt>
        <dd>{meta.generatedAt ? formatTime(meta.generatedAt) : '—'}</dd>
        <dt className="text-muted">Fontes</dt>
        <dd>
          {meta.sources.length > 0
            ? meta.sources.map((s) => `${s.name} (${s.calls})`).join(', ')
            : 'Nenhuma fonte externa consultada'}
        </dd>
        {meta.diagrams.total > 0 && (
          <>
            <dt className="text-muted">Diagramas</dt>
            <dd>
              {meta.diagrams.total} no total
              {meta.diagrams.repaired > 0 && `, ${meta.diagrams.repaired} corrigidos`}
              {meta.diagrams.failed > 0 && `, ${meta.diagrams.failed} com falha`}
            </dd>
          </>
        )}
      </dl>
      {meta.limits.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-muted">
          {meta.limits.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {meta.warnings.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-warning">
          {meta.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ReportDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: report, isLoading, error } = useReport(id);
  const { data: renderer } = useReportRenderer();
  const [regenerating, setRegenerating] = useState<ReportSectionDto | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const diagramContext = useMemo(() => ({ model: report?.model }), [report?.model]);

  if (isLoading) return <p className="p-8 text-sm text-muted">Carregando relatório…</p>;
  if (error || !report)
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <p role="alert" className="text-sm text-danger">
          Não foi possível carregar o relatório{error ? `: ${errorMessage(error)}` : '.'}
        </p>
        <Link to="/reports" className="mt-3 inline-block text-sm text-accent-text underline">
          Voltar para Relatórios
        </Link>
      </div>
    );

  const active = isReportActive(report.status);
  const done = report.status === 'done';
  const prototype = report.kind === 'prototype';
  // no /renderer route (older server): only the Markdown download and the in-page viewer
  const noRenderer = renderer === null;
  const pdfReady = report.hasPdf || renderer?.pdf !== false;
  const pdfReason = renderer?.reason ?? 'O Chromium não está disponível neste servidor.';

  const act = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: keys.reports });
      if (success) notify.success(success);
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const download = (key: string, url: string, name: string) =>
    act(key, () => downloadFile(url, name));

  const remove = () =>
    act('delete', async () => {
      await api.del(`/api/reports/${report.id}`);
      navigate('/reports');
    });

  const toc = report.sections;
  const showSections = toc.length > 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <Link
        to="/reports"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" /> Relatórios
      </Link>

      <div className="mb-4 flex flex-col gap-2">
        <Title key={report.title} report={report} />
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <Badge>{TEMPLATE_KIND_LABELS[report.kind]}</Badge>
          <ReportStatusBadge status={report.status} />
          <span>{report.templateName}</span>
          <span aria-hidden>·</span>
          <span>{timeAgo(report.createdAt)}</span>
        </div>
        {report.storage === 'pending' && (
          <p role="status" className="text-xs text-muted">
            Documento salvo localmente; será enviado ao armazenamento assim que ele voltar.
          </p>
        )}
        {active && (
          <div className="max-w-xl">
            <ReportProgressBar report={report} />
          </div>
        )}
      </div>

      {report.status === 'error' && (
        <div role="alert" className="mb-4 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
          A geração falhou{report.error ? `: ${report.error}` : '.'} Você pode retomar de onde
          parou.
        </div>
      )}
      {report.status === 'canceled' && (
        <div
          role="status"
          className="mb-4 rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning"
        >
          A geração foi cancelada. Você pode retomá-la.
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-2">
        {active && (
          <Button
            variant="outline"
            size="sm"
            disabled={report.cancelRequested}
            loading={busy === 'cancel'}
            onClick={() =>
              void act('cancel', () => api.post(`/api/reports/${report.id}/cancel`), 'Cancelando…')
            }
          >
            <Ban className="h-4 w-4" /> {report.cancelRequested ? 'Cancelando…' : 'Cancelar'}
          </Button>
        )}
        {(report.status === 'error' || report.status === 'canceled') && (
          <Button
            size="sm"
            loading={busy === 'retry'}
            onClick={() =>
              void act('retry', () => api.post(`/api/reports/${report.id}/retry`), 'Retomando…')
            }
          >
            <Play className="h-4 w-4" /> Retomar
          </Button>
        )}
        {done && (
          <>
            {!prototype && !noRenderer && (
              <Button
                variant="outline"
                size="sm"
                loading={busy === 'pdf'}
                disabled={!pdfReady}
                title={pdfReady ? undefined : pdfReason}
                onClick={() =>
                  void download('pdf', `/api/reports/${report.id}/pdf`, 'relatorio.pdf')
                }
              >
                <Download className="h-4 w-4" /> Baixar PDF
              </Button>
            )}
            {!noRenderer && report.hasHtml && (
              <Button
                variant="outline"
                size="sm"
                loading={busy === 'html'}
                onClick={() =>
                  void download(
                    'html',
                    `/api/reports/${report.id}/html?download=1`,
                    'relatorio.html',
                  )
                }
              >
                <FileCode className="h-4 w-4" /> HTML
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              loading={busy === 'md'}
              onClick={() =>
                void download('md', `/api/reports/${report.id}/markdown`, 'relatorio.md')
              }
            >
              <FileText className="h-4 w-4" /> Markdown
            </Button>
            {!noRenderer && report.hasHtml && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(`/api/reports/${report.id}/html`, '_blank', 'noopener')}
              >
                <Printer className="h-4 w-4" /> Imprimir
              </Button>
            )}
            {!noRenderer && (
              <Button variant="outline" size="sm" onClick={() => setLibraryOpen(true)}>
                <BookPlus className="h-4 w-4" /> Adicionar à Biblioteca
              </Button>
            )}
          </>
        )}
        <ConfirmButton
          label="Excluir relatório"
          className="ml-auto"
          onConfirm={() => void remove()}
        >
          <Trash2 className="h-4 w-4" />
        </ConfirmButton>
      </div>
      {done && !prototype && !noRenderer && !pdfReady && (
        <p role="note" className="-mt-3 mb-4 text-xs text-muted">
          PDF indisponível: {pdfReason}
        </p>
      )}

      {done && prototype && report.hasHtml && !noRenderer && (
        <div className="mb-6">
          <h2 className="mb-2 text-lg font-semibold">Protótipo</h2>
          <iframe
            sandbox=""
            src={`/api/reports/${report.id}/html`}
            title="Protótipo"
            className="h-[70vh] w-full rounded-2xl border border-border bg-white"
          />
          <a
            href={`/api/reports/${report.id}/html`}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 inline-block text-sm text-accent-text underline"
          >
            Abrir protótipo em nova aba
          </a>
        </div>
      )}

      {showSections ? (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[14rem_1fr]">
          <nav aria-label="Seções" className="lg:sticky lg:top-6 lg:self-start">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">Seções</p>
            <ol className="flex flex-col gap-1 text-sm">
              {toc.map((s, i) => (
                <li key={s.ordinal}>
                  <a
                    href={`#sec-${s.ordinal}`}
                    className="block truncate rounded-lg px-2 py-1 text-muted hover:bg-surface-hover hover:text-fg"
                  >
                    {i + 1}. {s.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <DiagramContext.Provider value={diagramContext}>
            <div className="flex min-w-0 flex-col gap-8">
              {toc.map((s, i) => (
                <SectionView
                  key={s.ordinal}
                  report={report}
                  section={s}
                  index={i}
                  onRegenerate={() => setRegenerating(s)}
                />
              ))}
              {done && <AboutCard report={report} />}
            </div>
          </DiagramContext.Provider>
        </div>
      ) : (
        !active && (
          <p className="text-sm text-muted">Este relatório ainda não tem conteúdo gerado.</p>
        )
      )}

      {regenerating && (
        <RegenerateSectionDialog
          report={report}
          section={regenerating}
          onClose={() => setRegenerating(null)}
        />
      )}
      {libraryOpen && <AddToLibraryDialog report={report} onClose={() => setLibraryOpen(false)} />}
    </div>
  );
}
