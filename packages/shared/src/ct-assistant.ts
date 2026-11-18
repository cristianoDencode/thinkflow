import { z } from 'zod';

/*
 * "Assistente de IA" of the test-case document (CT): request / response contract of
 * POST /api/tests/sessions/:id/ct-assistant.
 *
 * The assistant only ever sees and changes TEXT. Images are never part of the request's useful
 * content (the document is reduced to `{ kind: 'image' }` markers on parse) and the patch it
 * returns can only target text fields (title, analysis title, context, text items by index).
 */

export const CT_ASSISTANT_ACTIONS = [
  'review',
  'improve_context',
  'describe_use_cases',
  'suggest_title',
  'custom',
] as const;
export type CtAssistantAction = (typeof CT_ASSISTANT_ACTIONS)[number];

export const CT_ASSISTANT_ACTION_LABELS: Record<CtAssistantAction, string> = {
  review: 'Revisar escrita',
  improve_context: 'Melhorar contexto',
  describe_use_cases: 'Descrever os casos de uso',
  suggest_title: 'Sugerir título',
  custom: 'Pedido livre',
};

export const CT_ASSISTANT_LIMITS = {
  maxPromptChars: 4_000,
  maxLibraries: 5,
  maxMcpServers: 5,
  maxFieldChars: 300,
  maxContextChars: 20_000,
  maxTextChars: 20_000,
  maxUseCases: 100,
  maxItemsPerUseCase: 500,
} as const;

export const ctAssistantScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document') }),
  z.object({ kind: z.literal('context') }),
  z.object({
    kind: z.literal('useCase'),
    /** 0-based index into `document.useCases`. */
    index: z
      .number()
      .int()
      .min(0)
      .max(CT_ASSISTANT_LIMITS.maxUseCases - 1),
  }),
]);
export type CtAssistantScope = z.infer<typeof ctAssistantScopeSchema>;

/** The slice of a CtDocument the assistant works with (everything else is dropped on parse). */
export const ctAssistantDocumentSchema = z.object({
  title: z.string().max(CT_ASSISTANT_LIMITS.maxContextChars).default(''),
  analysisTitle: z.string().max(CT_ASSISTANT_LIMITS.maxContextChars).default(''),
  context: z.string().max(CT_ASSISTANT_LIMITS.maxContextChars).default(''),
  useCases: z
    .array(
      z.object({
        title: z.string().max(CT_ASSISTANT_LIMITS.maxContextChars).optional(),
        status: z.string().max(CT_ASSISTANT_LIMITS.maxContextChars).optional(),
        items: z
          .array(
            z.discriminatedUnion('kind', [
              z.object({
                kind: z.literal('text'),
                text: z.string().max(CT_ASSISTANT_LIMITS.maxTextChars),
              }),
              z.object({
                kind: z.literal('code'),
                text: z.string().max(CT_ASSISTANT_LIMITS.maxTextChars),
              }),
              // only the marker: the key, size and caption of an image are never read
              z.object({ kind: z.literal('image') }),
            ]),
          )
          .max(CT_ASSISTANT_LIMITS.maxItemsPerUseCase)
          .default([]),
      }),
    )
    .max(CT_ASSISTANT_LIMITS.maxUseCases)
    .default([]),
});
export type CtAssistantDocument = z.infer<typeof ctAssistantDocumentSchema>;

const ids = z.array(z.string().trim().min(1).max(200));

export const ctAssistantRequestSchema = z.object({
  action: z.enum(CT_ASSISTANT_ACTIONS),
  prompt: z.string().trim().max(CT_ASSISTANT_LIMITS.maxPromptChars).optional(),
  scope: ctAssistantScopeSchema.default({ kind: 'document' }),
  document: ctAssistantDocumentSchema,
  libraryIds: ids.max(CT_ASSISTANT_LIMITS.maxLibraries).default([]),
  mcpServerIds: ids.max(CT_ASSISTANT_LIMITS.maxMcpServers).default([]),
  /** Model id or combo name as in `/api/models`; absent = "auto". */
  model: z.string().trim().min(1).max(200).optional(),
});
export type CtAssistantRequest = z.input<typeof ctAssistantRequestSchema>;

/** What the model may change. Text only; use-case items are addressed by 0-based index. */
export const ctAssistantPatchSchema = z.object({
  title: z.string().trim().max(CT_ASSISTANT_LIMITS.maxFieldChars).optional(),
  analysisTitle: z.string().trim().max(CT_ASSISTANT_LIMITS.maxFieldChars).optional(),
  context: z.string().max(CT_ASSISTANT_LIMITS.maxContextChars).optional(),
  useCases: z
    .array(
      z.object({
        index: z
          .number()
          .int()
          .min(0)
          .max(CT_ASSISTANT_LIMITS.maxUseCases - 1),
        items: z
          .array(
            z.object({
              index: z
                .number()
                .int()
                .min(0)
                .max(CT_ASSISTANT_LIMITS.maxItemsPerUseCase - 1),
              text: z.string().max(CT_ASSISTANT_LIMITS.maxTextChars),
            }),
          )
          .max(CT_ASSISTANT_LIMITS.maxItemsPerUseCase),
      }),
    )
    .max(CT_ASSISTANT_LIMITS.maxUseCases)
    .optional(),
});
export type CtAssistantPatch = z.infer<typeof ctAssistantPatchSchema>;

export interface CtAssistantResultDto {
  patch: CtAssistantPatch;
  /** Short pt-BR explanation of what changed (and why). */
  explanation: string;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** Non-fatal notes: dropped changes, MCP servers that could not be listed, tool limits... */
  warnings: string[];
}
