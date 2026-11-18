import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { useInModal } from './modal-context';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-2xl border border-border bg-surface', className)} {...props} />
  );
}

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
  children: ReactNode;
}) {
  const tones = {
    neutral: 'bg-surface-2 text-muted border-border',
    accent: 'bg-accent-soft text-accent-text border-transparent',
    success: 'bg-success-soft text-success border-transparent',
    warning: 'bg-warning-soft text-warning border-transparent',
    danger: 'bg-danger-soft text-danger border-transparent',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  // inside the route modal the title lives in the modal header; keep only description/actions
  const inModal = useInModal();
  if (inModal && !description && !actions) return null;
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {!inModal && <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>}
        {description && (
          <p className={cn('max-w-2xl text-sm text-muted', !inModal && 'mt-1')}>{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-text">
        {icon}
      </div>
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 max-w-md text-sm text-muted">{description}</p>
      </div>
      {action}
    </Card>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange(value: T): void;
  items: { value: T; label: string; count?: number }[];
}) {
  return (
    <div
      role="tablist"
      className="mb-5 inline-flex gap-1 rounded-xl border border-border bg-surface p-1"
    >
      {items.map((item) => (
        <button
          key={item.value}
          role="tab"
          type="button"
          aria-selected={value === item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            'cursor-pointer rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
            value === item.value ? 'bg-accent-soft text-accent-text' : 'text-muted hover:text-fg',
          )}
        >
          {item.label}
          {item.count !== undefined && (
            <span className="ml-1.5 text-xs opacity-70">{item.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
