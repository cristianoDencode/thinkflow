import { z } from 'zod';
import { ctFieldsSchema, useCaseInfoSchema } from './ct-fields';

/*
 * Test sessions ("Testes"): a recorded browser session (Playwright) with annotated evidence,
 * editable data and replays, that compiles into an evidence document and a Playwright spec.
 *
 * `TestDefinition` is the canonical, versioned JSON of a session (steps, parameters, data sets).
 * Secret values (passwords, tokens) never travel in it: data sets carry `{ "$secret": true }`
 * markers and the values live encrypted on the server.
 */

export const TEST_LIMITS = {
  maxSessions: 500,
  maxSteps: 500,
  maxParameters: 100,
  maxDataSets: 50,
  maxNameChars: 200,
  maxUrlChars: 2_000,
  maxCommentChars: 4_000,
  maxValueChars: 10_000,
  maxTextChars: 1_000,
  maxLocators: 8,
  maxAnnotations: 300,
  /** Annotated PNG uploaded by the editor. */
  maxImageBytes: 15 * 1024 * 1024,
  /** A file downloaded in the recorded/replayed browser: bigger ones are listed, not stored. */
  maxDownloadBytes: 100 * 1024 * 1024,
  /** Downloads kept per session (the oldest must be deleted to capture more). */
  maxDownloadsPerSession: 500,
} as const;

const name = z.string().trim().min(1).max(TEST_LIMITS.maxNameChars);
const text = z.string().max(TEST_LIMITS.maxTextChars);
const id = z.string().trim().min(1).max(100);

export const httpUrlSchema = z
  .string()
  .trim()
  .max(TEST_LIMITS.maxUrlChars)
  .url('Informe uma URL válida (http ou https)')
  .refine((u) => /^https?:\/\//i.test(u), 'A URL deve começar com http:// ou https://');

/* ---------------------------------------------------------------- locators ---- */

/**
 * How to find an element again, best first. Each kind maps to a public Playwright locator
 * (`getByTestId`, `getByRole`, `getByLabel`, `getByPlaceholder`, `getByText`, `getByAltText`,
 * `getByTitle`, `locator(css)`).
 */
export const locatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('testid'), value: text.min(1) }),
  z.object({ kind: z.literal('role'), role: z.string().min(1).max(40), name: text }),
  z.object({ kind: z.literal('label'), text: text.min(1) }),
  z.object({ kind: z.literal('placeholder'), text: text.min(1) }),
  z.object({ kind: z.literal('text'), text: text.min(1) }),
  z.object({ kind: z.literal('alt'), text: text.min(1) }),
  z.object({ kind: z.literal('title'), text: text.min(1) }),
  z.object({ kind: z.literal('css'), selector: text.min(1) }),
]);
export type TestLocator = z.infer<typeof locatorSchema>;

/** Element box as a fraction of the viewport (0..1), for the highlight drawn over thumbnails. */
const clampedNumber = (min: number, max: number) =>
  z
    .number()
    .finite()
    .transform((n) => Math.min(max, Math.max(min, n)));
/** Out-of-range values (elements taller/wider than the viewport) are clamped, never rejected. */
export const bboxSchema = z.object({
  x: clampedNumber(-1, 2),
  y: clampedNumber(-1, 2),
  w: clampedNumber(0, 2),
  h: clampedNumber(0, 2),
});
export type TestBBox = z.infer<typeof bboxSchema>;

export const targetSchema = z.object({
  locators: z.array(locatorSchema).min(1).max(TEST_LIMITS.maxLocators),
  /** pt-BR, for people: "campo E-mail", "botão Entrar". */
  description: text,
  bbox: bboxSchema.nullable().default(null),
  /** Set when the element lives inside an iframe. */
  frameUrl: z.string().max(TEST_LIMITS.maxUrlChars).nullable().default(null),
});
export type TestTarget = z.infer<typeof targetSchema>;

/** A literal value, or a reference to a parameter (`parameters[].id`) resolved per data set. */
export const stepValueSchema = z.union([
  z.object({ literal: z.string().max(TEST_LIMITS.maxValueChars) }),
  z.object({ param: id }),
]);
export type TestStepValue = z.infer<typeof stepValueSchema>;

export const assertionSchema = z.discriminatedUnion('type', [
  /** Some text is visible anywhere on the page. */
  z.object({ type: z.literal('textVisible'), text: text.min(1) }),
  /** The step's target is visible. */
  z.object({ type: z.literal('visible') }),
  /** The step's target (input/select) has this value. */
  z.object({ type: z.literal('value'), value: stepValueSchema }),
  z.object({ type: z.literal('urlContains'), text: text.min(1) }),
  z.object({ type: z.literal('title'), text: text.min(1) }),
]);
export type TestAssertion = z.infer<typeof assertionSchema>;
export type TestAssertionType = TestAssertion['type'];

export const ASSERTION_LABELS: Record<TestAssertionType, string> = {
  textVisible: 'Texto visível',
  visible: 'Elemento visível',
  value: 'Valor do campo',
  urlContains: 'URL contém',
  title: 'Título da página',
};

/* ------------------------------------------------------------------- steps ---- */

export const stepKindSchema = z.enum([
  'goto',
  'click',
  'dblclick',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'assert',
  'note',
  /** A manual print (mode "Só prints"): documents a screen, nothing to replay. */
  'capture',
  /**
   * "Verificar" while recording steps: a print of the whole window at that moment. Replays pass it
   * without interacting (and keep a screenshot of the moment); the document shows its print.
   */
  'checkpoint',
  /** Starts a use case of the CT document (title + status); nothing to replay. */
  'usecase',
]);
export type TestStepKind = z.infer<typeof stepKindSchema>;

export const STEP_KIND_LABELS: Record<TestStepKind, string> = {
  goto: 'Abrir página',
  click: 'Clicar',
  dblclick: 'Clicar duas vezes',
  fill: 'Preencher',
  select: 'Selecionar',
  check: 'Marcar',
  uncheck: 'Desmarcar',
  press: 'Pressionar tecla',
  assert: 'Verificar',
  note: 'Anotação',
  capture: 'Print da tela',
  checkpoint: 'Verificação',
  usecase: 'Caso de Uso',
};

/** Kinds that act on an element (need `target`). */
export const TARGETED_STEP_KINDS: readonly TestStepKind[] = [
  'click',
  'dblclick',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
];

/** Longest custom step title. */
export const STEP_TITLE_MAX_CHARS = 300;

export const stepSchema = z
  .object({
    id,
    /** Epoch ms when it was recorded. */
    at: z.number().int().nonnegative(),
    kind: stepKindSchema,
    /** `goto`. */
    url: z.string().max(TEST_LIMITS.maxUrlChars).optional(),
    target: targetSchema.nullable().default(null),
    /** `fill` / `select`. */
    value: stepValueSchema.optional(),
    /** `press`: a Playwright key name (`Enter`, `Tab`, `Escape`…). */
    key: z.string().max(40).optional(),
    assertion: assertionSchema.optional(),
    /** Page where it happened. */
    page: z
      .object({
        url: z.string().max(TEST_LIMITS.maxUrlChars),
        title: z.string().max(TEST_LIMITS.maxTextChars),
      })
      .nullable()
      .default(null),
    /** Custom title typed by the user (null = the generated one, see `stepTitle`). */
    title: z.string().trim().max(STEP_TITLE_MAX_CHARS).nullable().optional(),
    comment: z.string().max(TEST_LIMITS.maxCommentChars).nullable().default(null),
    /** The comment is code/SQL: the CT document shows it as a code block. */
    commentIsCode: z.boolean().optional(),
    /** `usecase`: title (blank = "Caso de Uso N") and status. */
    useCase: useCaseInfoSchema.optional(),
  })
  .superRefine((step, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (step.kind === 'usecase' && !step.useCase) issue('Caso de uso sem título/status');
    if (step.kind === 'goto' && !step.url) issue('Passo "goto" exige url');
    if (TARGETED_STEP_KINDS.includes(step.kind) && !step.target) issue('Passo exige um elemento');
    if ((step.kind === 'fill' || step.kind === 'select') && !step.value) issue('Passo exige valor');
    if (step.kind === 'press' && !step.key) issue('Passo "press" exige a tecla');
    if (step.kind === 'assert') {
      if (!step.assertion) issue('Verificação sem tipo');
      else if (
        (step.assertion.type === 'visible' || step.assertion.type === 'value') &&
        !step.target
      )
        issue('Esta verificação exige um elemento');
    }
  });
export type TestStep = z.infer<typeof stepSchema>;

/* ------------------------------------------------------ parameters & data ---- */

export const parameterTypeSchema = z.enum(['text', 'password', 'option', 'boolean']);
export type TestParameterType = z.infer<typeof parameterTypeSchema>;

export const parameterSchema = z.object({
  id,
  /** Identifier used in the spec (`dados.email`) and the env vars of secrets (`TF_EMAIL`). */
  name: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]{0,49}$/,
      'Use letras minúsculas, números e _ (ex.: email, cpf_titular)',
    ),
  label: text.min(1),
  type: parameterTypeSchema,
  secret: z.boolean(),
});
export type TestParameter = z.infer<typeof parameterSchema>;

/** Marks a secret value that is stored encrypted on the server. */
export const SECRET_MARKER = { $secret: true } as const;
export const dataValueSchema = z.union([
  z.string().max(TEST_LIMITS.maxValueChars),
  z.object({ $secret: z.literal(true) }),
]);
export type TestDataValue = z.infer<typeof dataValueSchema>;

export const dataSetSchema = z.object({
  id,
  name,
  /** parameter id → value (missing = the parameter's recorded value). */
  values: z.record(id, dataValueSchema),
});
export type TestDataSet = z.infer<typeof dataSetSchema>;

export const viewportSchema = z.object({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(240).max(2160),
});
export type TestViewport = z.infer<typeof viewportSchema>;
export const DEFAULT_TEST_VIEWPORT: TestViewport = { width: 1366, height: 768 };

/**
 * How a session is recorded, fixed when the recording starts the first time and never switched:
 * `record` = every action becomes a step with an automatic print; `capture` = nothing the user
 * does becomes a step, only manual prints ("Só prints").
 */
export const sessionModeSchema = z.enum(['record', 'capture']);
export type TestSessionMode = z.infer<typeof sessionModeSchema>;

export const SESSION_MODE_LABELS: Record<TestSessionMode, string> = {
  record: 'Gravar passos',
  capture: 'Só prints',
};

export const testDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  viewport: viewportSchema,
  /** Chosen when the recording starts; absent in sessions created before modes existed. */
  mode: sessionModeSchema.optional(),
  /** Automatic print after every recorded step (mode `record`). */
  autoThumbnails: z.boolean(),
  parameters: z.array(parameterSchema).max(TEST_LIMITS.maxParameters),
  /** The first one holds the recorded values. */
  dataSets: z.array(dataSetSchema).max(TEST_LIMITS.maxDataSets),
  steps: z.array(stepSchema).max(TEST_LIMITS.maxSteps),
  /** Fields of the "Caso de Teste CT" document (absent until the Documento tab saves them). */
  ct: ctFieldsSchema.optional(),
});
export type TestDefinition = z.infer<typeof testDefinitionSchema>;

/** Steps a replay (and the generated spec) acts on; notes and prints are only documentation. */
export const isReplayableStep = (step: Pick<TestStep, 'kind'>): boolean =>
  step.kind !== 'note' && step.kind !== 'capture' && step.kind !== 'usecase';

/**
 * Steps that act on the page (or check it). A `checkpoint` is replayed (it keeps a screenshot of
 * the moment) but interacts with nothing, so a session made only of checkpoints has nothing to run.
 */
export const isInteractionStep = (step: Pick<TestStep, 'kind'>): boolean =>
  isReplayableStep(step) && step.kind !== 'checkpoint';

/** Notes and use-case dividers only structure the document: they never lock the session's mode. */
export const isStructuralStep = (step: Pick<TestStep, 'kind'>): boolean =>
  step.kind === 'note' || step.kind === 'usecase';

/**
 * The mode of a session: the stored one, or, for older sessions, inferred from the steps (any
 * replayable step = `record`, only prints = `capture`). `null` while nothing was recorded yet:
 * the user still chooses.
 */
export function sessionMode(def: Pick<TestDefinition, 'mode' | 'steps'>): TestSessionMode | null {
  if (def.mode) return def.mode;
  if (def.steps.some(isReplayableStep)) return 'record';
  if (def.steps.some((s) => s.kind === 'capture')) return 'capture';
  return null;
}

/* ---------------------------------------------------------------- evidence ---- */

/** Stroke width / text scale chosen in the editor (image pixels for strokes); absent = default. */
const annotationSize = z.number().min(1).max(40).optional();

/** Area of the screenshot kept in the evidence (fractions of the original image). */
export const cropSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});
export type TestCrop = z.infer<typeof cropSchema>;

/** Shapes drawn over a screenshot; coordinates are fractions of the image (0..1). */
export const annotationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('rect'),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    color: z.string().max(20),
    size: annotationSize,
  }),
  z.object({
    type: z.literal('ellipse'),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    color: z.string().max(20),
    size: annotationSize,
  }),
  z.object({
    type: z.literal('line'),
    /** x1, y1, x2, y2 */
    points: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    color: z.string().max(20),
    size: annotationSize,
  }),
  z.object({
    type: z.literal('pen'),
    /** x1, y1, x2, y2, ... (freehand stroke) */
    points: z
      .array(z.number())
      .min(4)
      .max(4000)
      .refine((p) => p.length % 2 === 0, 'pares x,y'),
    color: z.string().max(20),
    size: annotationSize,
  }),
  z.object({
    type: z.literal('highlight'),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    color: z.string().max(20),
  }),
  z.object({
    type: z.literal('pixelate'),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }),
  z.object({
    type: z.literal('arrow'),
    /** x1, y1, x2, y2 */
    points: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    color: z.string().max(20),
    size: annotationSize,
  }),
  z.object({
    type: z.literal('badge'),
    x: z.number(),
    y: z.number(),
    n: z.number().int().min(1).max(999),
    color: z.string().max(20),
    size: annotationSize,
  }),
  z.object({
    type: z.literal('text'),
    x: z.number(),
    y: z.number(),
    text: z.string().min(1).max(500),
    color: z.string().max(20),
    size: annotationSize,
  }),
]);
export type TestAnnotation = z.infer<typeof annotationSchema>;

/**
 * The image of a step (one at most): the automatic print of a recorded step or the manual print
 * of a `capture` step, with its annotations, comment and whether it goes into the document.
 */
export interface TestStepImageDto {
  id: string;
  sessionId: string;
  /** The step the image belongs to. */
  stepId: string;
  seq: number;
  at: number;
  width: number;
  height: number;
  annotations: TestAnnotation[];
  /** Selected area (the annotated image is cropped to it); null = the whole screenshot. */
  crop: TestCrop | null;
  annotated: boolean;
  comment: string;
  include: boolean;
  /** Changes on every save (cache-busting of the annotated image). */
  updatedAt: number;
  /** `GET` URLs (same origin, authenticated). */
  originalUrl: string;
  imageUrl: string;
}

export const evidenceUpdateSchema = z.object({
  annotations: z.array(annotationSchema).max(TEST_LIMITS.maxAnnotations).optional(),
  crop: cropSchema.nullable().optional(),
  comment: z.string().max(TEST_LIMITS.maxCommentChars).optional(),
  include: z.boolean().optional(),
});
export type EvidenceUpdateInput = z.infer<typeof evidenceUpdateSchema>;

/* -------------------------------------------------------------------- runs ---- */

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'passed',
  'failed',
  'error',
  'canceled',
]);
export type TestRunStatus = z.infer<typeof runStatusSchema>;

export const RUN_STATUS_LABELS: Record<TestRunStatus, string> = {
  queued: 'Na fila',
  running: 'Executando',
  passed: 'Passou',
  failed: 'Falhou',
  error: 'Erro',
  canceled: 'Cancelada',
};

export const stepResultSchema = z.object({
  stepId: id,
  status: z.enum(['passed', 'failed', 'skipped']),
  durationMs: z.number().int().nonnegative(),
  error: z.string().max(2_000).nullable(),
  /** Index in `target.locators` that found the element. */
  locatorUsed: z.number().int().nonnegative().nullable(),
  screenshotKey: z.string().max(300).nullable(),
});
export type TestStepResult = z.infer<typeof stepResultSchema>;

/** The data a run used, as stored with it: secret values stay on the server (never in a DTO). */
export const runSnapshotSchema = z.object({
  dataSetName: z.string().max(TEST_LIMITS.maxNameChars),
  parameters: z
    .array(z.object({ id, label: z.string().max(TEST_LIMITS.maxNameChars), secret: z.boolean() }))
    .max(TEST_LIMITS.maxParameters),
  /** Non-secret values by parameter id. */
  values: z.record(z.string(), z.string().max(TEST_LIMITS.maxValueChars)),
});
export type TestRunSnapshot = z.infer<typeof runSnapshotSchema>;

/** The data of a run for the screen: secret values come masked (`value: null`). */
export interface TestRunDataDto {
  dataSetName: string;
  entries: { paramId: string; label: string; secret: boolean; value: string | null }[];
}

/** What "Reproduzir esta execução" would do with the run (finished runs only). */
export interface TestRunRerunDto {
  /** `snapshot`: the data the run used. `current`: the run kept none (old run): today's values. */
  source: 'snapshot' | 'current';
  /** pt-BR; says that the values are today's (old runs), or why the rerun is impossible. */
  notice: string | null;
  /** pt-BR; things that changed since the run (data set or parameters). */
  warnings: string[];
  /** False when there is nothing to reproduce it with (old run whose data set was removed). */
  possible: boolean;
}

export interface TestRunDto {
  id: string;
  sessionId: string;
  /** Order of the run in its session (1 = the first one). */
  seq: number;
  /** The run this one reproduces. */
  rerunOf: string | null;
  /** Number (`seq`) of the run this one reproduces, when it still exists. */
  rerunOfSeq: number | null;
  /** The data the run used; null for runs made before the data was kept. */
  data: TestRunDataDto | null;
  rerun: TestRunRerunDto | null;
  dataSetId: string | null;
  dataSetName: string | null;
  status: TestRunStatus;
  headed: boolean;
  results: (TestStepResult & { screenshotUrl: string | null })[];
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export const runCreateSchema = z.object({
  /**
   * Reproduces this finished run with exactly the data it used (`dataSetId` is ignored); runs made
   * before the data was kept use today's values of their data set.
   */
  rerunOf: id.nullable().default(null),
  /** One data set, or all of them in sequence (`null`). */
  dataSetId: id.nullable().default(null),
  /** Shows the browser while it runs (needs a screen on the server). */
  headed: z.boolean().default(false),
});
export type RunCreateInput = z.infer<typeof runCreateSchema>;

/* --------------------------------------------------------------- downloads ---- */

/**
 * Files the browser downloaded while recording or replaying. They live in the object storage,
 * linked to the step that triggered them (and, for replays, the run); they are a history of the
 * test and never part of the document.
 */
export const downloadSourceSchema = z.enum(['recording', 'replay']);
export type TestDownloadSource = z.infer<typeof downloadSourceSchema>;

/** `saved`: the file is stored; `failed`: the download did not finish; `skipped`: too big. */
export const downloadStatusSchema = z.enum(['saved', 'failed', 'skipped']);
export type TestDownloadStatus = z.infer<typeof downloadStatusSchema>;

export const DOWNLOAD_SOURCE_LABELS: Record<TestDownloadSource, string> = {
  recording: 'Gravação',
  replay: 'Replay',
};

export const DOWNLOAD_STATUS_LABELS: Record<TestDownloadStatus, string> = {
  saved: 'Salvo',
  failed: 'Falhou',
  skipped: 'Não salvo',
};

export interface TestDownloadDto {
  id: string;
  sessionId: string;
  /** The step that triggered it; null = "sem passo" (or the step was removed later). */
  stepId: string | null;
  /** Set for replays. */
  runId: string | null;
  /** Number of that run in its session (see `TestRunDto.seq`). */
  runSeq: number | null;
  source: TestDownloadSource;
  /** Sanitized name suggested by the page. */
  fileName: string;
  size: number;
  contentType: string;
  /** Origin and path of the download (no query string). */
  url: string;
  status: TestDownloadStatus;
  /** pt-BR, when not `saved`. */
  reason: string | null;
  createdAt: number;
  /** `GET` URL of the file (same origin, authenticated); null unless `saved`. */
  fileUrl: string | null;
}

/** Filters of `GET /api/tests/sessions/:id/downloads`. */
export const downloadListQuerySchema = z.object({
  source: downloadSourceSchema.optional(),
  runId: id.optional(),
});

/** A step's downloaded files (the chip in the steps list). */
export interface TestStepDownloadDto {
  id: string;
  fileName: string;
}

/* ---------------------------------------------------------------- sessions ---- */

/** Live state: `recording`/`paused` while the browser window is open, `running` during a replay. */
export type TestSessionState = 'idle' | 'recording' | 'paused' | 'running';

export interface TestSessionSummaryDto {
  id: string;
  name: string;
  startUrl: string;
  state: TestSessionState;
  stepCount: number;
  /** Steps that have a print. */
  imageCount: number;
  /** Fixed mode (stored or inferred); null while the session has no steps. */
  mode: TestSessionMode | null;
  lastRun: { status: TestRunStatus; finishedAt: number | null } | null;
  createdAt: number;
  updatedAt: number;
}

export interface TestSessionDto extends TestSessionSummaryDto {
  /** Secret values come as `{ "$secret": true }`. */
  definition: TestDefinition;
  runs: TestRunDto[];
  /** Step id → its print. */
  images: Record<string, TestStepImageDto>;
  /** Files downloaded while recording or replaying (every status). */
  downloadCount: number;
  /** Step id → the files it downloaded (saved ones, newest last). */
  stepDownloads: Record<string, TestStepDownloadDto[]>;
  /** Shown while recording (storage down, browser closed…). */
  warning: string | null;
  /**
   * While recording: `record` = actions become steps; `capture` = only manual prints (the
   * session's mode `capture`).
   */
  recordingMode: RecordingMode | null;
}

export type RecordingMode = 'record' | 'capture';

export const testSessionCreateSchema = z.object({
  name,
  startUrl: httpUrlSchema,
  autoThumbnails: z.boolean().default(true),
  viewport: viewportSchema.default(DEFAULT_TEST_VIEWPORT),
});
export type TestSessionCreateInput = z.infer<typeof testSessionCreateSchema>;
export type TestSessionCreatePayload = z.input<typeof testSessionCreateSchema>;

export const testSessionUpdateSchema = z.object({
  name: name.optional(),
  startUrl: httpUrlSchema.optional(),
  autoThumbnails: z.boolean().optional(),
  viewport: viewportSchema.optional(),
});
export type TestSessionUpdateInput = z.infer<typeof testSessionUpdateSchema>;

export const stepUpdateSchema = z.object({
  /** Custom title; empty or null goes back to the generated one. */
  title: z.string().max(STEP_TITLE_MAX_CHARS).nullable().optional(),
  comment: z.string().max(TEST_LIMITS.maxCommentChars).nullable().optional(),
  commentIsCode: z.boolean().optional(),
  /** `usecase` steps only. */
  useCase: useCaseInfoSchema.optional(),
  value: stepValueSchema.optional(),
  url: httpUrlSchema.optional(),
  key: z.string().min(1).max(40).optional(),
  assertion: assertionSchema.optional(),
  /** Reordered or trimmed list of the step's locators (best first). */
  locators: z.array(locatorSchema).min(1).max(TEST_LIMITS.maxLocators).optional(),
});
export type StepUpdateInput = z.infer<typeof stepUpdateSchema>;

export const stepReorderSchema = z.object({ ids: z.array(id).max(TEST_LIMITS.maxSteps) });

export const noteCreateSchema = z.object({
  comment: z.string().trim().min(1).max(TEST_LIMITS.maxCommentChars),
  /** Inserted after this step (end when omitted). */
  afterStepId: id.nullable().optional(),
});

/** A use-case divider (CT document); inserted before a step, or at the end. */
export const useCaseCreateSchema = z.object({
  title: z.string().trim().max(300).default(''),
  status: z.string().trim().max(300).default('Finalizado'),
  beforeStepId: id.nullable().optional(),
});

/** Parameters and data sets edited together (secret values: a string sets, the marker keeps). */
export const testDataUpdateSchema = z.object({
  parameters: z.array(parameterSchema).max(TEST_LIMITS.maxParameters),
  dataSets: z.array(dataSetSchema).min(1).max(TEST_LIMITS.maxDataSets),
});
export type TestDataUpdateInput = z.infer<typeof testDataUpdateSchema>;

export interface TestSupportDto {
  /** A browser window can be opened on the server (host with a screen, not a container). */
  recording: { supported: boolean; message: string };
}

export const TEST_SESSION_STATE_LABELS: Record<TestSessionState, string> = {
  idle: 'Parada',
  recording: 'Gravando',
  paused: 'Pausada',
  running: 'Executando',
};
