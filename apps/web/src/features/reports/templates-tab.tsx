import { useQueryClient } from '@tanstack/react-query';
import {
  TEMPLATE_KIND_LABELS,
  TEMPLATE_KINDS,
  type ReportTemplateSummaryDto,
  type TemplateKind,
} from '@thinkflow/shared';
import { Copy, Eye, FileText, FileUp, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '../../components/ui/button';
import { Badge, Card, EmptyState } from '../../components/ui/card';
import { ConfirmButton } from '../../components/ui/dialog';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys, useReportTemplates } from '../../lib/queries';
import { timeAgo } from '../../lib/utils';
import { TemplateAssistDialog, type AssistMode } from './template-assist-dialog';

const KIND_DESCRIPTIONS: Record<TemplateKind, string> = {
  report: 'Documentos longos com pesquisa, seções, tabelas e diagramas.',
  summary: 'Sínteses curtas de um material.',
  prd: 'Requisitos de produto para uma funcionalidade.',
  prototype: 'Protótipos navegáveis de interface.',
};

function TemplateCard({ template: t }: { template: ReportTemplateSummaryDto }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const duplicate = async () => {
    setBusy(true);
    try {
      const copy = await api.post<{ id: string }>(`/api/report-templates/${t.id}/duplicate`);
      await queryClient.invalidateQueries({ queryKey: keys.reportTemplates });
      notify.success('Cópia criada');
      navigate(`/reports/templates/${copy.id}`);
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api.del(`/api/report-templates/${t.id}`);
      await queryClient.invalidateQueries({ queryKey: keys.reportTemplates });
      notify.success('Modelo excluído');
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <span
          className="mt-1 h-3 w-3 shrink-0 rounded-full border border-border"
          style={{ backgroundColor: t.primaryColor }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate font-medium">{t.name}</h3>
            {t.builtIn && <Badge tone="accent">Padrão</Badge>}
            {t.usesMcp && <Badge>Usa MCP</Badge>}
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted">{t.description || 'Sem descrição'}</p>
          <p className="mt-2 text-xs text-subtle">
            {t.sectionCount} {t.sectionCount === 1 ? 'seção' : 'seções'} · {t.variableCount}{' '}
            {t.variableCount === 1 ? 'variável' : 'variáveis'}
            {!t.builtIn && ` · atualizado ${timeAgo(t.updatedAt)}`}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-border pt-2">
        {t.builtIn ? (
          <>
            <Link to={`/reports/templates/${t.id}`} aria-label={`Ver ${t.name}`}>
              <Button variant="ghost" size="sm" tabIndex={-1}>
                <Eye className="h-4 w-4" /> Ver
              </Button>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              loading={busy}
              onClick={() => void duplicate()}
              aria-label={`Duplicar para editar ${t.name}`}
            >
              <Copy className="h-4 w-4" /> Duplicar para editar
            </Button>
          </>
        ) : (
          <>
            <Link to={`/reports/templates/${t.id}`} aria-label={`Editar ${t.name}`}>
              <Button variant="ghost" size="sm" tabIndex={-1}>
                <Pencil className="h-4 w-4" /> Editar
              </Button>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              loading={busy}
              onClick={() => void duplicate()}
              aria-label={`Duplicar ${t.name}`}
            >
              <Copy className="h-4 w-4" /> Duplicar
            </Button>
            <ConfirmButton
              label={`Excluir ${t.name}`}
              className="ml-auto"
              onConfirm={() => void remove()}
            >
              <Trash2 className="h-4 w-4" />
            </ConfirmButton>
          </>
        )}
      </div>
    </Card>
  );
}

function AssistButtons() {
  const [mode, setMode] = useState<AssistMode | null>(null);
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => setMode('interview')}>
        <Sparkles className="h-4 w-4" /> Criar com IA
      </Button>
      <Button variant="outline" size="sm" onClick={() => setMode('import')}>
        <FileUp className="h-4 w-4" /> Importar de prompt
      </Button>
      {mode && <TemplateAssistDialog mode={mode} onClose={() => setMode(null)} />}
    </div>
  );
}

export function TemplatesTab() {
  return (
    <>
      <AssistButtons />
      <TemplatesList />
    </>
  );
}

function TemplatesList() {
  const { data: templates, isLoading, error } = useReportTemplates();

  if (isLoading) return <p className="text-sm text-muted">Carregando modelos…</p>;
  if (error)
    return (
      <p role="alert" className="text-sm text-danger">
        Não foi possível carregar os modelos: {errorMessage(error)}
      </p>
    );
  if (!templates || templates.length === 0)
    return (
      <EmptyState
        icon={<FileText className="h-6 w-6" />}
        title="Nenhum modelo"
        description="Modelos definem a estrutura, a pesquisa e o visual dos documentos gerados pela IA."
        action={
          <Link to="/reports/templates/new">
            <Button>
              <Plus className="h-4 w-4" /> Novo modelo
            </Button>
          </Link>
        }
      />
    );

  return (
    <div className="flex flex-col gap-8">
      {TEMPLATE_KINDS.map((kind) => {
        const group = templates.filter((t) => t.kind === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind} aria-labelledby={`kind-${kind}`}>
            <h2 id={`kind-${kind}`} className="text-lg font-semibold">
              {TEMPLATE_KIND_LABELS[kind]}
            </h2>
            <p className="mb-3 text-sm text-muted">{KIND_DESCRIPTIONS[kind]}</p>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {group.map((t) => (
                <TemplateCard key={t.id} template={t} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
