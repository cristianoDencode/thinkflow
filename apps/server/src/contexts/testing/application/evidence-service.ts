import {
  evidenceUpdateSchema,
  stepSchema,
  TEST_LIMITS,
  type TestStepImageDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import { DomainError, NotFoundError } from '../../../shared/kernel/errors';
import type { IdGenerator } from '../../../shared/kernel/ids';
import type { TestImageStore, TestSessionRepository } from '../domain/ports';
import { testKeys, type TestEvidence, type TestSession } from '../domain/session';
import { removeStepImage, saveStepImage } from './step-images';
import { toStepImageDto } from './test-session-service';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((b, i) => bytes[i] === b);

/** Width/height from the IHDR chunk of a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24 || !startsWith(bytes, PNG_MAGIC)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface EvidenceServiceDeps {
  repo: TestSessionRepository;
  images: TestImageStore;
  clock: Clock;
  ids: IdGenerator;
  onError?: (err: unknown) => void;
}

/**
 * The image of a step (its automatic or manual print): annotated in the editor, commented, left
 * in or out of the document, or removed (the step stays). Creating them is the recorder's job.
 */
export class EvidenceService {
  constructor(private readonly deps: EvidenceServiceDeps) {}

  private async session(id: string): Promise<TestSession> {
    const session = await this.deps.repo.find(id);
    if (!session) throw new NotFoundError('Sessão de teste');
    return session;
  }

  private async evidence(sessionId: string, evidenceId: string): Promise<TestEvidence> {
    const evidence = await this.deps.repo.findEvidence(evidenceId);
    if (!evidence || evidence.sessionId !== sessionId) throw new NotFoundError('Print');
    return evidence;
  }

  /**
   * A PNG pasted or uploaded by the user (another system, a dialog the recorder missed) becomes a
   * `capture` step at the end of the session. Only while nothing is recording.
   */
  async upload(sessionId: string, bytes: Uint8Array): Promise<TestStepImageDto> {
    const session = await this.session(sessionId);
    const size = pngSize(bytes);
    if (!size) throw new DomainError('Envie uma imagem PNG.', 'bad_image', 400);
    if (bytes.byteLength > TEST_LIMITS.maxImageBytes) throw this.tooLarge();
    if (session.definition.steps.length >= TEST_LIMITS.maxSteps) {
      throw new DomainError(
        `Limite de ${TEST_LIMITS.maxSteps} passos atingido.`,
        'too_many_steps',
        400,
      );
    }
    await this.deps.images.assertWritable();
    const now = this.deps.clock.now();
    const step = stepSchema.parse({ id: this.deps.ids.next(), at: now, kind: 'capture' });
    // the image first: with the storage failing, no step is left without it
    const evidence = await saveStepImage(this.deps, {
      sessionId,
      stepId: step.id,
      bytes,
      width: size.width,
      height: size.height,
    });
    await this.deps.repo.save({
      ...session,
      definition: { ...session.definition, steps: [...session.definition.steps, step] },
      updatedAt: now,
    });
    return toStepImageDto(evidence);
  }

  async update(sessionId: string, evidenceId: string, body: unknown): Promise<TestStepImageDto> {
    const input = evidenceUpdateSchema.parse(body);
    const session = await this.session(sessionId);
    const evidence = await this.evidence(sessionId, evidenceId);
    const updated: TestEvidence = {
      ...evidence,
      ...(input.annotations !== undefined ? { annotations: input.annotations } : {}),
      ...(input.crop !== undefined ? { crop: input.crop } : {}),
      ...(input.comment !== undefined ? { comment: input.comment.trim() } : {}),
      ...(input.include !== undefined ? { include: input.include } : {}),
      updatedAt: this.deps.clock.now(),
    };
    await this.deps.repo.saveEvidence(updated);
    await this.touch(session);
    return toStepImageDto(updated);
  }

  /**
   * Saves what the editor produced: the vector annotations (editable later), the comment and the
   * flattened PNG (cropped to the selected area, if any). No annotations and no crop = back to the
   * original screenshot.
   */
  async saveAnnotated(
    sessionId: string,
    evidenceId: string,
    body: unknown,
    image: Uint8Array | null,
  ): Promise<TestStepImageDto> {
    const input = evidenceUpdateSchema.parse(body);
    const evidence = await this.evidence(sessionId, evidenceId);
    const annotations = input.annotations ?? evidence.annotations;
    const crop = input.crop !== undefined ? input.crop : evidence.crop;
    let annotatedKey = evidence.annotatedKey;
    if (annotations.length === 0 && !crop) {
      if (annotatedKey) await this.deps.images.delete(annotatedKey);
      annotatedKey = null;
    } else if (image) {
      if (!pngSize(image))
        throw new DomainError('Imagem anotada inválida (PNG esperado).', 'bad_image', 400);
      if (image.byteLength > TEST_LIMITS.maxImageBytes) throw this.tooLarge();
      annotatedKey = testKeys.annotated(sessionId, evidenceId);
      await this.deps.images.put(annotatedKey, image, 'image/png');
    }
    await this.update(sessionId, evidenceId, { ...input, annotations, crop });
    const saved = await this.evidence(sessionId, evidenceId);
    const withKey = { ...saved, annotatedKey };
    await this.deps.repo.saveEvidence(withKey);
    return toStepImageDto(withKey);
  }

  async delete(sessionId: string, evidenceId: string): Promise<void> {
    const evidence = await this.evidence(sessionId, evidenceId);
    await removeStepImage(this.deps, evidence);
    await this.touch(await this.session(sessionId));
  }

  private async touch(session: TestSession): Promise<void> {
    await this.deps.repo.touch(session.id, this.deps.clock.now());
  }

  private tooLarge(): DomainError {
    return new DomainError(
      `Imagem maior que ${TEST_LIMITS.maxImageBytes / (1024 * 1024)} MB.`,
      'image_too_large',
      413,
    );
  }
}
