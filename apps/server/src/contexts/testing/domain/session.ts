import {
  DEFAULT_TEST_VIEWPORT,
  type TestAnnotation,
  type TestCrop,
  type TestDefinition,
  type TestRunStatus,
  type TestSessionMode,
  type TestStepResult,
  type TestViewport,
} from '@thinkflow/shared';

/** parameter id → value, per data set id. Never leaves the server in clear text. */
export type SessionSecrets = Record<string, Record<string, string>>;

export interface TestSession {
  id: string;
  name: string;
  startUrl: string;
  definition: TestDefinition;
  secrets: SessionSecrets;
  createdAt: number;
  updatedAt: number;
}

/**
 * The image of a step (persisted in `test_evidences`): at most one per step. Automatic prints of
 * recorded steps and manual prints of `capture` steps share this model (original, annotations,
 * annotated render, crop, comment, whether it goes into the document).
 */
export interface TestEvidence {
  id: string;
  sessionId: string;
  stepId: string;
  seq: number;
  at: number;
  width: number;
  height: number;
  originalKey: string;
  annotatedKey: string | null;
  annotations: TestAnnotation[];
  /** Selected area kept in the annotated image; null = the whole screenshot. */
  crop: TestCrop | null;
  comment: string;
  include: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * The data a run used (resolved when the run was created), so reproducing it later does not depend
 * on edits to the data sets. Secret values are encrypted at rest and never leave the server.
 */
export interface RunDataSnapshot {
  dataSetName: string;
  parameters: { id: string; label: string; secret: boolean }[];
  /** Non-secret values by parameter id. */
  values: Record<string, string>;
  /** Secret values by parameter id. */
  secrets: Record<string, string>;
}

export interface TestRun {
  id: string;
  sessionId: string;
  /** Order in the session (1 = first). */
  seq: number;
  /** The run this one reproduces. */
  rerunOf: string | null;
  /** Null for runs made before the data was kept. */
  snapshot: RunDataSnapshot | null;
  dataSetId: string | null;
  status: TestRunStatus;
  headed: boolean;
  results: TestStepResult[];
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export const RECORDED_DATA_SET_ID = 'recorded';

export function newDefinition(options: {
  viewport?: TestViewport;
  autoThumbnails?: boolean;
  mode?: TestSessionMode;
}): TestDefinition {
  return {
    schemaVersion: 1,
    viewport: options.viewport ?? DEFAULT_TEST_VIEWPORT,
    ...(options.mode ? { mode: options.mode } : {}),
    autoThumbnails: options.autoThumbnails ?? true,
    parameters: [],
    // the first data set holds the values typed while recording
    dataSets: [{ id: RECORDED_DATA_SET_ID, name: 'Gravado', values: {} }],
    steps: [],
  };
}

export const isFinishedRun = (status: TestRunStatus): boolean =>
  status === 'passed' || status === 'failed' || status === 'error' || status === 'canceled';

/** Object keys inside the `tests/` namespace (ids are app-generated uuids). */
export const testKeys = {
  session: (sessionId: string) => `${sessionId}/`,
  original: (sessionId: string, evidenceId: string) =>
    `${sessionId}/evidences/${evidenceId}/original.png`,
  annotated: (sessionId: string, evidenceId: string) =>
    `${sessionId}/evidences/${evidenceId}/annotated.png`,
  runShot: (sessionId: string, runId: string, stepId: string) =>
    `${sessionId}/runs/${runId}/${stepId}.png`,
  /** `fileName` already reduced to lowercase ASCII (`storageFileName`). */
  download: (sessionId: string, downloadId: string, fileName: string) =>
    `${sessionId}/downloads/${downloadId}/${fileName}`,
};

/** A key always belongs to one session: used to refuse image requests across sessions. */
export const keyBelongsTo = (key: string, sessionId: string): boolean =>
  key.startsWith(`${sessionId}/`) && !key.includes('..');
