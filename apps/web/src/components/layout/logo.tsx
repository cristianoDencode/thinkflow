import { useId } from 'react';
import { cn } from '../../lib/utils';

/** Thinkflow mark: a "T" whose stem flows into a node — routing between connections. */
export function LogoMark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 64 64" className={cn('h-9 w-9', className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c4b5fd" />
          <stop offset="0.5" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#5b21b6" />
        </linearGradient>
      </defs>
      <path d="M6 10h52l-8 11H38v29l-11 8V21H6z" fill={`url(#${id})`} />
      <circle cx="51" cy="46" r="6" fill="#a78bfa" />
      <path
        d="M38 40c6 0 7 6 13 6"
        stroke="#a78bfa"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <LogoMark />
      {!collapsed && (
        <div className="leading-tight">
          <p className="text-lg font-semibold tracking-tight">Thinkflow</p>
          <p className="text-[11px] text-muted">Think. Route. Flow.</p>
        </div>
      )}
    </div>
  );
}
