import { z } from 'zod';
import {
  CT_DEFAULT_ANALYSIS_TITLE,
  CT_DEFAULT_PRIORITY,
  CT_DEFAULT_STATUS,
  CT_LIMITS,
  type CtDocument,
} from '../domain/ct-document';

/*
 * zod schema of the "Caso de Teste CT" document (untrusted input: editor payloads, stored JSON).
 * Self-contained on purpose (it only needs the limits): it will be moved to `packages/shared`.
 */

const field = z.string().trim().max(CT_LIMITS.maxFieldChars);
const requiredField = (label: string) =>
  z.string().trim().min(1, `${label}: informe um valor.`).max(CT_LIMITS.maxFieldChars);

const textItem = z.object({
  kind: z.literal('text'),
  text: z.string().max(CT_LIMITS.maxTextChars),
});

const codeItem = z.object({
  kind: z.literal('code'),
  text: z.string().max(CT_LIMITS.maxTextChars),
});

const imageItem = z.object({
  kind: z.literal('image'),
  key: z.string().trim().min(1, 'Imagem sem chave.').max(CT_LIMITS.maxKeyChars),
  width: z.number().int().min(1).max(CT_LIMITS.maxImagePixels),
  height: z.number().int().min(1).max(CT_LIMITS.maxImagePixels),
  caption: z.string().trim().max(CT_LIMITS.maxFieldChars).optional(),
});

export const ctItemSchema = z.discriminatedUnion('kind', [textItem, imageItem, codeItem]);

export const ctUseCaseSchema = z.object({
  title: field.optional(),
  status: field.default(CT_DEFAULT_STATUS),
  items: z.array(ctItemSchema).max(CT_LIMITS.maxItemsPerUseCase).default([]),
});

export const ctVersionSchema = z.object({
  version: requiredField('Versão'),
  date: field.default(''),
  description: field.default(''),
  author: field.default(''),
});

export const ctDocumentSchema = z.object({
  title: field.max(CT_LIMITS.maxTitleChars).default(''),
  ticketId: field.default(''),
  priority: field.default(CT_DEFAULT_PRIORITY),
  systemModule: z
    .string()
    .trim()
    .max(CT_LIMITS.maxFieldChars * 3)
    .default(''),
  author: field.default(''),
  analysisTitle: field
    .default(CT_DEFAULT_ANALYSIS_TITLE)
    .transform((value) => value || CT_DEFAULT_ANALYSIS_TITLE),
  context: z.string().max(CT_LIMITS.maxContextChars).default(''),
  useCases: z.array(ctUseCaseSchema).max(CT_LIMITS.maxUseCases).default([]),
  versions: z.array(ctVersionSchema).max(CT_LIMITS.maxVersions).default([]),
});

/** Compile-time proof that the schema output is the domain type (and vice versa). */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesDomain: Equal<z.output<typeof ctDocumentSchema>, CtDocument> = true;
void schemaMatchesDomain;

export type CtDocumentResult = { ok: true; document: CtDocument } | { ok: false; errors: string[] };

/** Validates untrusted JSON and fills the defaults; errors are pt-BR, one per line. */
export function parseCtDocument(input: unknown): CtDocumentResult {
  const parsed = ctDocumentSchema.safeParse(input);
  if (parsed.success) return { ok: true, document: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  };
}
