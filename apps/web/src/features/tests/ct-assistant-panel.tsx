import { useMutation } from '@tanstack/react-query';
import {
  CT_ASSISTANT_LIMITS,
  type CtAssistantAction,
  type CtAssistantDocument,
  type CtAssistantPatch,
  type CtAssistantRequest,
  type CtAssistantResultDto,
} from '@thinkflow/shared';
import { Check, ChevronDown, Sparkles, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Select, Textarea } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { useLibraries, useMcpServers, useModelOptions } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { wordDiff, type DiffPart } from './ct-assistant-diff';

export interface CtAssistantPanelProps {
  sessionId: string;
  /** The document being edited (a full `CtDocument` fits; only the text parts are read/sent). */
  document: CtAssistantDocument;
  /**
   * Called with a patch that holds ONLY what the user accepted (one field, or everything not
   * applied yet). Merge it into the document: `title`, `analysisTitle`, `context` replace the
   * field; `useCases[].items[]` replace `useCases[index].items[index].text`.
   */
  onApply(patch: CtAssistantPatch): void;
  className?: string;
}

const QUICK_ACTIONS: {
  action: Exclude<CtAssistantAction, 'custom'>;
  label: string;
  hint: string;
}[] = [
  {
    action: 'review',
    label: 'Revisar escrita',
    hint: 'Gramática e clareza, mantendo os termos técnicos',
  },
  {
    action: 'improve_context',
    label: 'Melhorar contexto',
    hint: 'Reescreve o 2.1 Contexto de forma clara e objetiva',
  },
  {
    action: 'describe_use_cases',
    label: 'Descrever os casos de uso',
    hint: 'Narrativa formal no estilo da equipe',
  },
  { action: 'suggest_title', label: 'Sugerir título', hint: 'Título curto e específico' },
];

type ScopeValue = 'document' | 'context' | `useCase:${number}`;

/** Only the text the assistant works with: images are reduced to a marker before leaving the browser. */
function toRequestDocument(doc: CtAssistantDocument): CtAssistantDocument {
  return {
    title: doc.title,
    analysisTitle: doc.analysisTitle,
    context: doc.context,
    useCases: doc.useCases.map((useCase) => ({
      ...(useCase.title !== undefined ? { title: useCase.title } : {}),
      items: useCase.items.map((item) =>
        item.kind === 'image' ? { kind: 'image' as const } : { kind: item.kind, text: item.text },
      ),
    })),
  };
}

function toScope(value: ScopeValue): CtAssistantRequest['scope'] {
  if (value === 'document' || value === 'context') return { kind: value };
  return { kind: 'useCase', index: Number(value.split(':')[1]) };
}

/** One changed text field, with the value it had when the result arrived. */
interface FieldChange {
  key: string;
  label: string;
  before: string;
  after: string;
  patch: CtAssistantPatch;
}

function buildChanges(patch: CtAssistantPatch, base: CtAssistantDocument): FieldChange[] {
  const changes: FieldChange[] = [];
  if (patch.title !== undefined)
    changes.push({
      key: 'title',
      label: 'Título do documento',
      before: base.title,
      after: patch.title,
      patch: { title: patch.title },
    });
  if (patch.analysisTitle !== undefined)
    changes.push({
      key: 'analysisTitle',
      label: 'Título da seção 2',
      before: base.analysisTitle,
      after: patch.analysisTitle,
      patch: { analysisTitle: patch.analysisTitle },
    });
  if (patch.context !== undefined)
    changes.push({
      key: 'context',
      label: '2.1 Contexto',
      before: base.context,
      after: patch.context,
      patch: { context: patch.context },
    });
  for (const useCase of patch.useCases ?? []) {
    const current = base.useCases[useCase.index];
    const name = current?.title?.trim() || `Caso de Uso ${useCase.index + 1}`;
    for (const item of useCase.items) {
      const old = current?.items[item.index];
      changes.push({
        key: `uc:${useCase.index}:${item.index}`,
        label: `${name} — item ${item.index + 1}`,
        before: old && old.kind !== 'image' ? old.text : '',
        after: item.text,
        patch: { useCases: [{ index: useCase.index, items: [item] }] },
      });
    }
  }
  return changes;
}

/** Merges several single-field patches into one (items of the same use case are grouped). */
export function mergePatches(patches: CtAssistantPatch[]): CtAssistantPatch {
  const out: CtAssistantPatch = {};
  const byCase = new Map<number, { index: number; text: string }[]>();
  for (const p of patches) {
    if (p.title !== undefined) out.title = p.title;
    if (p.analysisTitle !== undefined) out.analysisTitle = p.analysisTitle;
    if (p.context !== undefined) out.context = p.context;
    for (const u of p.useCases ?? [])
      byCase.set(u.index, [...(byCase.get(u.index) ?? []), ...u.items]);
  }
  if (byCase.size > 0) out.useCases = [...byCase].map(([index, items]) => ({ index, items }));
  return out;
}

function Highlighted({ parts, kind }: { parts: DiffPart[]; kind: 'removed' | 'added' }) {
  return (
    <>
      {parts.map((part, i) =>
        part.kind === 'same' ? (
          <span key={i}>{part.text}</span>
        ) : (
          <mark
            key={i}
            data-diff={kind}
            className={cn(
              'rounded-sm px-0.5 text-fg',
              kind === 'added' ? 'bg-success-soft' : 'bg-danger-soft line-through',
            )}
          >
            {part.text}
          </mark>
        ),
      )}
    </>
  );
}

function DiffCard({
  change,
  applied,
  onApply,
}: {
  change: FieldChange;
  applied: boolean;
  onApply(): void;
}) {
  const diff = useMemo(() => wordDiff(change.before, change.after), [change.before, change.after]);
  return (
    <section
      aria-label={change.label}
      data-testid={`ct-change-${change.key}`}
      className="rounded-xl border border-border bg-bg-elevated p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-fg">{change.label}</h4>
        {applied ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <Check className="h-3.5 w-3.5" aria-hidden /> Aplicado
          </span>
        ) : (
          <Button
            size="sm"
            variant="soft"
            onClick={onApply}
            aria-label={`Aplicar: ${change.label}`}
          >
            Aplicar
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-medium text-muted">Antes</p>
          <p
            data-testid={`ct-before-${change.key}`}
            className="whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2 text-sm text-fg"
          >
            {change.before ? (
              <Highlighted parts={diff.before} kind="removed" />
            ) : (
              <em className="text-subtle">(vazio)</em>
            )}
          </p>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted">Depois</p>
          <p
            data-testid={`ct-after-${change.key}`}
            className="whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2 text-sm text-fg"
          >
            <Highlighted parts={diff.after} kind="added" />
          </p>
        </div>
      </div>
    </section>
  );
}

function SourceList<T extends { id: string; name: string }>({
  title,
  items,
  chosen,
  max,
  onToggle,
  empty,
}: {
  title: string;
  items: (T & { disabled?: boolean })[];
  chosen: string[];
  max: number;
  onToggle(id: string): void;
  empty: string;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium text-muted">{title}</legend>
      {items.length === 0 ? (
        <p className="text-xs text-subtle">{empty}</p>
      ) : (
        items.map((item) => {
          const on = chosen.includes(item.id);
          return (
            <label key={item.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--accent)]"
                checked={on}
                disabled={item.disabled || (!on && chosen.length >= max)}
                onChange={() => onToggle(item.id)}
              />
              <span>{item.name}</span>
            </label>
          );
        })
      )}
    </fieldset>
  );
}

/** "Assistente de IA" of the CT document: proposes text changes; nothing changes without a click. */
export function CtAssistantPanel({
  sessionId,
  document,
  onApply,
  className,
}: CtAssistantPanelProps) {
  const uid = useId();
  const { data: models = [] } = useModelOptions();
  const { data: libraries = [] } = useLibraries();
  const { data: servers = [] } = useMcpServers();
  const [scope, setScope] = useState<ScopeValue>('document');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [libraryIds, setLibraryIds] = useState<string[]>([]);
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([]);
  const [result, setResult] = useState<{
    data: CtAssistantResultDto;
    base: CtAssistantDocument;
    changes: FieldChange[];
  } | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const toggle = (list: string[], setList: (v: string[]) => void) => (id: string) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const run = useMutation({
    mutationFn: (request: CtAssistantRequest) =>
      api.post<CtAssistantResultDto>(`/api/tests/sessions/${sessionId}/ct-assistant`, request),
    onMutate: () => {
      setError(null);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const ask = (action: CtAssistantAction) => {
    const base = toRequestDocument(document);
    run.mutate(
      {
        action,
        ...(action === 'custom' ? { prompt } : prompt.trim() ? { prompt } : {}),
        scope: toScope(scope),
        document: base,
        libraryIds,
        mcpServerIds,
        ...(model ? { model } : {}),
      },
      {
        onSuccess: (data) => {
          setApplied(new Set());
          setResult({ data, base, changes: buildChanges(data.patch, base) });
        },
      },
    );
  };

  const pending = result?.changes.filter((c) => !applied.has(c.key)) ?? [];
  const applyOne = (change: FieldChange) => {
    onApply(change.patch);
    setApplied((prev) => new Set(prev).add(change.key));
  };
  const applyAll = () => {
    if (pending.length === 0) return;
    onApply(mergePatches(pending.map((c) => c.patch)));
    setApplied(new Set(result?.changes.map((c) => c.key)));
  };

  const busy = run.isPending;
  const promptTooLong = prompt.length > CT_ASSISTANT_LIMITS.maxPromptChars;

  return (
    <section
      aria-label="Assistente de IA"
      className={cn(
        'flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4',
        className,
      )}
    >
      <header className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent-text" aria-hidden />
        <h3 className="text-base font-semibold text-fg">Assistente de IA</h3>
      </header>
      <p className="text-xs text-muted">
        A IA só lê e sugere texto (imagens não são enviadas e dados pessoais são protegidos). Nada
        muda no documento sem o seu clique.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-scope`} className="text-sm font-medium text-fg">
            Escopo
          </label>
          <Select
            id={`${uid}-scope`}
            value={scope}
            onChange={(e) => setScope(e.target.value as ScopeValue)}
          >
            <option value="document">Documento inteiro</option>
            <option value="context">Contexto</option>
            {document.useCases.map((useCase, i) => (
              <option key={i} value={`useCase:${i}`}>
                {useCase.title?.trim() || `Caso de Uso ${i + 1}`}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-model`} className="text-sm font-medium text-fg">
            Modelo de IA
          </label>
          <Select id={`${uid}-model`} value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Automático</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <details className="group rounded-xl border border-border bg-bg-elevated px-3 py-2">
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-fg">
          <span>
            Fontes (opcional)
            {libraryIds.length + mcpServerIds.length > 0 && (
              <span className="ml-2 text-xs font-normal text-muted">
                {libraryIds.length + mcpServerIds.length} selecionada(s)
              </span>
            )}
          </span>
          <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SourceList
            title="Bibliotecas de documentos"
            items={libraries.map((l) => ({ id: l.id, name: l.name }))}
            chosen={libraryIds}
            max={CT_ASSISTANT_LIMITS.maxLibraries}
            onToggle={toggle(libraryIds, setLibraryIds)}
            empty="Nenhuma biblioteca cadastrada."
          />
          <SourceList
            title="Servidores MCP"
            items={servers.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name }))}
            chosen={mcpServerIds}
            max={CT_ASSISTANT_LIMITS.maxMcpServers}
            onToggle={toggle(mcpServerIds, setMcpServerIds)}
            empty="Nenhum servidor MCP ativo."
          />
        </div>
        <p className="mt-2 text-xs text-muted">
          Ex.: o dicionário de dados (MCP) ajuda a nomear tabelas e menus corretamente.
        </p>
      </details>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Ações rápidas">
        {QUICK_ACTIONS.map((q) => (
          <Button
            key={q.action}
            variant="outline"
            size="sm"
            title={q.hint}
            disabled={busy}
            onClick={() => ask(q.action)}
          >
            {q.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${uid}-prompt`} className="text-sm font-medium text-fg">
          Pedido livre
        </label>
        <Textarea
          id={`${uid}-prompt`}
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ex.: deixe o texto do caso de uso 2 mais formal"
        />
        {promptTooLong && (
          <p className="text-xs text-danger">
            Máximo de {CT_ASSISTANT_LIMITS.maxPromptChars} caracteres.
          </p>
        )}
        <div>
          <Button
            size="sm"
            loading={busy}
            disabled={!prompt.trim() || promptTooLong}
            onClick={() => ask('custom')}
          >
            Enviar pedido
          </Button>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {result && (
        <div className="flex flex-col gap-3" aria-live="polite">
          <div className="rounded-xl border border-border bg-bg-elevated p-3">
            <p className="text-sm text-fg">{result.data.explanation}</p>
            <p className="mt-1 text-xs text-subtle">
              Modelo: {result.data.model}
              {result.data.usage.inputTokens !== null &&
                ` · ${result.data.usage.inputTokens} tokens de entrada`}
              {result.data.usage.outputTokens !== null &&
                ` · ${result.data.usage.outputTokens} de saída`}
            </p>
          </div>
          {result.data.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-warning">
              {result.data.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          {result.changes.length === 0 ? (
            <p className="text-sm text-muted">A IA não sugeriu alterações.</p>
          ) : (
            result.changes.map((change) => (
              <DiffCard
                key={change.key}
                change={change}
                applied={applied.has(change.key)}
                onApply={() => applyOne(change)}
              />
            ))
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
              <X className="h-4 w-4" aria-hidden /> Descartar
            </Button>
            {result.changes.length > 0 && (
              <Button size="sm" disabled={pending.length === 0} onClick={applyAll}>
                Aplicar tudo
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
