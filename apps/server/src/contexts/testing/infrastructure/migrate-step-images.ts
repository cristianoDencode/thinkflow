import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../../../shared/infrastructure/db/client';
import { testEvidences, testSessions } from '../../../shared/infrastructure/db/schema';

/** Loose view of a step of the old JSON (this runs before the current schema parses it). */
interface LegacyStep {
  id: string;
  at: number;
  kind: string;
  page?: unknown;
  thumbnailKey?: string | null;
  includeThumbnail?: boolean;
  [key: string]: unknown;
}

export interface StepImageMigrationResult {
  sessions: number;
  /** Old thumbnails turned into step images. */
  thumbnails: number;
  /** Evidences without a step turned into `capture` steps. */
  captures: number;
}

/**
 * Brings sessions made before "prints live in the steps" to the new model, losing nothing:
 *  - an evidence linked to a step is that step's image (it wins over the old thumbnail);
 *  - an evidence linked to no step (or to a step that is gone, or a second one on the same step)
 *    becomes a `capture` step, inserted by timestamp, holding it as its image;
 *  - a thumbnail of a step without an evidence becomes that step's image, in the document only
 *    when `includeThumbnail` was on.
 * Old thumbnail files stay where they are (the new images point at them), and the ones that lost
 * to an evidence are left in storage rather than deleted behind the user's back.
 * Idempotent: a session is touched only while it still has `thumbnailKey`/`includeThumbnail` in
 * its steps or evidences without a step.
 */
export function migrateLegacyStepImages(
  db: Db,
  options: { newId?: () => string; now?: () => number } = {},
): StepImageMigrationResult {
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? Date.now;
  const result: StepImageMigrationResult = { sessions: 0, thumbnails: 0, captures: 0 };

  db.transaction((tx) => {
    for (const row of tx.select().from(testSessions).all()) {
      let definition: { steps?: LegacyStep[]; viewport?: { width: number; height: number } };
      try {
        definition = JSON.parse(row.definition);
      } catch {
        continue;
      }
      const steps = Array.isArray(definition.steps) ? definition.steps : [];
      const evidences = tx
        .select()
        .from(testEvidences)
        .where(eq(testEvidences.sessionId, row.id))
        .orderBy(testEvidences.seq)
        .all();
      const stepIds = new Set(steps.map((s) => s.id));
      const hasLegacyFields = steps.some((s) => 'thumbnailKey' in s || 'includeThumbnail' in s);
      const hasLooseEvidence = evidences.some((e) => !e.stepId || !stepIds.has(e.stepId));
      if (!hasLegacyFields && !hasLooseEvidence) continue;

      // one image per step: the first evidence (by seq) keeps the step, the rest become prints
      const owner = new Map<string, string>(); // stepId → evidence id
      const loose = [];
      for (const e of evidences) {
        if (e.stepId && stepIds.has(e.stepId) && !owner.has(e.stepId)) owner.set(e.stepId, e.id);
        else loose.push(e);
      }

      let seq = evidences.reduce((max, e) => Math.max(max, e.seq), 0);
      const viewport = definition.viewport ?? { width: 1366, height: 768 };
      const stamp = now();

      // thumbnails of steps that have no evidence
      for (const step of steps) {
        if (owner.has(step.id) || !step.thumbnailKey) continue;
        const id = newId();
        tx.insert(testEvidences)
          .values({
            id,
            sessionId: row.id,
            stepId: step.id,
            seq: ++seq,
            at: step.at,
            // the files are JPEGs of the page: only the proportion matters to the editor
            width: viewport.width,
            height: viewport.height,
            originalKey: step.thumbnailKey,
            annotatedKey: null,
            annotations: '[]',
            crop: null,
            comment: '',
            include: step.includeThumbnail === true,
            createdAt: step.at,
            updatedAt: stamp,
          })
          .run();
        owner.set(step.id, id);
        result.thumbnails += 1;
      }

      // loose evidences become `capture` steps, placed by timestamp
      let next = steps.map((s) => ({ ...s }));
      for (const e of [...loose].sort((a, b) => a.at - b.at || a.seq - b.seq)) {
        const step: LegacyStep = {
          id: newId(),
          at: e.at,
          kind: 'capture',
          target: null,
          page: null,
          comment: null,
        };
        let index = -1;
        next.forEach((s, i) => {
          if (s.at <= e.at) index = i;
        });
        next = [...next.slice(0, index + 1), step, ...next.slice(index + 1)];
        tx.update(testEvidences).set({ stepId: step.id }).where(eq(testEvidences.id, e.id)).run();
        result.captures += 1;
      }

      next = next.map((s) => {
        const { thumbnailKey: _t, includeThumbnail: _i, ...rest } = s;
        return rest as LegacyStep;
      });
      tx.update(testSessions)
        .set({ definition: JSON.stringify({ ...definition, steps: next }) })
        .where(eq(testSessions.id, row.id))
        .run();
      result.sessions += 1;
    }
  });
  return result;
}
