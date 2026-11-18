import { useQueryClient } from '@tanstack/react-query';
import {
  TEMPLATE_KIND_LABELS,
  TEMPLATE_KINDS,
  type ReportTemplateDto,
  type TemplateKind,
} from '@thinkflow/shared';
import { ArrowLeft, Copy, Lock, Save } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Button } from '../../components/ui/button';
import { Card, EmptyState, PageHeader } from '../../components/ui/card';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys, useReportTemplate } from '../../lib/queries';
import { StringListEditor } from './string-list-editor';
import {
  draftFromTemplate,
  emptyDraft,
  undeclaredVariables,
  validateDraft,
  type TemplateDraft,
} from './template-draft';
import { TemplateLayoutEditor } from './template-layout-editor';
import { TemplateResearchEditor } from './template-research-editor';
import { TemplateSectionsEditor } from './template-sections-editor';
import { TemplateVariablesEditor } from './template-variables-editor';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-0.5 mb-4 text-sm text-muted">{description}</p>}
      {!description && <div className="mb-4" />}
      {children}
    </Card>
  );
}

export function TemplateEditorPage() {
  const { id } = useParams();
  const location = useLocation();
  const { data: template, isLoading, error } = useReportTemplate(id);
  const state = location.state as { draft?: TemplateDraft; kind?: TemplateKind } | null;

  if (id) {
    if (isLoading) return <p className="p-8 text-sm text-muted">Carregando modelo…</p>;
    if (error || !template)
      return (
        <div className="mx-auto w-full max-w-3xl px-4 py-8">
          <EmptyState
            icon={<Lock className="h-6 w-6" />}
            title="Modelo não encontrado"
            description="Ele pode ter sido excluído."
            action={
              <Link to="/reports?tab=modelos">
                <Button variant="outline">Voltar aos modelos</Button>
              </Link>
            }
          />
        </div>
      );
    return (
      <TemplateEditor key={template.id} template={template} initial={draftFromTemplate(template)} />
    );
  }
  return (
    <TemplateEditor key="new" template={null} initial={state?.draft ?? emptyDraft(state?.kind)} />
  );
}

function TemplateEditor({
  template,
  initial,
}: {
  template: ReportTemplateDto | null;
  initial: TemplateDraft;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<TemplateDraft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const readOnly = template?.builtIn ?? false;
  const spec = draft.spec;
  const undeclared = useMemo(() => undeclaredVariables(spec), [spec]);

  const setSpec = (patch: Partial<TemplateDraft['spec']>) =>
    setDraft((d) => ({ ...d, spec: { ...d.spec, ...patch } }));

  const save = async () => {
    const result = validateDraft(draft);
    if (!result.ok) {
      setErrors(result.errors);
      setMessages(result.messages);
      notify.warning('Corrija os campos destacados antes de salvar.');
      return;
    }
    setErrors({});
    setMessages([]);
    setSaving(true);
    try {
      if (template)
        await api.put<ReportTemplateDto>(`/api/report-templates/${template.id}`, result.data);
      else await api.post<ReportTemplateDto>('/api/report-templates', result.data);
      await queryClient.invalidateQueries({ queryKey: keys.reportTemplates });
      notify.success('Modelo salvo');
      navigate('/reports?tab=modelos');
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async () => {
    if (!template) return;
    setSaving(true);
    try {
      const copy = await api.post<ReportTemplateDto>(
        `/api/report-templates/${template.id}/duplicate`,
      );
      await queryClient.invalidateQueries({ queryKey: keys.reportTemplates });
      notify.success('Cópia criada. Agora você pode editá-la.');
      navigate(`/reports/templates/${copy.id}`);
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
      <Link
        to="/reports?tab=modelos"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Modelos
      </Link>
      <PageHeader
        title={readOnly ? draft.name : template ? 'Editar modelo' : 'Novo modelo'}
        description={
          readOnly
            ? 'Modelo padrão do Thinkflow: somente leitura. Duplique para criar uma cópia editável.'
            : 'Defina o papel, a pesquisa, a estrutura e o visual dos documentos gerados a partir deste modelo.'
        }
        actions={
          readOnly ? (
            <Button onClick={() => void duplicate()} loading={saving}>
              <Copy className="h-4 w-4" /> Duplicar para editar
            </Button>
          ) : (
            <Button onClick={() => void save()} loading={saving}>
              <Save className="h-4 w-4" /> Salvar modelo
            </Button>
          )
        }
      />

      {messages.length > 0 && (
        <div role="alert" className="mb-4 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
          <p className="font-medium">Não foi possível salvar:</p>
          <ul className="mt-1 list-disc pl-5">
            {messages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        <legend className="sr-only">Campos do modelo</legend>

        <Section title="Identificação">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_200px]">
            <Field label="Nome do modelo" htmlFor="tpl-name" error={errors['name']}>
              <Input
                id="tpl-name"
                value={draft.name}
                aria-invalid={errors['name'] ? true : undefined}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="Ex.: Guia do Analista"
              />
            </Field>
            <Field label="Tipo" htmlFor="tpl-kind" error={errors['kind']}>
              <Select
                id="tpl-kind"
                value={draft.kind}
                onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as TemplateKind }))}
              >
                {TEMPLATE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {TEMPLATE_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Descrição"
              htmlFor="tpl-description"
              className="sm:col-span-2"
              error={errors['description']}
            >
              <Textarea
                id="tpl-description"
                rows={2}
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Papel e objetivo"
          description="Use {{variavel}} para inserir valores informados na hora de gerar."
        >
          <div className="flex flex-col gap-4">
            <Field label="Papel (persona)" htmlFor="tpl-persona" error={errors['spec.persona']}>
              <Textarea
                id="tpl-persona"
                rows={2}
                value={spec.persona}
                onChange={(e) => setSpec({ persona: e.target.value })}
                placeholder="Ex.: Arquiteto de Sistemas Especialista no sistema legado da sua organização"
              />
            </Field>
            <Field label="Objetivo" htmlFor="tpl-objective" error={errors['spec.objective']}>
              <Textarea
                id="tpl-objective"
                rows={3}
                value={spec.objective}
                onChange={(e) => setSpec({ objective: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Público" htmlFor="tpl-audience" error={errors['spec.audience']}>
                <Input
                  id="tpl-audience"
                  value={spec.audience}
                  onChange={(e) => setSpec({ audience: e.target.value })}
                />
              </Field>
              <Field
                label="Padrão do título"
                htmlFor="tpl-title"
                error={errors['spec.titlePattern']}
              >
                <Input
                  id="tpl-title"
                  value={spec.titlePattern}
                  onChange={(e) => setSpec({ titlePattern: e.target.value })}
                  placeholder="Ex.: Guia do Analista: {{funcao}}"
                />
              </Field>
            </div>
          </div>
        </Section>

        <Section title="Pesquisa" description="Como a IA busca informações antes de escrever.">
          <TemplateResearchEditor
            research={spec.research}
            onChange={(research) => setSpec({ research })}
            readOnly={readOnly}
          />
        </Section>

        <Section
          title="Estrutura"
          description="Seções do documento, na ordem em que serão escritas. Arraste ou use as setas para reordenar."
        >
          <TemplateSectionsEditor
            sections={spec.sections}
            onChange={(sections) => setSpec({ sections })}
            errors={errors}
            readOnly={readOnly}
          />
        </Section>

        <Section
          title="Variáveis"
          description="Valores informados por quem gera o documento (ex.: nome de uma função)."
        >
          <TemplateVariablesEditor
            variables={spec.variables}
            undeclared={undeclared}
            onChange={(variables) => setSpec({ variables })}
            errors={errors}
            readOnly={readOnly}
          />
        </Section>

        <Section
          title="Perguntas de escopo"
          description="Perguntas que a IA faz no chat antes de gerar o documento."
        >
          <StringListEditor
            label="Pergunta"
            items={spec.intakeQuestions}
            onChange={(intakeQuestions) => setSpec({ intakeQuestions })}
            placeholder="Ex.: Qual é o assunto exato da análise?"
            addLabel="Adicionar pergunta"
            max={10}
          />
        </Section>

        <Section title="Tom e regras">
          <div className="flex flex-col gap-4">
            <Field label="Tom" htmlFor="tpl-tone" error={errors['spec.style.tone']}>
              <Input
                id="tpl-tone"
                value={spec.style.tone}
                onChange={(e) => setSpec({ style: { ...spec.style, tone: e.target.value } })}
                placeholder="Ex.: Analítico e direto"
              />
            </Field>
            <Field label="Regras de escrita">
              <StringListEditor
                label="Regra"
                items={spec.style.rules}
                onChange={(rules) => setSpec({ style: { ...spec.style, rules } })}
                placeholder="Ex.: Quando algo não for encontrado, diga explicitamente"
                addLabel="Adicionar regra"
                max={30}
              />
            </Field>
          </div>
        </Section>

        <Section title="Visual" description="Identidade visual do documento gerado (HTML e PDF).">
          <TemplateLayoutEditor
            layout={spec.layout}
            onChange={(layout) => setSpec({ layout })}
            errors={errors}
            previewTitle={spec.titlePattern || draft.name}
            readOnly={readOnly}
          />
        </Section>
      </fieldset>

      {!readOnly && (
        <div className="mt-4 flex justify-end gap-2">
          <Link to="/reports?tab=modelos">
            <Button variant="ghost">Cancelar</Button>
          </Link>
          <Button onClick={() => void save()} loading={saving}>
            <Save className="h-4 w-4" /> Salvar modelo
          </Button>
        </div>
      )}
    </div>
  );
}
