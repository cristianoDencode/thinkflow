import {
  CT_DEFAULT_ANALYSIS_TITLE,
  CT_DEFAULT_PRIORITY,
  CT_FIRST_VERSION,
  CT_FIRST_VERSION_DESCRIPTION,
  splitUseCases,
  stepHasCtContent,
  useCaseDisplayTitle,
  type CtFieldsDto,
  type CtStateDocumentDto,
  type CtUseCaseEditDto,
} from '@thinkflow/shared';
import {
  ctLines,
  ctUseCaseTitle,
  formatCtDate,
  type CtDocument,
  type CtItem,
  type CtUseCase,
} from './ct-document';
import type { TestEvidence, TestSession } from './session';

/*
 * Builds the "Caso de Teste CT" from a test session: the stored fields (with defaults), and the
 * use cases made from the steps (a `usecase` step starts one). For each step, in order: its
 * comment as a text (or code) item, then its print when it is set to be included (the annotated,
 * cropped version when it was edited). Steps with neither are left out.
 */

/** Defaults applied to the fields never saved: title = session name, one version row, author. */
export function resolveCtFields(
  session: Pick<TestSession, 'name' | 'definition'>,
  defaultAuthor: string,
  now: Date,
): CtFieldsDto {
  const stored = session.definition.ct ?? {};
  const author = stored.author ?? defaultAuthor;
  return {
    title: stored.title?.trim() || session.name,
    ticketId: stored.ticketId ?? '',
    priority: stored.priority?.trim() || CT_DEFAULT_PRIORITY,
    systemModule: stored.systemModule ?? '',
    author,
    analysisTitle: stored.analysisTitle?.trim() || CT_DEFAULT_ANALYSIS_TITLE,
    context: stored.context ?? '',
    versions: stored.versions ?? [
      {
        version: CT_FIRST_VERSION,
        date: formatCtDate(now),
        description: CT_FIRST_VERSION_DESCRIPTION,
        author,
      },
    ],
  };
}

export interface CtBuildInput {
  session: TestSession;
  fields: CtFieldsDto;
  evidences: TestEvidence[];
  /** Size of every image that exists in the storage, by object key. */
  imageSizes: ReadonlyMap<string, { width: number; height: number }>;
}

export interface CtBuild {
  document: CtDocument;
  /** The step behind each item of `document.useCases[i].items[j]` (parallel arrays). */
  itemStepIds: string[][];
  useCases: CtUseCaseEditDto[];
  /** Prints set to be included whose file is gone. */
  missingImages: number;
}

export function buildCtDocument(input: CtBuildInput): CtBuild {
  const { session, fields } = input;
  const steps = session.definition.steps;
  const byStep = new Map(input.evidences.map((e) => [e.stepId, e]));
  const segments = splitUseCases(
    steps,
    (step) => stepHasCtContent(step, byStep.get(step.id)),
    session.definition.ct?.firstUseCase,
  );

  let missingImages = 0;
  const itemStepIds: string[][] = [];
  const useCases: CtUseCase[] = segments.map((segment) => {
    const items: CtItem[] = [];
    const ids: string[] = [];
    for (const step of segment.steps) {
      const comment = step.comment?.trim();
      if (comment) {
        // keep the author's line breaks and indentation, only drop blank edges
        const text = step.comment!.replace(/^\s*\n|\s+$/g, '');
        items.push({ kind: step.commentIsCode ? 'code' : 'text', text });
        ids.push(step.id);
      }
      const evidence = byStep.get(step.id);
      if (evidence?.include) {
        const key = evidence.annotatedKey ?? evidence.originalKey;
        const size = input.imageSizes.get(key);
        if (!size) {
          missingImages += 1;
          continue;
        }
        const caption = evidence.comment.trim();
        items.push({
          kind: 'image',
          key,
          width: size.width,
          height: size.height,
          ...(caption ? { caption } : {}),
        });
        ids.push(step.id);
      }
    }
    itemStepIds.push(ids);
    const title = segment.title.trim();
    return { ...(title ? { title } : {}), status: segment.status, items };
  });

  return {
    document: {
      title: fields.title,
      ticketId: fields.ticketId,
      priority: fields.priority,
      systemModule: fields.systemModule,
      author: fields.author,
      analysisTitle: fields.analysisTitle,
      context: fields.context,
      useCases,
      versions: fields.versions,
    },
    itemStepIds,
    useCases: segments.map((segment, index) => ({
      stepId: segment.stepId,
      title: segment.title,
      defaultTitle: useCaseDisplayTitle({ title: '' }, index),
      status: segment.status,
    })),
    missingImages,
  };
}

/** The slice of the document the AI assistant reads (images reduced to markers). */
export function ctStateDocument(doc: CtDocument): CtStateDocumentDto {
  return {
    title: doc.title,
    analysisTitle: doc.analysisTitle,
    context: doc.context,
    useCases: doc.useCases.map((useCase) => ({
      ...(useCase.title ? { title: useCase.title } : {}),
      status: useCase.status,
      items: useCase.items.map((item) =>
        item.kind === 'image' ? { kind: 'image' as const } : { kind: item.kind, text: item.text },
      ),
    })),
  };
}

/** Plain-text flavor of the "Plano de Teste" for the clipboard (images become "[imagem]"). */
export function ctPlanoPlainText(doc: CtDocument): string {
  const out: string[] = [];
  doc.useCases.forEach((useCase, index) => {
    out.push(`${ctUseCaseTitle(useCase, index)} — ${useCase.status}`);
    for (const item of useCase.items) {
      if (item.kind === 'image') out.push(item.caption ? `[imagem: ${item.caption}]` : '[imagem]');
      else out.push(...ctLines(item.text));
    }
    out.push('');
  });
  return `${out.join('\n').trimEnd()}\n`;
}
