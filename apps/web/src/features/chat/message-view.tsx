import { notify } from '../../lib/notify';
import { friendlyError } from '../../lib/friendly-error';
import {
  Check,
  Copy,
  Ellipsis,
  GitBranch,
  LoaderCircle,
  Library,
  Paperclip,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { cn, formatNumber } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { AiReviewCard } from '../data-ai/ai-review-card';
import { QueryResultCard } from '../data-ai/query-result-card';
import type { SqlCodeActions } from '../data-ai/sql-code-block';
import { DiagramContext } from './diagram-context';
import { Markdown } from './markdown';
import { ReportJobCard } from './report-job-card';
import { ThinkingPanel } from './thinking-panel';
import { INITIAL_STEPS, type UiMessage } from './types';

/** Marks messages copied from the conversation this one was derived from. */
export function CarriedLabel({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-center gap-1 text-xs text-subtle', className)}>
      <GitBranch className="h-3 w-3" aria-hidden />
      trazida da conversa original
    </p>
  );
}

export function UserMessage({ message }: { message: UiMessage }) {
  return (
    <div className="flex flex-col items-end gap-1">
      {message.carried && <CarriedLabel />}
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-4 py-3 text-[15px] whitespace-pre-wrap">
        {message.content}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.attachments.map((a) => (
              <span
                key={a.name}
                className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-xs text-muted"
              >
                <Paperclip className="h-3 w-3" /> {a.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function AssistantMessage({
  message,
  onFeedback,
  onFork,
  databaseId = null,
  sqlActions,
}: {
  message: UiMessage;
  /** Mode `data`: connection that "Executar de novo" runs the stored queries against. */
  databaseId?: string | null;
  /** Mode `data`: "Rodar" for the SQL of the answer and of the result cards (absent = no buttons). */
  sqlActions?: Omit<SqlCodeActions, 'validations' | 'databaseId'>;
  onFeedback(id: string, value: 'up' | 'down' | null): void;
  /** Starts a derived conversation from this answer (hidden while it is not persisted yet). */
  onFork?: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const streaming = !!message.streaming;
  // "Gerar agora" adds a card-only message: nothing was thought or answered by the model
  const direct = !!message.direct;
  const queryResults = message.queryResults ?? [];
  const cardOnly = (!message.steps && !!message.report) || direct;
  const diagramContext = useMemo(
    () => ({
      messageId: message.id,
      model: message.model
        ? message.providerId && message.providerId !== 'agent'
          ? `${message.providerId}/${message.model}`
          : message.model
        : 'thinkflow/default',
      repairs: message.diagramRepairs,
    }),
    [message.id, message.model, message.providerId, message.diagramRepairs],
  );

  const codeActions = useMemo(
    () =>
      sqlActions
        ? { ...sqlActions, databaseId, validations: message.sqlValidation ?? [] }
        : undefined,
    [sqlActions, databaseId, message.sqlValidation],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      notify.error('Não foi possível copiar');
    }
  };

  const feedback = async (value: 'up' | 'down') => {
    const next = message.feedback === value ? null : value;
    onFeedback(message.id, next);
    try {
      await api.post(`/api/messages/${message.id}/feedback`, { feedback: next });
    } catch {
      // feedback is best-effort
    }
  };

  return (
    <article
      className="rounded-2xl border border-border bg-surface/70 p-4 sm:p-6"
      aria-busy={streaming}
    >
      {message.carried && <CarriedLabel className="mb-2" />}
      <div className="flex gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg shadow-lg shadow-accent/30">
          <Sparkles className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 pt-1">
          {direct && streaming && queryResults.length === 0 && (
            <p className="flex items-center gap-2 text-sm text-muted" role="status">
              <LoaderCircle className="h-4 w-4 animate-spin text-accent-text" aria-hidden />
              Executando a consulta…
            </p>
          )}
          {!cardOnly && (
            <ThinkingPanel
              steps={message.steps ?? INITIAL_STEPS}
              streaming={streaming}
              toolCalls={message.toolCalls}
              reasoning={message.reasoning}
            />
          )}

          {queryResults.map((result) => (
            <QueryResultCard
              key={result.id}
              result={result}
              databaseId={databaseId}
              {...(sqlActions?.onRun
                ? {
                    onRunSql: sqlActions.onRun,
                    runDisabledReason: sqlActions.runDisabledReason ?? null,
                  }
                : {})}
            />
          ))}

          {(message.reviews ?? []).map((r) => (
            <AiReviewCard key={r.review.reviewId} review={r.review} closed={r.closed} />
          ))}

          {(message.content || message.error || (!streaming && !direct)) && (
            <div
              className={cn(
                'rounded-xl border border-border bg-bg-elevated/60 px-4 pt-3 pb-2',
                queryResults.length > 0 && 'mt-3',
              )}
            >
              {message.library && (
                <p className="mb-2 flex items-center gap-1.5 text-xs text-subtle">
                  <Library className="h-3.5 w-3.5" aria-hidden />
                  Biblioteca: {message.library.name}
                </p>
              )}
              {message.content ? (
                <DiagramContext.Provider value={diagramContext}>
                  <Markdown
                    content={message.content}
                    streaming={streaming}
                    {...(codeActions ? { codeActions } : {})}
                  />
                </DiagramContext.Provider>
              ) : !message.error && !message.report && queryResults.length === 0 ? (
                <p className="text-sm text-muted">(sem resposta)</p>
              ) : null}
              {message.report && <ReportJobCard report={message.report} />}
              {message.error && (
                <div
                  className="mt-2 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
                  role="alert"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="break-words">
                    {friendlyError(message.error, { agent: message.providerId === 'agent' }).title}
                  </span>
                </div>
              )}
              {!streaming && !cardOnly && (
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-subtle">
                    {showDetails && message.model ? (
                      <>
                        {message.providerId === 'agent'
                          ? 'Agente (Claude Code)'
                          : message.providerId}{' '}
                        · {message.model}
                        {message.outputTokens
                          ? ` · ${formatNumber(message.inputTokens)} → ${formatNumber(message.outputTokens)} tokens`
                          : ''}
                        {message.costUsd ? ` · US$ ${message.costUsd.toFixed(4)}` : ''}
                        {message.context
                          ? ` · Contexto: ${message.context.keptMessages} msgs${
                              message.context.summarized && message.context.omittedMessages > 0
                                ? ` + resumo de ${message.context.omittedMessages}`
                                : ''
                            } · ~${formatNumber(message.context.estimatedTokens)}/${formatNumber(message.context.budgetTokens)} tokens`
                          : ''}
                      </>
                    ) : null}
                  </span>
                  <div className="flex items-center gap-0.5">
                    {onFork && !message.id.startsWith('local-') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onFork(message.id)}
                        aria-label="Derivar conversa a partir desta resposta"
                        title="Derivar: cria uma nova conversa a partir desta resposta, com um resumo do contexto"
                        className="text-accent-text"
                      >
                        <GitBranch className="h-4 w-4" />
                        Derivar
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={copy}
                      aria-label="Copiar resposta"
                      title="Copiar"
                    >
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => feedback('up')}
                      aria-label="Resposta útil"
                      aria-pressed={message.feedback === 'up'}
                      className={cn(message.feedback === 'up' && 'text-accent-text')}
                    >
                      <ThumbsUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => feedback('down')}
                      aria-label="Resposta não útil"
                      aria-pressed={message.feedback === 'down'}
                      className={cn(message.feedback === 'down' && 'text-danger')}
                    >
                      <ThumbsDown className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setShowDetails((v) => !v)}
                      aria-label="Detalhes da resposta"
                      aria-pressed={showDetails}
                    >
                      <Ellipsis className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
