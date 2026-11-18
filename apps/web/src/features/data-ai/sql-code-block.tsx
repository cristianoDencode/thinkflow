import type { SqlBlockValidationDto, SqlValidationDto } from '@thinkflow/shared';
import { Check, CircleHelp, Copy, Play, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/card';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';

/** Opt-in extras of the SQL blocks of a Markdown answer ("Dados com IA" only). */
export interface SqlCodeActions {
  /** Connection the on-demand check runs against; null = none selected. */
  databaseId: string | null;
  /** Result of the server's check of each SQL block of this answer (by block index). */
  validations: SqlBlockValidationDto[];
  /** Runs the SQL as the analyst's own query (the same path as "Executar SQL"). */
  onRun?: (sql: string) => void;
  /** Why "Rodar" is unavailable right now (no connection…); streaming is handled by the caller. */
  runDisabledReason?: string | null;
}

export const INVALID_RUN_CONFIRM =
  'A validação encontrou problemas nas tabelas ou colunas deste SQL. Rodar mesmo assim?';

/** Copy button with a check mark for ~1.5 s; shared by the answer's SQL blocks and the result card. */
export function CopySqlButton({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
    } catch {
      notify.error('Não foi possível copiar');
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => void copy()}
      aria-label="Copiar SQL"
      title={copied ? 'Copiado' : 'Copiar SQL'}
    >
      {copied ? (
        <Check className="h-4 w-4" aria-hidden />
      ) : (
        <Copy className="h-4 w-4" aria-hidden />
      )}
    </Button>
  );
}

/** Runs a SQL as direct SQL, asking first when its validation found problems. */
export function RunSqlButton({
  sql,
  onRun,
  disabledReason,
  invalid = false,
}: {
  sql: string;
  onRun: (sql: string) => void;
  /** Set = disabled, with this text as the tooltip. */
  disabledReason?: string | null;
  invalid?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={!!disabledReason}
      onClick={() => {
        if (invalid && !window.confirm(INVALID_RUN_CONFIRM)) return;
        onRun(sql);
      }}
      aria-label="Rodar SQL"
      title={disabledReason ?? 'Rodar SQL (somente leitura)'}
      className="text-accent-text"
    >
      <Play className="h-4 w-4" aria-hidden />
    </Button>
  );
}

function ValidationBadge({ validation }: { validation: SqlValidationDto }) {
  if (validation.status === 'ok')
    return (
      <Badge tone="success">
        <ShieldCheck className="h-3 w-3" aria-hidden /> Tabelas e campos conferidos
      </Badge>
    );
  if (validation.status === 'invalid')
    return (
      <Badge tone="warning">
        <ShieldAlert className="h-3 w-3" aria-hidden /> Tabelas ou campos com problema
      </Badge>
    );
  return (
    <Badge tone="neutral">
      <CircleHelp className="h-3 w-3" aria-hidden /> Não conferido
    </Badge>
  );
}

function ValidationDetails({ validation }: { validation: SqlValidationDto }) {
  if (validation.status === 'ok') return null;
  if (validation.status === 'unchecked')
    return validation.reason ? (
      <p className="border-t border-border px-3 py-2 text-xs text-muted">{validation.reason}</p>
    ) : null;
  return (
    <ul className="space-y-1.5 border-t border-border bg-warning-soft/40 px-3 py-2 text-xs">
      {validation.issues.map((issue, i) => (
        <li key={i} className="break-words">
          <span>{issue.message}</span>
          {issue.suggestions.length > 0 && (
            <span className="text-muted">
              {' '}
              Você quis dizer:{' '}
              {issue.suggestions.map((name, j) => (
                <span key={name}>
                  {j > 0 && ', '}
                  <code>{name}</code>
                </span>
              ))}
              ?
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A SQL block of a "Dados com IA" answer: validation badge, "Rodar" and "Copiar". `children` is
 * the highlighted `<pre>` Markdown rendered.
 */
export function SqlCodeBlock({
  sql,
  index,
  actions,
  streaming,
  children,
}: {
  sql: string;
  index: number;
  actions: SqlCodeActions;
  streaming: boolean;
  children: ReactNode;
}) {
  const [fetched, setFetched] = useState<SqlValidationDto | null>(null);
  const [checking, setChecking] = useState(false);
  const validation: SqlValidationDto | null =
    actions.validations.find((v) => v.index === index) ?? fetched;
  const { databaseId } = actions;

  const check = async () => {
    if (!databaseId) return;
    setChecking(true);
    try {
      setFetched(
        await api.post<SqlValidationDto>(`/api/databases/${databaseId}/validate`, { sql }),
      );
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const runDisabledReason = streaming
    ? 'Aguarde a resposta terminar'
    : (actions.runDisabledReason ?? null);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface-2 [&_pre]:m-0 [&_pre]:rounded-none [&_pre]:border-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1">
        <span className="text-xs font-medium text-muted">SQL</span>
        {validation ? (
          <ValidationBadge validation={validation} />
        ) : (
          databaseId &&
          !streaming && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              loading={checking}
              onClick={() => void check()}
            >
              Conferir tabelas e campos
            </Button>
          )
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {actions.onRun && (
            <RunSqlButton
              sql={sql}
              onRun={actions.onRun}
              disabledReason={runDisabledReason}
              invalid={validation?.status === 'invalid'}
            />
          )}
          <CopySqlButton sql={sql} />
        </div>
      </div>
      {children}
      {validation && <ValidationDetails validation={validation} />}
    </div>
  );
}
