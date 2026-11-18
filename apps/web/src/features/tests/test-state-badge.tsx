import {
  RUN_STATUS_LABELS,
  TEST_SESSION_STATE_LABELS,
  type TestRunStatus,
  type TestSessionState,
} from '@thinkflow/shared';
import { Badge } from '../../components/ui/card';

const STATE_TONES: Record<TestSessionState, 'neutral' | 'accent' | 'warning' | 'danger'> = {
  idle: 'neutral',
  recording: 'danger',
  paused: 'warning',
  running: 'accent',
};

const RUN_TONES: Record<TestRunStatus, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  queued: 'neutral',
  running: 'accent',
  passed: 'success',
  failed: 'danger',
  error: 'warning',
  canceled: 'neutral',
};

export function SessionStateBadge({ state }: { state: TestSessionState }) {
  if (state === 'idle') return null;
  return <Badge tone={STATE_TONES[state]}>{TEST_SESSION_STATE_LABELS[state]}</Badge>;
}

export function RunStatusBadge({ status }: { status: TestRunStatus }) {
  return <Badge tone={RUN_TONES[status]}>{RUN_STATUS_LABELS[status]}</Badge>;
}
