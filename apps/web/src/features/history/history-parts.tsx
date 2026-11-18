import {
  conversationOrigin,
  TEMPLATE_KIND_LABELS,
  type ConversationDto,
  type ConversationOrigin,
} from '@thinkflow/shared';
import {
  Bot,
  DatabaseZap,
  FileText,
  GitBranch,
  Library,
  MessageSquareText,
  Pencil,
  Pin,
  PinOff,
  Play,
  Trash2,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Badge, Card } from '../../components/ui/card';
import { ConfirmButton } from '../../components/ui/dialog';
import { cn, timeAgo } from '../../lib/utils';

export const ORIGIN_LABELS: Record<ConversationOrigin, string> = {
  chat: 'Pergunte à AI',
  document: 'Documento',
  agent: 'Agente',
  data: 'Dados com IA',
};

const ORIGIN_TONES: Record<ConversationOrigin, 'neutral' | 'accent' | 'success' | 'warning'> = {
  chat: 'neutral',
  document: 'warning',
  agent: 'accent',
  data: 'success',
};

const ORIGIN_ICONS: Record<ConversationOrigin, typeof Bot> = {
  chat: MessageSquareText,
  document: FileText,
  agent: Bot,
  data: DatabaseZap,
};

function OriginIcon({
  origin,
  className = 'h-4 w-4',
}: {
  origin: ConversationOrigin;
  className?: string;
}) {
  const Icon = ORIGIN_ICONS[origin];
  return <Icon className={className} aria-hidden />;
}

/** Where the conversation came from: chat, document mode (kind), agent or data (connection). */
export function OriginBadge({
  conversation: c,
  databaseName,
}: {
  conversation: ConversationDto;
  databaseName?: string | null;
}) {
  const origin = conversationOrigin(c);
  const detail =
    origin === 'document' && c.preset
      ? TEMPLATE_KIND_LABELS[c.preset.kind]
      : origin === 'data'
        ? (databaseName ?? (c.databaseId ? 'conexão removida' : null))
        : null;
  const label = detail ? `${ORIGIN_LABELS[origin]} · ${detail}` : ORIGIN_LABELS[origin];
  return (
    <Badge tone={ORIGIN_TONES[origin]}>
      <OriginIcon origin={origin} className="h-3 w-3" />
      <span className="max-w-48 truncate" title={label}>
        {label}
      </span>
    </Badge>
  );
}

export function ConversationRow({
  conversation: c,
  databaseName,
  libraryName,
  onContinue,
  onRename,
  onTogglePin,
  onDelete,
}: {
  conversation: ConversationDto;
  /** Name of the Postgres connection (mode data), when known. */
  databaseName?: string | null;
  /** Name of the connected library, when known. */
  libraryName?: string | null;
  onContinue(): void;
  onRename(): void;
  onTogglePin(): void;
  onDelete(): void;
}) {
  const count = `${c.messageCount} ${c.messageCount === 1 ? 'mensagem' : 'mensagens'}`;
  return (
    <Card className="group flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:p-4">
      <button
        type="button"
        onClick={onContinue}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left"
        aria-label={`Abrir conversa ${c.title}`}
      >
        <span
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            c.mode === 'chat' ? 'bg-surface-2 text-muted' : 'bg-accent-soft text-accent-text',
          )}
          aria-hidden
        >
          <OriginIcon origin={conversationOrigin(c)} />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            {c.pinned && (
              <Pin className="h-3.5 w-3.5 shrink-0 text-accent-text" aria-label="Fixada" />
            )}
            <span className="truncate font-medium">{c.title}</span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <OriginBadge conversation={c} databaseName={databaseName} />
            {c.parentConversationId && (
              <Badge tone="accent">
                <GitBranch className="h-3 w-3" />
                Derivada
              </Badge>
            )}
            {c.libraryId && (
              <Badge>
                <Library className="h-3 w-3" />
                <span className="max-w-40 truncate">
                  {libraryName ? `Biblioteca · ${libraryName}` : 'Biblioteca'}
                </span>
              </Badge>
            )}
          </span>
          {c.preview && (
            <span className="mt-0.5 line-clamp-2 block text-sm text-muted">{c.preview}</span>
          )}
          <span className="mt-1 block truncate text-xs text-subtle">
            {timeAgo(c.updatedAt)} · {c.model} · {count}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1 self-end sm:self-center">
        <Button variant="secondary" size="sm" onClick={onContinue}>
          <Play className="h-3.5 w-3.5" />
          Continuar
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRename}
          aria-label={`Renomear conversa ${c.title}`}
          title="Renomear"
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onTogglePin}
          aria-label={c.pinned ? `Desafixar conversa ${c.title}` : `Fixar conversa ${c.title}`}
          title={c.pinned ? 'Desafixar' : 'Fixar'}
        >
          {c.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
        </Button>
        <ConfirmButton
          label={`Excluir conversa ${c.title}`}
          confirmLabel="essa ação não pode ser desfeita"
          onConfirm={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </ConfirmButton>
      </div>
    </Card>
  );
}
