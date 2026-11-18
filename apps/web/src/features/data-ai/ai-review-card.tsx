import type {
  AiReviewClosedReason,
  AiReviewColumnDto,
  AiReviewDto,
  ColumnRuleAction,
} from '@thinkflow/shared';
import { Check, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/card';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';

export const ACTION_LABELS: Record<ColumnRuleAction, string> = {
  reveal: 'Liberar',
  tokenize: 'Tokenizar',
  omit: 'Omitir',
};

const ACTION_HINTS: Record<ColumnRuleAction, string> = {
  reveal: 'A IA vê os valores reais desta coluna',
  tokenize: 'A IA vê tokens no lugar dos valores (ex.: [NOME_1])',
  omit: 'A IA não recebe esta coluna',
};

const ACTIONS: ColumnRuleAction[] = ['reveal', 'tokenize', 'omit'];

const CLOSED_TEXT: Record<AiReviewClosedReason, string> = {
  answered: 'Revisão enviada.',
  timeout: 'Tempo esgotado: todas as colunas foram tokenizadas.',
  aborted: 'Interrompida: todas as colunas foram tokenizadas.',
};

type Decisions = Record<number, { action: ColumnRuleAction; remember: boolean }>;

function sourceLabel(column: AiReviewColumnDto): string {
  const s = column.source;
  return s ? `${s.schema}.${s.table}.${s.column}` : 'expressão';
}

function initialDecisions(review: AiReviewDto): Decisions {
  return Object.fromEntries(
    review.columns.map((c) => [c.index, { action: c.proposed, remember: c.source !== null }]),
  );
}

function SummaryLine({
  review,
  decisions,
  text,
}: {
  review: AiReviewDto;
  decisions: Decisions | null;
  text: string;
}) {
  return (
    <section
      className="mt-3 rounded-xl border border-border bg-surface px-4 py-2.5"
      aria-label="Revisão de privacidade concluída"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <ShieldCheck className="h-4 w-4 shrink-0 text-accent-text" aria-hidden />
        <span className="font-medium text-fg">{text}</span>
        {review.columns.map((c) => (
          <Badge
            key={c.index}
            tone={decisions?.[c.index]?.action === 'reveal' ? 'warning' : 'neutral'}
          >
            {c.name}: {ACTION_LABELS[decisions?.[c.index]?.action ?? 'tokenize']}
          </Badge>
        ))}
      </p>
    </section>
  );
}

/**
 * "Revisar o que vai para a IA": shown inline when the AI queries columns nobody classified yet.
 * The analyst sees the REAL sample values; the AI receives only what is marked here.
 */
export function AiReviewCard({
  review,
  closed,
}: {
  review: AiReviewDto;
  /** Set when the server stopped waiting (answered, timed out or aborted). */
  closed?: AiReviewClosedReason | undefined;
}) {
  const [decisions, setDecisions] = useState<Decisions>(() => initialDecisions(review));
  const [sent, setSent] = useState<Decisions | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sent || closed) {
    // a card closed without our answer (timeout, abort) shows the safe default the server applied
    const text = sent ? CLOSED_TEXT.answered : CLOSED_TEXT[closed ?? 'answered'];
    const shown = sent ?? (closed === 'answered' ? decisions : null);
    return <SummaryLine review={review} decisions={shown} text={text} />;
  }

  const set = (index: number, patch: Partial<Decisions[number]>) =>
    setDecisions((d) => ({ ...d, [index]: { ...d[index]!, ...patch } }));

  const submit = async (next: Decisions) => {
    setSending(true);
    setError(null);
    try {
      await api.post(`/api/chat/reviews/${encodeURIComponent(review.reviewId)}`, {
        decisions: review.columns.map((c) => ({
          index: c.index,
          action: next[c.index]!.action,
          remember: c.source !== null && next[c.index]!.remember,
        })),
      });
      setSent(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const tokenizeAll = () => {
    const all: Decisions = Object.fromEntries(
      review.columns.map((c) => [c.index, { ...decisions[c.index]!, action: 'tokenize' as const }]),
    );
    setDecisions(all);
    void submit(all);
  };

  return (
    <section
      className="mt-3 overflow-hidden rounded-xl border border-accent/40 bg-surface"
      aria-label="Revisar o que vai para a IA"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <ShieldCheck className="h-4 w-4 shrink-0 text-accent-text" aria-hidden />
        <h3 className="text-sm font-semibold">Revisar o que vai para a IA</h3>
        <Badge tone="warning">Aguardando você</Badge>
      </header>

      <div className="px-4 py-3 text-sm text-muted">
        <p>
          Você vê os dados reais na tela; a IA recebe só o que for marcado aqui. Colunas novas
          começam como <strong className="font-medium text-fg">Tokenizar</strong>: a IA enxerga um
          código (ex.: <code className="font-mono">[NOME_1]</code>) no lugar do valor, e você
          continua vendo o valor real nas respostas.
        </p>
        <p className="mt-1 text-xs text-subtle">
          Sem resposta em 5 minutos, tudo é tokenizado. A consulta só é entregue à IA depois da sua
          decisão.
        </p>
      </div>

      <div className="scrollbar-thin max-h-[26rem] overflow-auto border-t border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-surface-2 text-left text-xs text-muted">
              <th scope="col" className="px-3 py-2 font-medium">
                Coluna
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Valores reais (amostra)
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Para a IA
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Lembrar
              </th>
            </tr>
          </thead>
          <tbody>
            {review.columns.map((column) => {
              const decision = decisions[column.index]!;
              const expression = column.source === null;
              return (
                <tr key={column.index} className="border-t border-border/60 align-top">
                  <th scope="row" className="max-w-56 px-3 py-2 text-left font-normal">
                    <span className="block truncate font-medium" title={column.name}>
                      {column.name}
                    </span>
                    <span
                      className="block truncate text-[11px] text-subtle"
                      title={sourceLabel(column)}
                    >
                      {sourceLabel(column)} · {column.type}
                    </span>
                  </th>
                  <td className="max-w-64 px-3 py-2">
                    {column.sample.length === 0 ? (
                      <span className="text-xs text-subtle italic">sem valores</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {column.sample.map((value, i) => (
                          <li key={i} className="truncate font-mono text-xs" title={value}>
                            {value}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div
                      role="radiogroup"
                      aria-label={`Para a IA: ${column.name}`}
                      className="inline-flex overflow-hidden rounded-lg border border-border"
                    >
                      {ACTIONS.map((action) => (
                        <button
                          key={action}
                          type="button"
                          role="radio"
                          aria-checked={decision.action === action}
                          title={ACTION_HINTS[action]}
                          onClick={() => set(column.index, { action })}
                          className={cn(
                            'cursor-pointer border-l border-border px-2.5 py-1 text-xs font-medium first:border-l-0',
                            decision.action === action
                              ? 'bg-accent-soft text-accent-text'
                              : 'text-muted hover:bg-surface-hover hover:text-fg',
                          )}
                        >
                          {ACTION_LABELS[action]}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <label
                      className={cn(
                        'flex items-center gap-1.5 text-xs',
                        expression ? 'cursor-not-allowed text-subtle' : 'cursor-pointer text-muted',
                      )}
                      title={
                        expression
                          ? 'Expressões valem só para esta consulta'
                          : 'Vale para esta coluna nas próximas consultas'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={!expression && decision.remember}
                        disabled={expression}
                        onChange={(e) => set(column.index, { remember: e.target.checked })}
                        aria-label={`Lembrar para esta coluna: ${column.name}`}
                        className="h-3.5 w-3.5 accent-[var(--accent)]"
                      />
                      Lembrar para esta coluna
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error && (
        <div
          className="mx-4 mt-3 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
          role="alert"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="break-words">{error}</span>
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        <Button size="sm" onClick={() => void submit(decisions)} loading={sending}>
          {!sending && <Check className="h-3.5 w-3.5" aria-hidden />} Enviar à IA
        </Button>
        <Button variant="secondary" size="sm" onClick={tokenizeAll} disabled={sending}>
          Tokenizar tudo
        </Button>
      </footer>
    </section>
  );
}
