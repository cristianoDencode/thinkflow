import type { Clock } from '../../../shared/kernel/clock';
import type { IdGenerator } from '../../../shared/kernel/ids';
import type { TestImageStore, TestSessionRepository } from '../domain/ports';
import { testKeys, type TestEvidence } from '../domain/session';

export interface StepImageDeps {
  repo: TestSessionRepository;
  images: TestImageStore;
  clock: Clock;
  ids: IdGenerator;
}

/** Best effort: an object that cannot be deleted now must not fail the change that orphaned it. */
async function deleteObjects(deps: StepImageDeps, evidence: TestEvidence): Promise<void> {
  for (const key of [evidence.originalKey, evidence.annotatedKey]) {
    if (key) await deps.images.delete(key).catch(() => undefined);
  }
}

/**
 * Stores `bytes` (a PNG) as THE image of a step. A step has one image at most: a previous one is
 * replaced (its annotations go with it), after the new one is safely stored.
 */
export async function saveStepImage(
  deps: StepImageDeps,
  input: {
    sessionId: string;
    stepId: string;
    bytes: Uint8Array;
    width: number;
    height: number;
    include?: boolean;
  },
): Promise<TestEvidence> {
  const existing = await deps.repo.evidences(input.sessionId);
  const previous = existing.find((e) => e.stepId === input.stepId) ?? null;
  const id = deps.ids.next();
  const now = deps.clock.now();
  const originalKey = testKeys.original(input.sessionId, id);
  await deps.images.put(originalKey, input.bytes, 'image/png');
  const evidence: TestEvidence = {
    id,
    sessionId: input.sessionId,
    stepId: input.stepId,
    seq: existing.reduce((max, e) => Math.max(max, e.seq), 0) + 1,
    at: now,
    width: input.width,
    height: input.height,
    originalKey,
    annotatedKey: null,
    annotations: [],
    crop: null,
    comment: '',
    include: input.include ?? true,
    createdAt: now,
    updatedAt: now,
  };
  if (previous) await deps.repo.deleteEvidence(previous.id); // one image per step (unique index)
  await deps.repo.saveEvidence(evidence);
  if (previous) await deleteObjects(deps, previous);
  return evidence;
}

/** Deletes the image (files and row); the step stays. */
export async function removeStepImage(deps: StepImageDeps, evidence: TestEvidence): Promise<void> {
  await deps.images.delete(evidence.originalKey);
  if (evidence.annotatedKey) await deps.images.delete(evidence.annotatedKey);
  await deps.repo.deleteEvidence(evidence.id);
}
