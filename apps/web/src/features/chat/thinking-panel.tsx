import type { ChatStep } from '@thinkflow/shared';
import { Check, ChevronDown, CircleCheck, LoaderCircle, Minus, Wrench } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/utils';
import { LIBRARY_TOOL_NAME, type StepState, type UiToolCall } from './types';

const STEP_LABELS: Record<ChatStep, { active: string; done: string; skipped: string }> = {
  analyze: {
    active: 'Analisando sua pergunta…',
    done: 'Pergunta analisada',
    skipped: 'Análise interrompida',
  },
  search: {
    active: 'Buscando informações relevantes…',
    done: 'Informações coletadas',
    skipped: 'Nenhuma busca externa necessária',
  },
  compose: {
    active: 'Montando a resposta…',
    done: 'Resposta montada',
    skipped: 'Resposta não concluída',
  },
};

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done')
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accent-fg">
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    );
  if (state === 'active') return <LoaderCircle className="h-5 w-5 animate-spin text-accent-text" />;
  if (state === 'skipped')
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border text-subtle">
        <Minus className="h-3 w-3" />
      </span>
    );
  return <span className="h-5 w-5 rounded-full border-2 border-border-strong" />;
}

export function ThinkingPanel({
  steps,
  streaming,
  toolCalls,
  reasoning,
}: {
  steps: Record<ChatStep, StepState>;
  streaming: boolean;
  toolCalls: UiToolCall[];
  reasoning?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const open = streaming || expanded;

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => !streaming && setExpanded((v) => !v)}
        className={cn(
          'flex items-center gap-2.5 text-[15px] font-medium',
          !streaming && 'cursor-pointer text-muted hover:text-fg',
        )}
        aria-expanded={open}
      >
        {streaming ? (
          <>
            <span className="animate-tf-pulse h-3 w-3 rounded-full bg-accent" aria-hidden />
            Pensando…
          </>
        ) : (
          <>
            <CircleCheck className="h-4 w-4 text-accent-text" aria-hidden />
            Raciocínio concluído
            {toolCalls.length > 0 && (
              <span className="text-xs text-subtle">· {toolCalls.length} ferramenta(s)</span>
            )}
            <ChevronDown
              className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')}
              aria-hidden
            />
          </>
        )}
      </button>

      {open && (
        <ol className="mt-3 flex flex-col gap-2.5 pl-0.5">
          {(Object.keys(STEP_LABELS) as ChatStep[]).map((step) => {
            const state = steps[step];
            const label =
              state === 'done'
                ? STEP_LABELS[step].done
                : state === 'skipped'
                  ? STEP_LABELS[step].skipped
                  : STEP_LABELS[step].active;
            return (
              <li key={step} className="flex flex-col gap-2">
                <div
                  className={cn(
                    'flex items-center gap-3 text-sm',
                    state === 'pending' || state === 'skipped' ? 'text-subtle' : 'text-fg',
                  )}
                >
                  <StepIcon state={state} />
                  <span>{label}</span>
                </div>
                {step === 'search' && toolCalls.length > 0 && (
                  <ul className="ml-8 flex flex-col gap-1.5">
                    {toolCalls.map((call) => (
                      <ToolCallItem key={call.id} call={call} />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {reasoning && (
            <li>
              <details className="ml-8 text-sm">
                <summary className="cursor-pointer text-muted hover:text-fg">
                  Ver raciocínio do modelo
                </summary>
                <p className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-xs text-muted">
                  {reasoning}
                </p>
              </details>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

function libraryQuery(input: unknown): string | undefined {
  const query =
    input && typeof input === 'object' ? (input as { consulta?: unknown }).consulta : undefined;
  return typeof query === 'string' ? query : undefined;
}

function field(input: unknown, key: string): string | undefined {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : null;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Friendly summary of the "Dados com IA" tools; other tools keep their raw name. */
export function describeDataTool(
  name: string,
  input: unknown,
): { label: string; detail?: string } | null {
  switch (name) {
    case 'listar_tabelas':
      return { label: 'Consultou o catálogo', ...optional('detail', field(input, 'filtro')) };
    case 'descrever_tabela':
      return { label: `Descreveu tabela ${field(input, 'tabela') ?? ''}`.trim() };
    case 'resumo_coluna': {
      const target = [field(input, 'tabela'), field(input, 'coluna')].filter(Boolean).join('.');
      return { label: target ? `Resumo da coluna ${target}` : 'Resumo da coluna' };
    }
    case 'executar_consulta':
      return { label: 'Executou consulta', ...optional('detail', field(input, 'objetivo')) };
    default:
      return null;
  }
}

function optional<K extends string>(key: K, value: string | undefined) {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function ToolCallItem({ call }: { call: UiToolCall }) {
  const running = call.output === undefined;
  const data = describeDataTool(call.name, call.input);
  const sql = call.name === 'executar_consulta' ? field(call.input, 'sql') : undefined;
  return (
    <li>
      <details className="group rounded-lg border border-border bg-surface-2/60 text-xs">
        <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5">
          {running ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin text-accent-text" />
          ) : (
            <Wrench
              className={cn('h-3.5 w-3.5', call.isError ? 'text-danger' : 'text-accent-text')}
            />
          )}
          {call.name === LIBRARY_TOOL_NAME ? (
            <span className="font-medium">Biblioteca</span>
          ) : data ? (
            <span className="font-medium">{data.label}</span>
          ) : (
            <code className="font-mono">{call.name}</code>
          )}
          {call.name === LIBRARY_TOOL_NAME && libraryQuery(call.input) && (
            <span className="truncate text-muted">«{libraryQuery(call.input)}»</span>
          )}
          {data?.detail && <span className="truncate text-muted">{data.detail}</span>}
          {call.isError && <span className="text-danger">falhou</span>}
        </summary>
        <div className="space-y-2 border-t border-border px-2.5 py-2">
          {sql ? (
            <div>
              {field(call.input, 'objetivo') && (
                <p className="mb-1 text-muted">Objetivo: {field(call.input, 'objetivo')}</p>
              )}
              <pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-bg-elevated p-2 font-mono">
                {sql}
              </pre>
            </div>
          ) : (
            <div>
              <p className="mb-1 text-subtle">Entrada</p>
              <pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap font-mono">
                {JSON.stringify(call.input, null, 2)}
              </pre>
            </div>
          )}
          {!running && (
            <div>
              <p className="mb-1 text-subtle">Saída</p>
              <pre className="scrollbar-thin max-h-56 overflow-auto whitespace-pre-wrap font-mono">
                {call.output || '(vazio)'}
              </pre>
              {data && (
                <p className="mt-1 text-subtle">
                  Tokens como [NOME_1] são o que a IA recebeu; o valor real aparece só para você.
                </p>
              )}
            </div>
          )}
        </div>
      </details>
    </li>
  );
}
