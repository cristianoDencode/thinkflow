import { MonitorX } from 'lucide-react';
import { useTestSupport } from '../../lib/queries';

/** Shown when this server cannot open a browser window (Docker, server without a screen). */
export function RecordingNotice() {
  const { data } = useTestSupport();
  if (!data || data.recording.supported) return null;
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-xl border border-transparent bg-warning-soft px-4 py-3 text-sm text-warning"
    >
      <MonitorX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">Gravação indisponível neste servidor</p>
        <p className="mt-0.5 text-fg">{data.recording.message}</p>
      </div>
    </div>
  );
}
