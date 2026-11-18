import { useMutation } from '@tanstack/react-query';
import {
  buildQuickActionPrompt,
  PROTOTYPE_ASSISTANT_LIMITS,
  PROTOTYPE_ASSISTANT_QUICK_ACTIONS,
  type PrototypeAssistantAction,
  type PrototypeAssistantQuickAction,
  type PrototypeAssistantRequest,
  type PrototypeAssistantResultDto,
} from '@thinkflow/shared';
import { Check, ChevronDown, Sparkles, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input, Select, Textarea } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { useLibraries, useMcpServers, useModelOptions } from '../../lib/queries';
import { cn } from '../../lib/utils';
import {
  buildPreviewDoc,
  collapseSame,
  cssLines,
  htmlLines,
  isBlankHtml,
  lineDiff,
  type LinePart,
} from './prototype-assistant-helpers';

export interface PrototypeAssistantSnapshot {
  html: string;
  css: string;
  width: number;
  height: number;
}

export interface PrototypeAssistantSelectionInfo {
  html: string;
  /** Positions among the element children, from `<body>` (`[0, 2]`), or "0/2". */
  path: number[] | string;
}

export interface PrototypeAssistantChange {
  html: string;
  css: string;
  /** What the person asked (the editor notes the version as "IA: <prompt>"). */
  prompt: string;
  explanation: string;
}

export interface PrototypeAssistantPanelProps {
  prototypeId: string;
  /** The current content of the editor (read when a request is sent). */
  getSnapshot(): PrototypeAssistantSnapshot;
  /** The selected component, or null when nothing is selected. */
  getSelection(): PrototypeAssistantSelectionInfo | null;
  /** Called only when the person clicks "Aplicar"; the editor creates a version from it. */
  onApply(change: PrototypeAssistantChange): void;
  className?: string;
}

type Scope = 'screen' | 'selection';
type View = 'visual' | 'text';

interface Outcome {
  data: PrototypeAssistantResultDto;
  before: PrototypeAssistantSnapshot;
  prompt: string;
  scope: Scope;
}

/** Inert preview of a screen: sandboxed without scripts, scaled to the width of its box. */
function ScaledPreview({
  title,
  html,
  css,
  width,
  height,
}: {
  title: string;
  html: string;
  css: string;
  width: number;
  height: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(320);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0) setBoxWidth(el.clientWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scale = Math.min(1, boxWidth / width);
  const doc = useMemo(() => buildPreviewDoc(html, css), [html, css]);
  return (
    <div
      ref={box}
      className="w-full overflow-hidden rounded-lg border border-border bg-white"
      style={{ height: Math.min(Math.round(height * scale), 420) }}
    >
      <iframe
        title={title}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={doc}
        tabIndex={-1}
        style={{
          width,
          height,
          border: 0,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

function DiffLines({ label, parts, testId }: { label: string; parts: LinePart[]; testId: string }) {
  const changed = parts.some((p) => p.kind !== 'same');
  return (
    <section aria-label={label} data-testid={testId}>
      <h4 className="mb-1 text-xs font-medium text-muted">{label}</h4>
      {changed ? (
        <pre className="max-h-72 overflow-auto rounded-lg bg-surface-2 p-2 text-xs leading-5">
          {parts.map((p, i) => (
            <div
              key={i}
              data-diff={p.kind}
              className={cn(
                'whitespace-pre-wrap break-all',
                p.kind === 'added' && 'bg-success-soft text-fg',
                p.kind === 'removed' && 'bg-danger-soft text-fg line-through',
                p.kind === 'same' && 'text-subtle',
              )}
            >
              {p.kind === 'added' ? '+ ' : p.kind === 'removed' ? '- ' : '  '}
              {p.text}
            </div>
          ))}
        </pre>
      ) : (
        <p className="text-xs text-subtle">Sem mudanças.</p>
      )}
    </section>
  );
}

function SourceList({
  title,
  items,
  chosen,
  max,
  onToggle,
  empty,
}: {
  title: string;
  items: { id: string; name: string }[];
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
                disabled={!on && chosen.length >= max}
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

/** "Assistente de IA" of the prototype editor: proposes HTML/CSS; nothing changes without a click. */
export function PrototypeAssistantPanel({
  prototypeId,
  getSnapshot,
  getSelection,
  onApply,
  className,
}: PrototypeAssistantPanelProps) {
  const uid = useId();
  const { data: models = [] } = useModelOptions();
  const { data: libraries = [] } = useLibraries();
  const { data: servers = [] } = useMcpServers();
  const [scope, setScope] = useState<Scope>('screen');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [libraryIds, setLibraryIds] = useState<string[]>([]);
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([]);
  const [quick, setQuick] = useState<PrototypeAssistantQuickAction | null>(null);
  const [quickValue, setQuickValue] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [view, setView] = useState<View>('visual');
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // the editor changes without re-rendering the panel: re-read on interaction
  const readState = () => {
    try {
      return { blank: isBlankHtml(getSnapshot().html), hasSelection: getSelection() !== null };
    } catch {
      return { blank: false, hasSelection: false };
    }
  };
  const [editorState, setEditorState] = useState(readState);
  const refresh = () => setEditorState(readState());

  const toggle = (list: string[], setList: (v: string[]) => void) => (id: string) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const run = useMutation({
    mutationFn: (request: PrototypeAssistantRequest) =>
      api.post<PrototypeAssistantResultDto>(`/api/prototypes/${prototypeId}/assistant`, request),
    onMutate: () => setError(null),
    onError: (err) => setError(errorMessage(err)),
  });

  const ask = (action: PrototypeAssistantAction, text: string) => {
    const snapshot = getSnapshot();
    let selection: PrototypeAssistantSelectionInfo | null = null;
    if (scope === 'selection') {
      selection = getSelection();
      if (!selection) {
        setError('Selecione um componente no editor ou escolha "Tela inteira".');
        refresh();
        return;
      }
    }
    run.mutate(
      {
        prompt: text,
        action,
        ...(selection ? { selection: { path: selection.path, html: selection.html } } : {}),
        html: snapshot.html,
        css: snapshot.css,
        width: snapshot.width,
        height: snapshot.height,
        libraryIds,
        mcpServerIds,
        ...(model ? { model } : {}),
      },
      {
        onSuccess: (data) => {
          setApplied(false);
          setView('visual');
          setOutcome({ data, before: snapshot, prompt: text, scope });
        },
      },
    );
  };

  const chooseQuick = (q: PrototypeAssistantQuickAction) => {
    refresh();
    if (q.input) {
      setQuick(q);
      setQuickValue('');
      return;
    }
    setPrompt(buildQuickActionPrompt(q.action));
    ask(q.action, buildQuickActionPrompt(q.action));
  };

  const sendQuick = () => {
    if (!quick || !quickValue.trim()) return;
    const text = buildQuickActionPrompt(quick.action, quickValue);
    setPrompt(text);
    setQuick(null);
    ask(quick.action, text);
  };

  const diffs = useMemo(() => {
    if (!outcome) return null;
    const { before, data } = outcome;
    return {
      html: collapseSame(lineDiff(htmlLines(before.html), htmlLines(data.html))),
      css: collapseSame(lineDiff(cssLines(before.css), cssLines(data.css))),
    };
  }, [outcome]);

  const apply = () => {
    if (!outcome) return;
    onApply({
      html: outcome.data.html,
      css: outcome.data.css,
      prompt: outcome.prompt,
      explanation: outcome.data.explanation,
    });
    setApplied(true);
    setOutcome(null);
  };

  const busy = run.isPending;
  const promptTooLong = prompt.length > PROTOTYPE_ASSISTANT_LIMITS.maxPromptChars;

  return (
    <section
      aria-label="Assistente de IA"
      className={cn(
        'flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4',
        className,
      )}
      onPointerEnter={refresh}
      onFocusCapture={refresh}
    >
      <header className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent-text" aria-hidden />
        <h3 className="text-base font-semibold text-fg">Assistente de IA</h3>
      </header>
      <p className="text-xs text-muted">
        A IA só altera HTML e CSS da tela (imagens não são enviadas e dados pessoais são
        protegidos). Nada muda no protótipo sem o seu clique em Aplicar.
      </p>

      {editorState.blank && (
        <p
          data-testid="blank-hint"
          className="rounded-xl border border-border bg-bg-elevated p-3 text-xs text-muted"
        >
          A tela está em branco. Use “Gerar a partir da descrição” para montar uma tela no estilo do
          sistema (perfil e-Cidade).
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-scope`} className="text-sm font-medium text-fg">
            Escopo
          </label>
          <Select
            id={`${uid}-scope`}
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as Scope);
              refresh();
            }}
          >
            <option value="screen">Tela inteira</option>
            <option value="selection">Componente selecionado</option>
          </Select>
          {scope === 'selection' && !editorState.hasSelection && (
            <p className="text-xs text-warning">Nenhum componente selecionado no editor.</p>
          )}
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
            max={PROTOTYPE_ASSISTANT_LIMITS.maxLibraries}
            onToggle={toggle(libraryIds, setLibraryIds)}
            empty="Nenhuma biblioteca cadastrada."
          />
          <SourceList
            title="Servidores MCP"
            items={servers.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name }))}
            chosen={mcpServerIds}
            max={PROTOTYPE_ASSISTANT_LIMITS.maxMcpServers}
            onToggle={toggle(mcpServerIds, setMcpServerIds)}
            empty="Nenhum servidor MCP ativo."
          />
        </div>
        <p className="mt-2 text-xs text-muted">
          Ex.: o dicionário de dados do sistema (MCP; no e-Cidade, o mapeamento) ajuda a nomear
          campos e rótulos corretamente; a biblioteca traz o contexto do negócio.
        </p>
      </details>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Ações rápidas">
        {PROTOTYPE_ASSISTANT_QUICK_ACTIONS.map((q) => (
          <Button
            key={q.action}
            variant={q.action === 'generate' && editorState.blank ? 'primary' : 'outline'}
            size="sm"
            title={q.hint}
            disabled={busy}
            onClick={() => chooseQuick(q)}
          >
            {q.label}
          </Button>
        ))}
      </div>

      {quick?.input && (
        <form
          aria-label={quick.label}
          className="flex flex-col gap-1.5 rounded-xl border border-border bg-bg-elevated p-3"
          onSubmit={(e) => {
            e.preventDefault();
            sendQuick();
          }}
        >
          <label htmlFor={`${uid}-quick`} className="text-sm font-medium text-fg">
            {quick.input.label}
          </label>
          <Input
            id={`${uid}-quick`}
            autoFocus
            value={quickValue}
            onChange={(e) => setQuickValue(e.target.value)}
            placeholder={quick.input.placeholder}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={busy} disabled={!quickValue.trim()}>
              Enviar
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setQuick(null)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${uid}-prompt`} className="text-sm font-medium text-fg">
          Pedido livre
        </label>
        <Textarea
          id={`${uid}-prompt`}
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ex.: deixe os botões alinhados à direita e troque a cor do título para verde"
        />
        {promptTooLong && (
          <p className="text-xs text-danger">
            Máximo de {PROTOTYPE_ASSISTANT_LIMITS.maxPromptChars} caracteres.
          </p>
        )}
        <div>
          <Button
            size="sm"
            loading={busy}
            disabled={!prompt.trim() || promptTooLong}
            onClick={() => ask('custom', prompt.trim())}
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

      {applied && !outcome && (
        <p className="inline-flex items-center gap-1 text-xs text-success" role="status">
          <Check className="h-3.5 w-3.5" aria-hidden /> Alteração aplicada ao protótipo.
        </p>
      )}

      {outcome && diffs && (
        <div className="flex flex-col gap-3" aria-live="polite" data-testid="assistant-result">
          <div className="rounded-xl border border-border bg-bg-elevated p-3">
            <p className="text-sm text-fg">{outcome.data.explanation}</p>
            <p className="mt-1 text-xs text-subtle">
              {outcome.scope === 'selection' ? 'Componente selecionado' : 'Tela inteira'} · Modelo:{' '}
              {outcome.data.model}
              {outcome.data.usage.inputTokens !== null &&
                ` · ${outcome.data.usage.inputTokens} tokens de entrada`}
              {outcome.data.usage.outputTokens !== null &&
                ` · ${outcome.data.usage.outputTokens} de saída`}
            </p>
          </div>
          {outcome.data.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-warning">
              {outcome.data.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <div role="tablist" aria-label="Visualização" className="flex gap-1">
            {(
              [
                ['visual', 'Visual'],
                ['text', 'Texto (diff)'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={cn(
                  'rounded-lg px-3 py-1 text-xs font-medium',
                  view === id ? 'bg-accent-soft text-accent-text' : 'text-muted hover:bg-surface-2',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {view === 'visual' ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium text-muted">Antes</p>
                <ScaledPreview
                  title="Antes"
                  html={outcome.before.html}
                  css={outcome.before.css}
                  width={outcome.before.width}
                  height={outcome.before.height}
                />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted">Depois</p>
                <ScaledPreview
                  title="Depois"
                  html={outcome.data.html}
                  css={outcome.data.css}
                  width={outcome.before.width}
                  height={outcome.before.height}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <DiffLines label="HTML" parts={diffs.html} testId="diff-html" />
              <DiffLines label="CSS" parts={diffs.css} testId="diff-css" />
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOutcome(null)}>
              <X className="h-4 w-4" aria-hidden /> Descartar
            </Button>
            <Button size="sm" onClick={apply}>
              Aplicar
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
