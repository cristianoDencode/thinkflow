import type { ConversationSummaryDto } from '@thinkflow/shared';
import { ScrollText } from 'lucide-react';
import { timeAgo } from '../../lib/utils';

/** Rolling summary that replaces the oldest messages in the model's context. */
export function ContextSummary({ summary }: { summary: ConversationSummaryDto }) {
  return (
    <details className="rounded-xl border border-border bg-surface-2/60 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3.5 py-2.5 text-muted">
        <ScrollText className="h-4 w-4 shrink-0 text-accent-text" aria-hidden />
        <span>Resumo das mensagens anteriores</span>
        <span className="ml-auto text-xs text-subtle">
          {summary.kind === 'llm' ? 'gerado por IA' : 'extrativo'} · {timeAgo(summary.updatedAt)}
        </span>
      </summary>
      <p className="scrollbar-thin max-h-72 overflow-auto border-t border-border px-3.5 py-3 text-sm whitespace-pre-wrap">
        {summary.text}
      </p>
    </details>
  );
}
