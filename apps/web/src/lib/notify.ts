import { useSyncExternalStore } from 'react';
import { friendlyError, type FriendlyError } from './friendly-error';

export type AlertKind = 'error' | 'warning' | 'success' | 'info';

export interface AlertItem extends FriendlyError {
  id: number;
  kind: AlertKind;
}

let alerts: AlertItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function push(kind: AlertKind, raw: string, ttl: number): void {
  const friendly = friendlyError(raw);
  // collapse identical alerts instead of stacking duplicates
  alerts = alerts.filter((a) => !(a.kind === kind && a.detail === friendly.detail));
  const id = nextId++;
  alerts = [...alerts, { id, kind, ...friendly }].slice(-3);
  emit();
  if (ttl > 0) setTimeout(() => notify.dismiss(id), ttl);
}

export const notify = {
  error: (message: string) => push('error', message, 0),
  warning: (message: string) => push('warning', message, 10_000),
  success: (message: string) => push('success', message, 4_000),
  info: (message: string) => push('info', message, 6_000),
  dismiss(id: number): void {
    alerts = alerts.filter((a) => a.id !== id);
    emit();
  },
  clear(): void {
    alerts = [];
    emit();
  },
};

export function useAlerts(): AlertItem[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => alerts,
  );
}
