import { CT_DEFAULT_USE_CASE_STATUS } from './ct-fields';
import type { TestStep } from './tests';

/*
 * Use cases of the "Caso de Teste CT" come from the step list: a `usecase` step starts a new one
 * and owns the steps that follow it. Steps before the first `usecase` step form an implicit
 * "Caso de Uso 1" (when anything there reaches the document). Shared by the server (document
 * builder) and the web (Passos tab numbering) so both always agree.
 */

export interface CtUseCaseSegment {
  /** The `usecase` step; null for the implicit first use case. */
  stepId: string | null;
  /** Custom title ('' = "Caso de Uso N"). */
  title: string;
  status: string;
  /** Steps that belong to it (the `usecase` step itself excluded), in order. */
  steps: TestStep[];
}

/** Whether a step reaches the document: a comment, or a print that is set to be included. */
export function stepHasCtContent(step: TestStep, image: { include: boolean } | undefined): boolean {
  if (step.kind === 'usecase') return false;
  return !!step.comment?.trim() || !!image?.include;
}

/**
 * Splits the steps into use cases. The implicit first segment is kept when it has steps and
 * either there are no `usecase` steps at all, or at least one of its steps reaches the document
 * (otherwise a divider placed before the first commented step would leave an empty "Caso de Uso 1").
 */
export function splitUseCases(
  steps: readonly TestStep[],
  hasContent: (step: TestStep) => boolean,
  firstUseCase?: { title: string; status: string },
): CtUseCaseSegment[] {
  const segments: CtUseCaseSegment[] = [];
  const implicit: CtUseCaseSegment = {
    stepId: null,
    title: firstUseCase?.title ?? '',
    status: firstUseCase?.status ?? CT_DEFAULT_USE_CASE_STATUS,
    steps: [],
  };
  let current = implicit;
  let dividers = 0;
  for (const step of steps) {
    if (step.kind === 'usecase') {
      dividers += 1;
      current = {
        stepId: step.id,
        title: step.useCase?.title ?? '',
        status: step.useCase?.status ?? CT_DEFAULT_USE_CASE_STATUS,
        steps: [],
      };
      segments.push(current);
    } else {
      current.steps.push(step);
    }
  }
  const keepImplicit =
    implicit.steps.length > 0 && (dividers === 0 || implicit.steps.some(hasContent));
  return keepImplicit ? [implicit, ...segments] : segments;
}

/** "Caso de Uso N" (1-based). */
export const defaultUseCaseTitle = (index: number): string => `Caso de Uso ${index + 1}`;

/** The title shown for a segment: the custom one, else "Caso de Uso N". */
export const useCaseDisplayTitle = (segment: Pick<CtUseCaseSegment, 'title'>, index: number) =>
  segment.title.trim() || defaultUseCaseTitle(index);
