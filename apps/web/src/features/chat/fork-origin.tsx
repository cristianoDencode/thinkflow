import type { ConversationSummaryDto } from '@thinkflow/shared';
import { GitBranch } from 'lucide-react';
import { Link } from 'react-router';
import { timeAgo } from '../../lib/utils';

/** Banner shown at the top of a derived conversation: where it came from and what was inherited. */
export function ForkOrigin({
  parentId,
  parentTitle,
  summary,
}: {
  parentId: string;
  parentTitle: string | null;
  summary: ConversationSummaryDto | null;
}) {
  return (
    <section
      className="rounded-xl border border-accent/30 bg-accent-soft/60 text-sm"
      aria-label="Origem da conversa derivada"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2.5">
        <GitBranch className="h-4 w-4 shrink-0 text-accent-text" aria-hidden />
        <span>
          Derivada de{' '}
          <strong className="font-semibold">«{parentTitle ?? 'conversa excluída'}»</strong>
        </span>
        {parentTitle !== null && (
          <Link
            to={`/?c=${encodeURIComponent(parentId)}`}
            className="font-medium text-accent-text underline-offset-2 hover:underline"
          >
            Abrir original
          </Link>
        )}
      </div>
      <p className="px-3.5 pb-2.5 text-xs text-muted">
        Esta conversa herdou um resumo do que veio antes e as últimas trocas (marcadas abaixo). A
        conversa original não foi alterada.
      </p>
      {summary && (
        <details className="border-t border-accent/20">
          <summary className="cursor-pointer px-3.5 py-2 text-muted">
            Ver resumo herdado
            <span className="ml-2 text-xs text-subtle">
              {summary.kind === 'llm' ? 'gerado por IA' : 'extrativo'} ·{' '}
              {timeAgo(summary.updatedAt)}
            </span>
          </summary>
          <p className="scrollbar-thin max-h-72 overflow-auto border-t border-accent/20 px-3.5 py-3 whitespace-pre-wrap">
            {summary.text}
          </p>
        </details>
      )}
    </section>
  );
}
