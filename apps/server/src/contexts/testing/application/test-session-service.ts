import {
  noteCreateSchema,
  sessionMode,
  stepReorderSchema,
  stepSchema,
  stepUpdateSchema,
  testDataUpdateSchema,
  TEST_LIMITS,
  testSessionCreateSchema,
  testSessionUpdateSchema,
  useCaseCreateSchema,
  type RecordingMode,
  type TestRunDto,
  type TestSessionDto,
  type TestStepDownloadDto,
  type TestStepImageDto,
  type TestSessionState,
  type TestSessionSummaryDto,
  type TestStep,
  type TestSupportDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { DomainError, NotFoundError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import type { DisplaySupport, TestImageStore, TestSessionRepository } from '../domain/ports';
import {
  newDefinition,
  type TestEvidence,
  type TestRun,
  type TestSession,
} from '../domain/session';
import { updateData } from '../domain/data';
import { planRerun, toRunDataDto } from '../domain/run-data';
import { pruneParameters } from '../domain/step-builder';
import { removeStepImage } from './step-images';

export const RECORDING_UNSUPPORTED_MESSAGE =
  'A gravação abre uma janela do navegador no computador onde o Thinkflow roda. Rode o servidor na sua máquina (pnpm dev ou pnpm start), não no Docker nem num servidor sem tela.';

/** How many runs the session page shows. */
const RUNS_SHOWN = 20;

export interface LiveSessionState {
  /** `idle` when nothing is happening with the session right now. */
  state(sessionId: string): TestSessionState;
  /** A pt-BR warning from the live recording (storage down, window closed…). */
  warning(sessionId: string): string | null;
  mode?(sessionId: string): RecordingMode | null;
}

export interface TestSessionServiceDeps {
  repo: TestSessionRepository;
  images: TestImageStore;
  display: DisplaySupport;
  clock: Clock;
  ids: IdGenerator;
  live?: LiveSessionState;
  onError?: (err: unknown) => void;
}

/** Keys start with the session id (`<session>/steps/<step>.jpg`); the URL carries the rest. */
export const imageUrl = (sessionId: string, key: string): string => {
  const rest = key.startsWith(`${sessionId}/`) ? key.slice(sessionId.length + 1) : key;
  return `/api/tests/sessions/${encodeURIComponent(sessionId)}/images/${rest
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
};

/** DTO of a step's image: `imageUrl` is the annotated render when there is one. */
export function toStepImageDto(e: TestEvidence): TestStepImageDto {
  return {
    id: e.id,
    sessionId: e.sessionId,
    stepId: e.stepId,
    seq: e.seq,
    at: e.at,
    width: e.width,
    height: e.height,
    annotations: e.annotations,
    crop: e.crop,
    annotated: e.annotatedKey !== null,
    comment: e.comment,
    include: e.include,
    updatedAt: e.updatedAt,
    originalUrl: imageUrl(e.sessionId, e.originalKey),
    imageUrl: imageUrl(e.sessionId, e.annotatedKey ?? e.originalKey),
  };
}

export function toRunDto(
  run: TestRun,
  session: TestSession | null,
  /** run id → `seq` of the session's runs (resolves "reprodução da execução #n"). */
  numbers: ReadonlyMap<string, number> = new Map(),
): TestRunDto {
  const dataSet = session?.definition.dataSets.find((d) => d.id === run.dataSetId) ?? null;
  const reproducible = session && (run.status === 'passed' || run.status === 'failed');
  return {
    id: run.id,
    sessionId: run.sessionId,
    seq: run.seq,
    rerunOf: run.rerunOf,
    rerunOfSeq: run.rerunOf ? (numbers.get(run.rerunOf) ?? null) : null,
    data: run.snapshot ? toRunDataDto(run.snapshot) : null,
    rerun: reproducible ? planRerun(run, session.definition, session.secrets).dto : null,
    dataSetId: run.dataSetId,
    dataSetName: dataSet?.name ?? null,
    status: run.status,
    headed: run.headed,
    results: run.results.map((r) => ({
      ...r,
      screenshotUrl: r.screenshotKey ? imageUrl(run.sessionId, r.screenshotKey) : null,
    })),
    error: run.error,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

export class TestSessionService {
  constructor(private readonly deps: TestSessionServiceDeps) {}

  support(): TestSupportDto {
    const supported = this.deps.display.canOpenWindow();
    return {
      recording: { supported, message: supported ? '' : RECORDING_UNSUPPORTED_MESSAGE },
    };
  }

  async list(): Promise<TestSessionSummaryDto[]> {
    const [sessions, counts, lastRuns] = await Promise.all([
      this.deps.repo.list(),
      this.deps.repo.evidenceCounts(),
      this.deps.repo.lastRuns(),
    ]);
    return sessions.map((s) => this.summary(s, counts.get(s.id) ?? 0, lastRuns.get(s.id) ?? null));
  }

  async require(id: string): Promise<TestSession> {
    const session = await this.deps.repo.find(id);
    if (!session) throw new NotFoundError('Sessão de teste');
    return session;
  }

  async get(id: string): Promise<TestSessionDto> {
    return this.toDto(await this.require(id));
  }

  async toDto(session: TestSession): Promise<TestSessionDto> {
    const [evidences, runs, downloads, numbers] = await Promise.all([
      this.deps.repo.evidences(session.id),
      this.deps.repo.runs(session.id, RUNS_SHOWN),
      this.deps.repo.downloads(session.id),
      this.deps.repo.runNumbers(session.id),
    ]);
    const stepIds = new Set(session.definition.steps.map((s) => s.id));
    const images: Record<string, TestStepImageDto> = {};
    for (const e of evidences) if (stepIds.has(e.stepId)) images[e.stepId] = toStepImageDto(e);
    const stepDownloads: Record<string, TestStepDownloadDto[]> = {};
    for (const d of [...downloads].reverse()) {
      if (d.status !== 'saved' || !d.stepId || !stepIds.has(d.stepId)) continue;
      (stepDownloads[d.stepId] ??= []).push({ id: d.id, fileName: d.fileName });
    }
    return {
      ...this.summary(session, Object.keys(images).length, runs[0] ?? null),
      definition: session.definition,
      runs: runs.map((r) => toRunDto(r, session, numbers)),
      images,
      downloadCount: downloads.length,
      stepDownloads,
      warning: this.deps.live?.warning(session.id) ?? null,
      recordingMode: this.deps.live?.mode?.(session.id) ?? null,
    };
  }

  async create(body: unknown): Promise<TestSessionDto> {
    const input = testSessionCreateSchema.parse(body);
    if ((await this.deps.repo.count()) >= TEST_LIMITS.maxSessions) {
      throw new DomainError(
        `Limite de ${TEST_LIMITS.maxSessions} sessões de teste atingido. Exclua sessões antigas.`,
        'too_many_test_sessions',
        400,
      );
    }
    const now = this.deps.clock.now();
    const session: TestSession = {
      id: this.deps.ids.next(),
      name: input.name,
      startUrl: input.startUrl,
      definition: newDefinition({
        viewport: input.viewport,
        autoThumbnails: input.autoThumbnails,
      }),
      secrets: {},
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repo.save(session);
    return this.toDto(session);
  }

  async update(id: string, body: unknown): Promise<TestSessionDto> {
    const input = testSessionUpdateSchema.parse(body);
    const session = await this.require(id);
    this.assertIdle(session.id);
    const updated: TestSession = {
      ...session,
      name: input.name ?? session.name,
      startUrl: input.startUrl ?? session.startUrl,
      definition: {
        ...session.definition,
        viewport: input.viewport ?? session.definition.viewport,
        autoThumbnails: input.autoThumbnails ?? session.definition.autoThumbnails,
      },
      updatedAt: this.deps.clock.now(),
    };
    await this.deps.repo.save(updated);
    return this.toDto(updated);
  }

  async delete(id: string): Promise<void> {
    const session = await this.require(id);
    this.assertIdle(session.id);
    // images first: with the storage down the session stays and the user retries later
    await this.deps.images.deleteSession(session.id);
    await this.deps.repo.delete(session.id);
  }

  async updateStep(id: string, stepId: string, body: unknown): Promise<TestSessionDto> {
    const input = stepUpdateSchema.parse(body);
    const session = await this.require(id);
    this.assertIdle(session.id);
    const def = session.definition;
    const step = def.steps.find((s) => s.id === stepId);
    if (!step) throw new NotFoundError('Passo');
    if (
      input.value &&
      'param' in input.value &&
      !def.parameters.some((p) => p.id === (input.value as { param: string }).param)
    ) {
      throw new DomainError('Parâmetro inexistente', 'unknown_parameter', 400);
    }
    const next: TestStep = stepSchema.parse({
      ...step,
      ...(input.title !== undefined && step.kind !== 'note' && step.kind !== 'usecase'
        ? { title: input.title?.trim() || null }
        : {}),
      ...(input.comment !== undefined ? { comment: input.comment?.trim() || null } : {}),
      ...(input.commentIsCode !== undefined && step.kind !== 'usecase'
        ? { commentIsCode: input.commentIsCode || undefined }
        : {}),
      ...(input.useCase !== undefined && step.kind === 'usecase'
        ? { useCase: { title: input.useCase.title, status: input.useCase.status } }
        : {}),
      ...(input.value !== undefined && (step.kind === 'fill' || step.kind === 'select')
        ? { value: input.value }
        : {}),
      ...(input.url !== undefined && step.kind === 'goto' ? { url: input.url } : {}),
      ...(input.key !== undefined && step.kind === 'press' ? { key: input.key } : {}),
      ...(input.assertion !== undefined && step.kind === 'assert'
        ? { assertion: input.assertion }
        : {}),
      ...(input.locators !== undefined && step.target
        ? { target: { ...step.target, locators: input.locators } }
        : {}),
    });
    const pruned = pruneParameters({
      definition: { ...def, steps: def.steps.map((s) => (s.id === stepId ? next : s)) },
      secrets: session.secrets,
    });
    return this.saveAndReturn({ ...session, ...pruned });
  }

  async deleteStep(id: string, stepId: string): Promise<TestSessionDto> {
    const session = await this.require(id);
    this.assertIdle(session.id);
    const step = session.definition.steps.find((s) => s.id === stepId);
    if (!step) throw new NotFoundError('Passo');
    const pruned = pruneParameters({
      definition: {
        ...session.definition,
        steps: session.definition.steps.filter((s) => s.id !== stepId),
      },
      secrets: session.secrets,
    });
    // the print belongs to the step: it goes with it
    for (const e of await this.deps.repo.evidences(session.id)) {
      if (e.stepId === stepId) {
        await removeStepImage(this.deps, e).catch((err: unknown) => this.deps.onError?.(err));
      }
    }
    return this.saveAndReturn({ ...session, ...pruned });
  }

  async reorderSteps(id: string, body: unknown): Promise<TestSessionDto> {
    const { ids } = stepReorderSchema.parse(body);
    const session = await this.require(id);
    this.assertIdle(session.id);
    const byId = new Map(session.definition.steps.map((s) => [s.id, s]));
    if (
      ids.length !== byId.size ||
      new Set(ids).size !== ids.length ||
      ids.some((x) => !byId.has(x))
    ) {
      throw new DomainError(
        'A nova ordem deve conter todos os passos, uma vez cada.',
        'bad_order',
        400,
      );
    }
    return this.saveAndReturn({
      ...session,
      definition: { ...session.definition, steps: ids.map((x) => byId.get(x)!) },
    });
  }

  async addNote(id: string, body: unknown): Promise<TestSessionDto> {
    const input = noteCreateSchema.parse(body);
    const session = await this.require(id);
    this.assertIdle(session.id);
    const steps = session.definition.steps;
    if (steps.length >= TEST_LIMITS.maxSteps) {
      throw new DomainError(
        `Limite de ${TEST_LIMITS.maxSteps} passos atingido.`,
        'too_many_steps',
        400,
      );
    }
    const note: TestStep = stepSchema.parse({
      id: this.deps.ids.next(),
      at: this.deps.clock.now(),
      kind: 'note',
      comment: input.comment,
    });
    const index = input.afterStepId ? steps.findIndex((s) => s.id === input.afterStepId) : -1;
    if (input.afterStepId && index < 0) throw new NotFoundError('Passo');
    const next =
      index < 0
        ? [...steps, note]
        : [...steps.slice(0, index + 1), note, ...steps.slice(index + 1)];
    return this.saveAndReturn({ ...session, definition: { ...session.definition, steps: next } });
  }

  /** A "Caso de Uso" divider of the CT document: before a step, or at the end. */
  async addUseCase(id: string, body: unknown): Promise<TestSessionDto> {
    const input = useCaseCreateSchema.parse(body);
    const session = await this.require(id);
    this.assertIdle(session.id);
    const steps = session.definition.steps;
    if (steps.length >= TEST_LIMITS.maxSteps) {
      throw new DomainError(
        `Limite de ${TEST_LIMITS.maxSteps} passos atingido.`,
        'too_many_steps',
        400,
      );
    }
    const divider: TestStep = stepSchema.parse({
      id: this.deps.ids.next(),
      at: this.deps.clock.now(),
      kind: 'usecase',
      useCase: { title: input.title, status: input.status || 'Finalizado' },
    });
    const index = input.beforeStepId ? steps.findIndex((s) => s.id === input.beforeStepId) : -1;
    if (input.beforeStepId && index < 0) throw new NotFoundError('Passo');
    const next =
      index < 0 ? [...steps, divider] : [...steps.slice(0, index), divider, ...steps.slice(index)];
    return this.saveAndReturn({ ...session, definition: { ...session.definition, steps: next } });
  }

  /** The "Dados" table: parameter names/labels/secrecy and the data sets with their values. */
  async updateData(id: string, body: unknown): Promise<TestSessionDto> {
    const input = testDataUpdateSchema.parse(body);
    const session = await this.require(id);
    this.assertIdle(session.id);
    return this.saveAndReturn({ ...session, ...updateData(session, input) });
  }

  private async saveAndReturn(session: TestSession): Promise<TestSessionDto> {
    const updated = { ...session, updatedAt: this.deps.clock.now() };
    await this.deps.repo.save(updated);
    return this.toDto(updated);
  }

  /** Editing while the browser records or a replay runs would race with them. */
  assertIdle(sessionId: string): void {
    const state = this.deps.live?.state(sessionId) ?? 'idle';
    if (state !== 'idle') {
      throw new DomainError(
        state === 'running'
          ? 'Aguarde a execução terminar (ou cancele) para alterar a sessão.'
          : 'Pare a gravação para alterar a sessão.',
        'test_session_busy',
        409,
      );
    }
  }

  private summary(
    s: TestSession,
    imageCount: number,
    lastRun: TestRun | null,
  ): TestSessionSummaryDto {
    return {
      id: s.id,
      name: s.name,
      startUrl: s.startUrl,
      state: this.deps.live?.state(s.id) ?? 'idle',
      stepCount: s.definition.steps.length,
      imageCount,
      mode: sessionMode(s.definition),
      lastRun: lastRun ? { status: lastRun.status, finishedAt: lastRun.finishedAt } : null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }
}
