import { useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  DatabaseZap,
  GitBranch,
  History,
  MessageSquareText,
  Pin,
  Trash2,
  X,
} from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../../lib/api';
import { keys, useConversations } from '../../lib/queries';
import { cn, timeAgo } from '../../lib/utils';
import { Button } from '../../components/ui/button';

export function HistoryDrawer({
  open,
  onClose,
  activeId,
  onSelect,
  scope = 'chat',
}: {
  open: boolean;
  onClose(): void;
  activeId: string | null;
  onSelect(id: string | null): void;
  /** `data` lists only "Dados com IA" conversations; `chat` the others. */
  scope?: 'chat' | 'data';
}) {
  const { data: all = [], isLoading } = useConversations(scope === 'data' ? { mode: 'data' } : {});
  const data = scope === 'data' ? all : all.filter((c) => c.mode !== 'data');
  const queryClient = useQueryClient();

  const remove = async (id: string) => {
    await api.del(`/api/conversations/${id}`);
    await queryClient.invalidateQueries({ queryKey: keys.conversations });
    if (id === activeId) onSelect(null);
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        className="relative flex h-full w-full max-w-sm flex-col border-l border-border bg-bg-elevated shadow-2xl"
        aria-label="Histórico de conversas"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-semibold">Conversas</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fechar histórico">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto p-2">
          {isLoading && <p className="p-4 text-sm text-muted">Carregando…</p>}
          {!isLoading && data.length === 0 && (
            <p className="p-4 text-sm text-muted">Nenhuma conversa ainda.</p>
          )}
          <ul className="flex flex-col gap-1">
            {data.map((c) => (
              <li key={c.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    onSelect(c.id);
                    onClose();
                  }}
                  className={cn(
                    'flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-xl px-3 py-2 text-left hover:bg-surface-hover',
                    c.id === activeId && 'bg-accent-soft',
                  )}
                >
                  {c.mode === 'agent' ? (
                    <Bot className="mt-0.5 h-4 w-4 shrink-0 text-accent-text" />
                  ) : c.mode === 'data' ? (
                    <DatabaseZap className="mt-0.5 h-4 w-4 shrink-0 text-accent-text" />
                  ) : (
                    <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                  )}
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 text-sm">
                      {c.pinned && <Pin className="h-3 w-3 shrink-0 text-accent-text" />}
                      <span className="truncate">{c.title}</span>
                      {c.parentConversationId && (
                        <GitBranch
                          className="h-3 w-3 shrink-0 text-accent-text"
                          aria-label="Derivada"
                        />
                      )}
                    </span>
                    <span className="block truncate text-xs text-subtle">
                      {timeAgo(c.updatedAt)} · {c.model}
                    </span>
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="opacity-60 group-hover:opacity-100"
                  onClick={() => void remove(c.id)}
                  aria-label={`Excluir conversa ${c.title}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
        <div className="border-t border-border p-3">
          <Link
            to="/history"
            onClick={onClose}
            className="flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-accent-text hover:bg-surface-hover"
          >
            <History className="h-4 w-4" />
            Ver histórico completo
          </Link>
        </div>
      </aside>
    </div>
  );
}
