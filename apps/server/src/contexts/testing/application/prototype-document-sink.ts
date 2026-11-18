import { stepSchema, TEST_LIMITS } from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { DomainError, NotFoundError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import type { TestImageStore, TestSessionRepository } from '../domain/ports';
import type { TestSession } from '../domain/session';
import { pngSize } from './evidence-service';
import { saveStepImage } from './step-images';

export interface PrototypeDocumentSinkDeps {
  repo: TestSessionRepository;
  images: TestImageStore;
  clock: Clock;
  ids: IdGenerator;
  /** Throws a 409 while the session records or replays (`TestSessionService.assertIdle`). */
  assertIdle(sessionId: string): void;
}

/**
 * Where a rendered prototype lands in the test-case document: a new `capture` step or the image
 * of an existing step. The prototypes context talks to this through its `DocumentStepSink` port.
 */
export class PrototypeDocumentSink {
  constructor(private readonly deps: PrototypeDocumentSinkDeps) {}

  private async session(id: string): Promise<TestSession> {
    const session = await this.deps.repo.find(id);
    if (!session) throw new NotFoundError('Sessão de teste');
    return session;
  }

  async check(input: { sessionId: string; stepId?: string; afterStepId?: string }): Promise<void> {
    const session = await this.session(input.sessionId);
    this.deps.assertIdle(session.id);
    const steps = session.definition.steps;
    for (const id of [input.stepId, input.afterStepId]) {
      if (id && !steps.some((s) => s.id === id)) throw new NotFoundError('Passo');
    }
  }

  async addCaptureStep(input: {
    sessionId: string;
    afterStepId?: string;
    title: string;
    include: boolean;
    png: Uint8Array;
    width: number;
    height: number;
  }): Promise<{ stepId: string }> {
    await this.check(input);
    const session = await this.session(input.sessionId);
    const steps = session.definition.steps;
    if (steps.length >= TEST_LIMITS.maxSteps) {
      throw new DomainError(
        `Limite de ${TEST_LIMITS.maxSteps} passos atingido.`,
        'too_many_steps',
        400,
      );
    }
    this.assertPng(input.png);
    await this.deps.images.assertWritable();
    const now = this.deps.clock.now();
    const step = stepSchema.parse({
      id: this.deps.ids.next(),
      at: now,
      kind: 'capture',
      title: input.title,
    });
    // the image first: with the storage failing, no step is left without it
    await saveStepImage(this.deps, {
      sessionId: session.id,
      stepId: step.id,
      bytes: input.png,
      width: input.width,
      height: input.height,
      include: input.include,
    });
    const index = input.afterStepId ? steps.findIndex((s) => s.id === input.afterStepId) : -1;
    const next =
      index < 0
        ? [...steps, step]
        : [...steps.slice(0, index + 1), step, ...steps.slice(index + 1)];
    await this.deps.repo.save({
      ...session,
      definition: { ...session.definition, steps: next },
      updatedAt: now,
    });
    return { stepId: step.id };
  }

  async replaceStepImage(input: {
    sessionId: string;
    stepId: string;
    include?: boolean;
    png: Uint8Array;
    width: number;
    height: number;
  }): Promise<void> {
    await this.check(input);
    this.assertPng(input.png);
    await this.deps.images.assertWritable();
    const previous = (await this.deps.repo.evidences(input.sessionId)).find(
      (e) => e.stepId === input.stepId,
    );
    await saveStepImage(this.deps, {
      sessionId: input.sessionId,
      stepId: input.stepId,
      bytes: input.png,
      width: input.width,
      height: input.height,
      include: input.include ?? previous?.include ?? true,
    });
    await this.deps.repo.touch(input.sessionId, this.deps.clock.now());
  }

  private assertPng(bytes: Uint8Array): void {
    if (!pngSize(bytes)) throw new DomainError('Imagem inválida (PNG esperado).', 'bad_image', 400);
    if (bytes.byteLength > TEST_LIMITS.maxImageBytes) {
      throw new DomainError(
        `Imagem maior que ${TEST_LIMITS.maxImageBytes / (1024 * 1024)} MB.`,
        'image_too_large',
        413,
      );
    }
  }
}
