import type { PrototypeDto } from '@thinkflow/shared';
import {
  Copy,
  ExternalLink,
  Play,
  FileCode2,
  FlaskConical,
  LayoutTemplate,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { Badge, Card } from '../../components/ui/card';
import { ConfirmButton } from '../../components/ui/dialog';
import { timeAgo } from '../../lib/utils';
import { thumbnailSrc } from './thumbnail';

export function PrototypeCard({
  prototype: p,
  fetchedAt,
  busy,
  onRename,
  onDuplicate,
  onDelete,
  onUse,
}: {
  prototype: PrototypeDto;
  /** When the list was last fetched (cache-busting of the thumbnail while it may still change). */
  fetchedAt?: number;
  busy?: boolean;
  onRename(): void;
  /** Absent for templates (they are used, not duplicated). */
  onDuplicate?: () => void;
  onDelete(): void;
  /** Templates: start a new prototype from this one. */
  onUse?: () => void;
}) {
  // the PNG exists only after a render (404 until then): fall back to the placeholder
  const src = thumbnailSrc(p, fetchedAt);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <Link
        to={`/prototypes/${p.id}`}
        aria-label={`Abrir ${p.name}`}
        tabIndex={-1}
        className="flex aspect-video items-center justify-center overflow-hidden border-b border-border bg-surface-2"
      >
        {src && failedSrc !== src ? (
          <img
            src={src}
            alt={`Miniatura de ${p.name}`}
            loading="lazy"
            onError={() => setFailedSrc(src)}
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <span className="flex flex-col items-center gap-1 text-xs text-subtle">
            <LayoutTemplate className="h-8 w-8" aria-hidden />
            Sem imagem
          </span>
        )}
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          <Link to={`/prototypes/${p.id}`} className="truncate font-medium hover:text-accent-text">
            {p.name}
          </Link>
          {p.kind === 'template' && <Badge tone="accent">Modelo</Badge>}
        </div>
        {(p.source.file || p.source.menuPath) && (
          <p className="flex flex-col gap-0.5 text-xs text-muted">
            {p.source.file && (
              <span className="inline-flex items-center gap-1 font-mono">
                <FileCode2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{p.source.file}</span>
              </span>
            )}
            {p.source.menuPath && <span className="line-clamp-2">{p.source.menuPath}</span>}
          </p>
        )}
        {p.sessionId && (
          <Link
            to={`/tests/${p.sessionId}`}
            className="inline-flex items-center gap-1 truncate text-xs text-accent-text hover:underline"
          >
            <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{p.sessionName ?? 'Teste vinculado'}</span>
          </Link>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-subtle">
          <span>
            {p.width} × {p.height}
          </span>
          <span>
            {p.versionCount} {p.versionCount === 1 ? 'versão' : 'versões'}
          </span>
          <span>{timeAgo(p.updatedAt)}</span>
          {p.scrubbed && <Badge tone="success">Dados limpos</Badge>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-1 border-t border-border px-3 py-2">
        <div className="flex items-center">
          <Link to={`/prototypes/${p.id}`} aria-label={`Editar ${p.name}`}>
            <Button variant="ghost" size="sm" tabIndex={-1}>
              <ExternalLink className="h-4 w-4" /> Abrir
            </Button>
          </Link>
          {onUse && (
            <Button variant="ghost" size="sm" aria-label={`Usar modelo ${p.name}`} onClick={onUse}>
              <Play className="h-4 w-4" /> Usar
            </Button>
          )}
        </div>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Renomear ${p.name}`}
            title="Renomear"
            onClick={onRename}
            disabled={busy}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          {onDuplicate && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Duplicar ${p.name}`}
              title="Duplicar"
              onClick={onDuplicate}
              disabled={busy}
            >
              <Copy className="h-4 w-4" />
            </Button>
          )}
          <ConfirmButton label={`Excluir ${p.name}`} onConfirm={onDelete}>
            <Trash2 className="h-4 w-4" />
          </ConfirmButton>
        </div>
      </div>
    </Card>
  );
}
