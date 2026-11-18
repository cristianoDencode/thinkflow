import type { PrototypeVersionDto } from '@thinkflow/shared';
import { History } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/card';
import { formatTime } from '../../lib/utils';

/** Dropdown with the versions of a prototype, newest first: open as a draft or restore. */
export function VersionsMenu({
  versions,
  currentId,
  onOpen,
  onRestore,
}: {
  versions: PrototypeVersionDto[];
  currentId: string;
  onOpen(version: PrototypeVersionDto): void;
  onRestore(version: PrototypeVersionDto): void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const sorted = [...versions].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary"
        size="sm"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <History className="h-4 w-4" /> Versões ({versions.length})
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Versões"
          className="absolute right-0 z-30 mt-1 max-h-96 w-80 overflow-y-auto rounded-xl border border-border bg-bg-elevated p-1 shadow-xl"
        >
          {sorted.map((v) => (
            <div
              key={v.id}
              role="menuitem"
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-hover"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  {v.note || 'Versão'}
                  {v.id === currentId && (
                    <Badge tone="accent" className="ml-2">
                      Atual
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-subtle">{formatTime(v.createdAt)}</p>
              </div>
              {v.id !== currentId && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Abrir versão de ${formatTime(v.createdAt)}`}
                    onClick={() => {
                      setOpen(false);
                      onOpen(v);
                    }}
                  >
                    Abrir
                  </Button>
                  <Button
                    variant="soft"
                    size="sm"
                    aria-label={`Restaurar versão de ${formatTime(v.createdAt)}`}
                    onClick={() => {
                      setOpen(false);
                      onRestore(v);
                    }}
                  >
                    Restaurar
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
