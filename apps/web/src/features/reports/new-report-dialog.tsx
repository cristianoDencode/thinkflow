import { useQueryClient } from '@tanstack/react-query';
import {
  TEMPLATE_KIND_LABELS,
  TEMPLATE_KINDS,
  type ReportDto,
  type TemplateKind,
} from '@thinkflow/shared';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '../../components/ui/form';
import { api, ApiError, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import {
  keys,
  useLibraries,
  useModelOptions,
  useReportSettings,
  useReportTemplate,
  useReportTemplates,
} from '../../lib/queries';

export function NewReportDialog({
  onClose,
  initialKind = 'report',
}: {
  onClose(): void;
  initialKind?: TemplateKind;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: allTemplates = [] } = useReportTemplates();
  const { data: models = [] } = useModelOptions();
  const { data: libraries = [] } = useLibraries();
  const { data: settings } = useReportSettings();

  const [kind, setKind] = useState<TemplateKind>(initialKind);
  const [templateChoice, setTemplateChoice] = useState('');
  const kindTemplates = allTemplates.filter((t) => t.kind === kind);
  const templateId = kindTemplates.some((t) => t.id === templateChoice)
    ? templateChoice
    : (kindTemplates[0]?.id ?? '');
  const { data: template } = useReportTemplate(templateId || undefined);

  const [modelChoice, setModelChoice] = useState('');
  const model =
    modelChoice ||
    (settings?.defaultModel && models.some((m) => m.id === settings.defaultModel)
      ? settings.defaultModel
      : (models[0]?.id ?? ''));
  const [values, setValues] = useState<Record<string, string>>({});
  const [brief, setBrief] = useState('');
  const [libraryId, setLibraryId] = useState('');
  const [mcpChoice, setMcpChoice] = useState<boolean | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // a new template resets the variable values (defaults applied) and the MCP choice
  useEffect(() => {
    if (!template) return;
    setValues(Object.fromEntries(template.spec.variables.map((v) => [v.name, v.defaultValue])));
    setMcpChoice(null);
    setErrors({});
  }, [template]);

  const research = template?.spec.research;
  const useMcp = mcpChoice ?? research?.useMcp ?? false;

  const submit = async () => {
    if (!template || !templateId) return;
    const missing: Record<string, string> = {};
    for (const v of template.spec.variables)
      if (v.required && !(values[v.name] ?? '').trim()) missing[v.name] = 'Campo obrigatório';
    setErrors(missing);
    if (Object.keys(missing).length > 0) return;
    setBusy(true);
    try {
      const report = await api.post<ReportDto>('/api/reports', {
        templateId,
        model,
        variables: values,
        brief,
        ...(libraryId ? { libraryId } : {}),
        useMcp,
      });
      await queryClient.invalidateQueries({ queryKey: keys.reports });
      notify.success('Geração iniciada');
      onClose();
      navigate(`/reports/${report.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'report_missing_variables')
        notify.warning(err.message);
      else notify.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title="Novo relatório"
      description="A geração roda em segundo plano; você pode sair da página e voltar depois."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={busy} disabled={!template || !model} onClick={() => void submit()}>
            Gerar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Tipo de documento" htmlFor="nr-kind">
            <Select
              id="nr-kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as TemplateKind);
                setTemplateChoice('');
              }}
            >
              {TEMPLATE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TEMPLATE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Modelo de documento" htmlFor="nr-template">
            <Select
              id="nr-template"
              value={templateId}
              onChange={(e) => setTemplateChoice(e.target.value)}
            >
              {kindTemplates.length === 0 && <option value="">Nenhum modelo deste tipo</option>}
              {kindTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {template?.description && <p className="text-sm text-muted">{template.description}</p>}

        {template?.spec.variables.map((v) => (
          <Field
            key={v.name}
            label={v.required ? `${v.label} *` : v.label}
            htmlFor={`nr-var-${v.name}`}
            hint={v.description || undefined}
            error={errors[v.name]}
          >
            <Input
              id={`nr-var-${v.name}`}
              value={values[v.name] ?? ''}
              placeholder={v.example}
              aria-required={v.required}
              onChange={(e) => setValues((cur) => ({ ...cur, [v.name]: e.target.value }))}
            />
          </Field>
        ))}

        <Field
          label="Instruções adicionais"
          htmlFor="nr-brief"
          hint="Escopo, foco, público, restrições. Opcional."
        >
          <Textarea
            id="nr-brief"
            rows={4}
            value={brief}
            maxLength={8000}
            onChange={(e) => setBrief(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Modelo de IA" htmlFor="nr-model">
            <Select id="nr-model" value={model} onChange={(e) => setModelChoice(e.target.value)}>
              {models.length === 0 && <option value="">Nenhum modelo disponível</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Biblioteca"
            htmlFor="nr-library"
            hint={
              research && !research.useLibrary
                ? 'Este modelo não consulta a Biblioteca.'
                : 'Fonte consultada na pesquisa. Opcional.'
            }
          >
            <Select
              id="nr-library"
              value={libraryId}
              disabled={research ? !research.useLibrary : false}
              onChange={(e) => setLibraryId(e.target.value)}
            >
              <option value="">Nenhuma</option>
              {libraries.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Pesquisar com ferramentas MCP</span>
            <Switch
              checked={useMcp}
              onChange={setMcpChoice}
              label="Pesquisar com ferramentas MCP"
            />
          </div>
          {useMcp && (
            <p role="note" className="flex items-start gap-2 text-xs text-warning">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                A pesquisa roda sem supervisão e pode chamar qualquer ferramenta dos servidores MCP
                selecionados no modelo
                {research && research.mcpServers.length > 0
                  ? ` (${research.mcpServers.join(', ')})`
                  : ' (todos os servidores ativos)'}
                .
              </span>
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
