import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { notify, useAlerts, type AlertItem, type AlertKind } from '../../lib/notify';
import { cn } from '../../lib/utils';

const STYLE: Record<AlertKind, { box: string; icon: typeof Info }> = {
  error: { box: 'border-danger/30 bg-danger-soft text-danger', icon: CircleAlert },
  warning: { box: 'border-warning/30 bg-warning-soft text-warning', icon: TriangleAlert },
  success: { box: 'border-success/30 bg-success-soft text-success', icon: CircleCheck },
  info: { box: 'border-border bg-bg-elevated text-fg', icon: Info },
};

function AlertRow({ alert }: { alert: AlertItem }) {
  const [open, setOpen] = useState(false);
  const { box, icon: Icon } = STYLE[alert.kind];
  const hasDetail = alert.detail && alert.detail !== alert.title;
  return (
    <div
      role={alert.kind === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 shadow-lg',
        box,
      )}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold break-words">{alert.title}</p>
        {alert.hint && <p className="mt-0.5 break-words opacity-90">{alert.hint}</p>}
        {hasDetail && (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="mt-1 text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
            >
              {open ? 'Ocultar detalhes' : 'Ver detalhes'}
            </button>
            {open && (
              <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-black/10 p-2 text-xs whitespace-pre-wrap break-words">
                {alert.detail}
              </pre>
            )}
          </>
        )}
      </div>
      <button
        type="button"
        onClick={() => notify.dismiss(alert.id)}
        aria-label="Fechar alerta"
        className="rounded-md p-1 opacity-70 hover:opacity-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Bootstrap-style alerts pinned to the top of the viewport. */
export function AlertHost() {
  const alerts = useAlerts();
  if (alerts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] mx-auto flex w-full max-w-2xl flex-col gap-2 px-3">
      {alerts.map((a) => (
        <AlertRow key={a.id} alert={a} />
      ))}
    </div>
  );
}
