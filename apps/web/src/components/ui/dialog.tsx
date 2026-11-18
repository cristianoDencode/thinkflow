import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from './button';

/** Open dialogs, topmost last: only the topmost reacts to Escape/Tab (dialogs can be nested). */
const dialogStack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose(): void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg' | 'xl';
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = Symbol('dialog');
    dialogStack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const active = document.activeElement;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) {
        e.preventDefault();
        panel.focus();
      } else if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    const field =
      size === 'xl'
        ? null
        : panelRef.current?.querySelector<HTMLElement>('input, select, textarea');
    (field ?? panelRef.current)?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      dialogStack.splice(dialogStack.indexOf(token), 1);
      previous?.focus?.();
    };
  }, [open, size]);

  if (!open) return null;
  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex justify-center p-0 sm:items-center sm:p-4',
        size === 'xl' ? 'items-stretch' : 'items-end',
      )}
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'relative flex w-full flex-col border border-border bg-bg-elevated shadow-2xl outline-none sm:rounded-2xl',
          size === 'xl'
            ? 'h-dvh max-h-dvh rounded-none sm:h-[85vh] sm:max-w-5xl'
            : cn('max-h-[92vh] rounded-t-2xl', size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg'),
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fechar">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div
          className={cn(
            'scrollbar-thin min-h-0 flex-1 overflow-y-auto',
            size === 'xl' ? 'p-0' : 'px-5 py-4',
          )}
        >
          {children}
        </div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}

export function ConfirmButton({
  onConfirm,
  label,
  confirmLabel = 'Confirmar?',
  children,
  className,
}: {
  onConfirm(): void;
  label: string;
  confirmLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      className={className}
      onClick={() => {
        if (window.confirm(`${label}: ${confirmLabel}`)) onConfirm();
      }}
    >
      {children}
    </Button>
  );
}
