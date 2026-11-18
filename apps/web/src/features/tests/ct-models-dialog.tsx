import { useQueryClient } from '@tanstack/react-query';
import {
  CT_LAYOUT_ASSIST_LIMITS,
  ctModelInputSchema,
  type CtLayoutAssistResultDto,
  type CtModelDto,
} from '@thinkflow/shared';
import { Copy, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys, useModelOptions } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { CtLayoutForm, CtLayoutPreview } from './ct-model-editor';
import {
  CT_MODELS_URL,
  ctModelsKey,
  draftOf,
  newDraft,
  useCtModels,
  type CtModelDraft,
} from './ct-models';

function AiBox({ draft, onDraft }: { draft: CtModelDraft | null; onDraft(d: CtModelDraft): void }) {
  const { data: options = [] } = useModelOptions();
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  // refine the look being edited (the logo is kept; it is never sent to the AI)
  const refining = draft !== null && !draft.builtIn;

  const generate = async () => {
    setBusy(true);
    try {
      const result = await api.post<CtLayoutAssistResultDto>(`${CT_MODELS_URL}/assist`, {
        prompt,
        ...(refining ? { layout: draft.layout } : {}),
        ...(model ? { model } : {}),
      });
      const next = newDraft(result.name, result.layout);
      onDraft({
        ...next,
        ...(refining && draft.id ? { id: draft.id, name: draft.name } : {}),
        note: `${result.explanation} Revise e clique em Salvar.`,
      });
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-3">
      <Field
        label="Criar modelo com IA"
        htmlFor="ct-ai-prompt"
        hint="Descreva o visual (cores, fonte, textos do cabeçalho e rodapé). A IA não altera as seções e os campos do documento, nem cria a logo."
      >
        <Textarea
          id="ct-ai-prompt"
          rows={3}
          value={prompt}
          maxLength={CT_LAYOUT_ASSIST_LIMITS.maxPromptChars}
          placeholder="Ex.: visual sóbrio em tons de verde, fonte com serifa e rodapé 'Documento interno'"
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Modelo de IA" htmlFor="ct-ai-model" className="min-w-48 flex-1">
          <Select id="ct-ai-model" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Automático</option>
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          variant="soft"
          loading={busy}
          disabled={prompt.trim().length < 3}
          onClick={() => void generate()}
        >
          <Sparkles className="h-4 w-4" /> {refining ? 'Refinar com IA' : 'Gerar modelo'}
        </Button>
      </div>
    </div>
  );
}

/** "Modelos" of the CT document: list, create, edit, duplicate, delete and "Criar com IA". */
export function CtModelsDialog({
  open,
  onClose,
  currentId,
}: {
  open: boolean;
  onClose(): void;
  /** Model of the session (marked in the list). */
  currentId: string;
}) {
  const queryClient = useQueryClient();
  const { models } = useCtModels();
  const [draft, setDraft] = useState<CtModelDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ctModelsKey });
  const parsed = draft
    ? ctModelInputSchema.safeParse({ name: draft.name, layout: draft.layout })
    : null;

  const save = async () => {
    if (!draft || !parsed) return;
    if (!parsed.success) {
      notify.warning(parsed.error.issues[0]?.message ?? 'Confira os campos do modelo.');
      return;
    }
    setBusy('save');
    try {
      const saved = draft.id
        ? await api.put<CtModelDto>(`${CT_MODELS_URL}/${draft.id}`, parsed.data)
        : await api.post<CtModelDto>(CT_MODELS_URL, parsed.data);
      await refresh();
      // the document that uses this model shows the new look
      await queryClient.invalidateQueries({ queryKey: keys.tests });
      setDraft(draftOf(saved));
      notify.success('Modelo salvo');
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const duplicate = () => {
    if (!draft) return;
    setDraft({ ...newDraft(`${draft.name} (cópia)`, draft.layout) });
  };

  const remove = async () => {
    if (!draft?.id || draft.builtIn) return;
    if (
      !window.confirm(
        `Excluir o modelo "${draft.name}"? Os documentos que o usam voltam ao Padrão.`,
      )
    )
      return;
    setBusy('delete');
    try {
      await api.del(`${CT_MODELS_URL}/${draft.id}`);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: keys.tests });
      setDraft(null);
      notify.success('Modelo excluído');
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="Modelos do documento"
      description="Um modelo define só o visual do Caso de Teste (título, cabeçalho, rodapé, cores, fonte e logo). As seções e os campos do documento são sempre os mesmos."
    >
      <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <Button variant="secondary" size="sm" onClick={() => setDraft(newDraft())}>
            <Plus className="h-4 w-4" /> Novo modelo
          </Button>
          <ul aria-label="Modelos" className="flex flex-col gap-1">
            {models.map((model) => (
              <li key={model.id}>
                <button
                  type="button"
                  onClick={() => setDraft(draftOf(model))}
                  aria-current={draft?.id === model.id}
                  className={cn(
                    'flex w-full flex-col rounded-lg border px-3 py-2 text-left text-sm hover:bg-surface-hover',
                    draft?.id === model.id ? 'border-accent bg-accent/10' : 'border-border',
                  )}
                >
                  <span className="font-medium">{model.name}</span>
                  <span className="text-xs text-muted">
                    {model.builtIn ? 'Padrão (somente leitura)' : 'Personalizado'}
                    {model.id === currentId ? ' · em uso' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <AiBox draft={draft} onDraft={setDraft} />
          {draft ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="flex flex-col gap-4">
                {draft.note && (
                  <p role="status" className="text-sm text-muted">
                    {draft.note}
                  </p>
                )}
                {draft.builtIn && (
                  <p role="status" className="text-sm text-muted">
                    O modelo Padrão não pode ser alterado. Duplique-o para personalizar.
                  </p>
                )}
                <Field label="Nome do modelo" htmlFor="ct-model-name">
                  <Input
                    id="ct-model-name"
                    value={draft.name}
                    disabled={draft.builtIn}
                    maxLength={80}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </Field>
                <CtLayoutForm
                  layout={draft.layout}
                  readOnly={draft.builtIn}
                  onChange={(layout) => setDraft({ ...draft, layout })}
                />
                <div className="flex flex-wrap gap-2">
                  {!draft.builtIn && (
                    <Button loading={busy === 'save'} onClick={() => void save()}>
                      <Save className="h-4 w-4" /> Salvar modelo
                    </Button>
                  )}
                  <Button variant="secondary" onClick={duplicate}>
                    <Copy className="h-4 w-4" /> Duplicar
                  </Button>
                  {draft.id && !draft.builtIn && (
                    <Button
                      variant="danger"
                      loading={busy === 'delete'}
                      onClick={() => void remove()}
                    >
                      <Trash2 className="h-4 w-4" /> Excluir
                    </Button>
                  )}
                </div>
              </div>
              <CtLayoutPreview layout={draft.layout} />
            </div>
          ) : (
            <p className="text-sm text-muted">
              Escolha um modelo na lista, crie um novo ou descreva o visual para a IA propor um.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
