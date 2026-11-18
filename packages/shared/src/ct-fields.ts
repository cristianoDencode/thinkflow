import { z } from 'zod';

/*
 * "Caso de Teste CT" fields stored with a test session (`definition.ct`) and the use-case marker
 * carried by `usecase` steps. Kept free of imports from `tests.ts` so that file can embed them.
 * The limits mirror the CT renderer's (apps/server testing/domain/ct-document.ts).
 */

export const CT_FIELD_LIMITS = {
  maxFieldChars: 300,
  maxSystemModuleChars: 900,
  maxContextChars: 20_000,
  maxVersions: 100,
} as const;

export const CT_DEFAULT_PRIORITY = 'Normal';
export const CT_PRIORITY_SUGGESTIONS = ['Normal', 'Alta', 'Baixa', 'Urgente'] as const;
export const CT_DEFAULT_ANALYSIS_TITLE = 'Análise';
export const CT_DEFAULT_USE_CASE_STATUS = 'Finalizado';
export const CT_USE_CASE_STATUS_SUGGESTIONS = [
  'Pendente',
  'Em andamento',
  'Finalizado',
  'Reprovado',
] as const;
export const CT_FIRST_VERSION = '1.0';
export const CT_FIRST_VERSION_DESCRIPTION = 'Criação do documento';

const field = z.string().trim().max(CT_FIELD_LIMITS.maxFieldChars);

/** Title and status of a use case (the `usecase` step, or the implicit first one). */
export const useCaseInfoSchema = z.object({
  title: field.default(''),
  status: field.default(CT_DEFAULT_USE_CASE_STATUS),
});
export type CtUseCaseInfo = z.infer<typeof useCaseInfoSchema>;

export const ctVersionRowSchema = z.object({
  version: z.string().trim().min(1, 'Informe a versão.').max(CT_FIELD_LIMITS.maxFieldChars),
  date: field.default(''),
  description: field.default(''),
  author: field.default(''),
});
export type CtVersionRow = z.infer<typeof ctVersionRowSchema>;

/**
 * The CT fields as edited in the Documento tab. Everything is optional in storage: a field that
 * was never saved falls back to a default (title = session name, author = logged user, one
 * version row), see `resolveCtFields` on the server.
 */
export const ctFieldsSchema = z.object({
  title: field.optional(),
  ticketId: field.optional(),
  priority: field.optional(),
  systemModule: z.string().trim().max(CT_FIELD_LIMITS.maxSystemModuleChars).optional(),
  author: field.optional(),
  analysisTitle: field.optional(),
  context: z.string().max(CT_FIELD_LIMITS.maxContextChars).optional(),
  /** Title/status of the implicit first use case (steps before the first `usecase` step). */
  firstUseCase: useCaseInfoSchema.optional(),
  versions: z.array(ctVersionRowSchema).max(CT_FIELD_LIMITS.maxVersions).optional(),
  /** Document model (look) chosen for this session; missing or deleted = the default. */
  modelId: z.string().trim().min(1).max(100).optional(),
});
export type CtStoredFields = z.infer<typeof ctFieldsSchema>;

/** The fields with every default applied (what the editor shows and the document is built from). */
export interface CtFieldsDto {
  title: string;
  ticketId: string;
  priority: string;
  systemModule: string;
  author: string;
  analysisTitle: string;
  context: string;
  versions: CtVersionRow[];
}

/** One use case as the editor lists it. `stepId` null = the implicit first one. */
export interface CtUseCaseEditDto {
  stepId: string | null;
  title: string;
  /** "Caso de Uso N" when `title` is blank. */
  defaultTitle: string;
  status: string;
}

export const ctUpdateSchema = z.object({
  title: field,
  ticketId: field,
  priority: field,
  systemModule: z.string().trim().max(CT_FIELD_LIMITS.maxSystemModuleChars),
  author: field,
  analysisTitle: field,
  context: z.string().max(CT_FIELD_LIMITS.maxContextChars),
  versions: z.array(ctVersionRowSchema).max(CT_FIELD_LIMITS.maxVersions),
  /** Titles/statuses of the use cases listed by `GET .../ct` (omitted = unchanged). */
  useCases: z
    .array(
      z.object({
        stepId: z.string().trim().min(1).max(100).nullable(),
        title: field,
        status: field,
      }),
    )
    .max(100)
    .optional(),
});
export type CtUpdateInput = z.infer<typeof ctUpdateSchema>;

/** The slice of the document the AI assistant works with (same shape as its request). */
export interface CtStateDocumentDto {
  title: string;
  analysisTitle: string;
  context: string;
  useCases: {
    title?: string;
    status?: string;
    items: ({ kind: 'text' | 'code'; text: string } | { kind: 'image' })[];
  }[];
}

export interface CtStateDto {
  fields: CtFieldsDto;
  /** Model the document is rendered with (the default one when the saved model is gone). */
  modelId: string;
  useCases: CtUseCaseEditDto[];
  /** Number of images that will be in the document. */
  imageCount: number;
  /** The assembled document (text and image markers), for the AI assistant. */
  document: CtStateDocumentDto;
  /** Step that holds each item of `document.useCases[i].items[j]` (parallel arrays). */
  itemStepIds: string[][];
  /** pt-BR notes (e.g. prints gone from the storage). */
  warnings: string[];
}

export interface CtOneDriveResultDto {
  id: string;
  webUrl: string;
  name: string;
}
