import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Privacy firewall: what the AI may see of personal data (LGPD)        */
/* ------------------------------------------------------------------ */

/**
 * Kinds of personal data. They double as the label of the reversible token the AI sees
 * (`[CPF_1]`, `[NOME_3]`). `VALOR` is the generic kind; `SEGREDO` is for secrets.
 */
export const PII_KINDS = [
  'CPF',
  'CNPJ',
  'CNS',
  'PIS',
  'TITULO',
  'CNH',
  'RENAVAM',
  'CARTAO',
  'EMAIL',
  'TELEFONE',
  'CEP',
  'RG',
  'PLACA',
  'NOME',
  'ENDERECO',
  'VALOR',
  'SEGREDO',
] as const;
export const piiKindSchema = z.enum(PII_KINDS);
export type PiiKind = z.infer<typeof piiKindSchema>;

/**
 * What the AI gets of a column:
 * - `reveal`: the real values (the analyst said the column is not personal);
 * - `tokenize`: reversible tokens (`[CPF_1]`), the analyst still sees the real value;
 * - `omit`: the column is removed from what the AI sees.
 */
export const columnRuleActionSchema = z.enum(['reveal', 'tokenize', 'omit']);
export type ColumnRuleAction = z.infer<typeof columnRuleActionSchema>;

/** `auto` = proposed by the classifier; `analyst` = decided (or confirmed) by a person. */
export const columnRuleOriginSchema = z.enum(['auto', 'analyst']);
export type ColumnRuleOrigin = z.infer<typeof columnRuleOriginSchema>;

/** `*` as schema or table = "this column name in any schema/table" (legacy per-name lists). */
export const COLUMN_RULE_WILDCARD = '*';

export const columnRuleInputSchema = z.object({
  schema: z.string().trim().min(1).max(128).default(COLUMN_RULE_WILDCARD),
  table: z.string().trim().min(1).max(128).default(COLUMN_RULE_WILDCARD),
  column: z.string().trim().min(1).max(128),
  action: columnRuleActionSchema,
  /** Only meaningful with `tokenize`; null = generic token. */
  kind: piiKindSchema.nullable().default(null),
});
export type ColumnRuleInput = z.input<typeof columnRuleInputSchema>;

export interface ColumnRuleDto {
  id: string;
  connectionId: string;
  schema: string;
  table: string;
  column: string;
  action: ColumnRuleAction;
  kind: PiiKind | null;
  origin: ColumnRuleOrigin;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* "Dados com IA": the analyst reviews unclassified columns before the  */
/* AI gets anything (SSE `ai_review` + POST /api/chat/reviews/:id)      */
/* ------------------------------------------------------------------ */

export interface AiReviewColumnDto {
  /** Position of the column in the result. */
  index: number;
  /** Name in the result (may be an alias). */
  name: string;
  type: string;
  /** Real origin of the values; `null` = an expression (never remembered). */
  source: { schema: string; table: string; column: string } | null;
  /** What the classifier proposes; preselected in the card. */
  proposed: ColumnRuleAction;
  kind: PiiKind | null;
  /** Up to 5 REAL values (strings cut at 80 chars) so the analyst can judge. Never sent to the AI. */
  sample: string[];
}

export interface AiReviewDto {
  reviewId: string;
  databaseId: string;
  sql: string;
  columns: AiReviewColumnDto[];
}

export const aiReviewAnswerSchema = z.object({
  decisions: z
    .array(
      z.object({
        index: z.number().int().min(0).max(10_000),
        action: columnRuleActionSchema,
        /** Save the decision as a rule of this column (ignored for expressions). */
        remember: z.boolean().default(false),
      }),
    )
    .max(1000),
});
export type AiReviewAnswerInput = z.input<typeof aiReviewAnswerSchema>;
export type AiReviewDecision = z.infer<typeof aiReviewAnswerSchema>['decisions'][number];

/** Why a review stopped waiting: the analyst answered, 5 minutes passed, or the turn was aborted. */
export type AiReviewClosedReason = 'answered' | 'timeout' | 'aborted';

/* ------------------------------------------------------------------ */
/* Global firewall settings (Configurações → Privacidade da IA)         */
/* ------------------------------------------------------------------ */

const privacySettingFields = {
  /** Personal data is replaced by tokens before ANY request leaves for an AI provider. */
  enabled: z.boolean(),
  /** Optional Presidio analyzer sidecar (empty = native detectors only). */
  presidioUrl: z.string().trim().max(500),
  /** Detections below this confidence are ignored. */
  minScore: z.number().min(0.1).max(1),
};
export const privacySettingsSchema = z.object({
  enabled: privacySettingFields.enabled.default(true),
  presidioUrl: privacySettingFields.presidioUrl.default(''),
  minScore: privacySettingFields.minScore.default(0.5),
});
/** Partial update that never fills in defaults. */
export const privacySettingsUpdateSchema = z.object(privacySettingFields).partial();
export type PrivacySettings = z.infer<typeof privacySettingsSchema>;
