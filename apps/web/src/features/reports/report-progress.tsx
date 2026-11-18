import { REPORT_STATUS_LABELS, type ReportDto, type ReportStatus } from '@thinkflow/shared';
import { Badge } from '../../components/ui/card';
import { isReportActive } from '../../lib/queries';

const TONES: Record<ReportStatus, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  queued: 'neutral',
  researching: 'accent',
  outlining: 'accent',
  writing: 'accent',
  assembling: 'accent',
  done: 'success',
  error: 'danger',
  canceled: 'warning',
};

export function ReportStatusBadge({ status }: { status: ReportStatus }) {
  return <Badge tone={TONES[status]}>{REPORT_STATUS_LABELS[status]}</Badge>;
}

/** Progress bar + label of a running job; renders nothing once the job finished. Reusable in chat. */
export function ReportProgressBar({ report }: { report: Pick<ReportDto, 'status' | 'progress'> }) {
  if (!isReportActive(report.status)) return null;
  const { current, total, label } = report.progress;
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const text = label || REPORT_STATUS_LABELS[report.status];
  return (
    <div className="min-w-0">
      <div
        role="progressbar"
        aria-label="Progresso da geração"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={text}
        className="h-1.5 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${total > 0 ? Math.max(percent, 4) : 8}%` }}
        />
      </div>
      <p className="mt-1 truncate text-xs text-muted">{text}</p>
    </div>
  );
}
