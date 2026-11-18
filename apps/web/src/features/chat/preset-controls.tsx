import { TEMPLATE_KIND_LABELS, type ChatPreset } from '@thinkflow/shared';
import { FileText, Sparkles, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/form';
import { useReportTemplates } from '../../lib/queries';
import { rememberPresetTemplate } from './preset-memory';

/**
 * Document mode of the composer: the mode chip, the template select (names only) and the
 * "Gerar agora" button. The template text never leaves the server; only ids are sent.
 */
export function PresetControls({
  preset,
  onChange,
  canGenerate,
  generating,
  onGenerate,
}: {
  preset: ChatPreset;
  onChange(preset: ChatPreset | null): void;
  /** There is a conversation to read the answers from and no turn is running. */
  canGenerate: boolean;
  generating: boolean;
  onGenerate(): void;
}) {
  const { data } = useReportTemplates(preset.kind);
  const templates = Array.isArray(data) ? data : [];
  const label = TEMPLATE_KIND_LABELS[preset.kind];
  const known = templates.some((t) => t.id === preset.templateId);

  return (
    <>
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-label={`Sair do modo ${label}`}
        title={`Sair do modo ${label}`}
        className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent-text hover:brightness-95"
      >
        <FileText className="h-3.5 w-3.5" aria-hidden /> Modo: {label}
        <X className="h-3 w-3" aria-hidden />
      </button>

      <Select
        aria-label="Modelo de documento"
        value={known ? preset.templateId : ''}
        onChange={(e) => {
          if (!e.target.value) return;
          rememberPresetTemplate(preset.kind, e.target.value);
          onChange({ kind: preset.kind, templateId: e.target.value });
        }}
        title="Modelo que define as perguntas e a estrutura do documento"
        className="h-8 w-auto max-w-56 rounded-lg py-0 text-xs"
      >
        {!known && <option value="">Escolha um modelo…</option>}
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>

      <Button
        variant="secondary"
        size="sm"
        onClick={onGenerate}
        disabled={!canGenerate || !known}
        loading={generating}
        title={
          canGenerate
            ? 'Gerar o documento agora com o que foi conversado'
            : 'Converse com a IA primeiro: ela usa as respostas para preencher o modelo'
        }
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden /> Gerar agora
      </Button>
    </>
  );
}
