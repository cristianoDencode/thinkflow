import { z } from 'zod';
import { templateKindSchema, type TemplateKind } from './templates';

/* Reports (generated documents) */

export const reportStatusSchema = z.enum([
  'queued',
  'researching',
  'outlining',
  'writing',
  'assembling',
  'done',
  'error',
  'canceled',
]);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  queued: 'Na fila',
  researching: 'Pesquisando',
  outlining: 'Montando o roteiro',
  writing: 'Escrevendo',
  assembling: 'Montando o documento',
  done: 'Concluído',
  error: 'Com erro',
  canceled: 'Cancelado',
};

export const REPORT_LIMITS = {
  maxBriefChars: 8_000,
  maxVariableChars: 2_000,
  maxInstructionsChars: 2_000,
  maxTitleChars: 300,
} as const;

export const reportCreateSchema = z.object({
  templateId: z.string().trim().min(1, 'Escolha um modelo').max(200),
  /** Values of the template's `{{variables}}` (defaults are applied by the server). */
  variables: z
    .record(z.string().max(40), z.string().max(REPORT_LIMITS.maxVariableChars))
    .default({}),
  /** Free instructions from the user (scope, focus, constraints). */
  brief: z.string().trim().max(REPORT_LIMITS.maxBriefChars).default(''),
  /** Model (or combo) used by every step of the generation. */
  model: z.string().trim().min(1, 'Escolha um modelo').max(200),
  /** Library consulted during the research (needs `research.useLibrary` in the template). */
  libraryId: z.string().trim().min(1).max(200).nullable().optional(),
  /** Overrides `research.useMcp` of the template. */
  useMcp: z.boolean().optional(),
  /** Chat that produced the request: its transcript and attachments feed the research. */
  conversationId: z.string().trim().min(1).max(200).optional(),
  /** Overrides the title built from the template's pattern. */
  title: z.string().trim().min(1).max(REPORT_LIMITS.maxTitleChars).optional(),
});
export type ReportCreateInput = z.infer<typeof reportCreateSchema>;
export type ReportCreatePayload = z.input<typeof reportCreateSchema>;

export const reportListQuerySchema = z.object({
  status: reportStatusSchema.optional(),
  kind: templateKindSchema.optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ReportListQuery = z.infer<typeof reportListQuerySchema>;

export const reportUpdateSchema = z.object({
  title: z.string().trim().min(1, 'Informe o título').max(REPORT_LIMITS.maxTitleChars),
});

export const reportSectionRegenerateSchema = z.object({
  instructions: z.string().trim().max(REPORT_LIMITS.maxInstructionsChars).default(''),
  model: z.string().trim().min(1).max(200).optional(),
});
export type ReportSectionRegenerateInput = z.infer<typeof reportSectionRegenerateSchema>;

export const reportToLibrarySchema = z.object({
  libraryId: z.string().trim().min(1).max(200),
});

const reportSettingFields = {
  /** Model preselected in the "novo relatório" dialog; '' = the first model option. */
  defaultModel: z.string().trim().max(200),
  /** Model that repairs broken Mermaid diagrams; '' = the history summary model, then the report's model. */
  repairModel: z.string().trim().max(200),
  /** Upper bound of research steps, whatever the template asks. */
  maxResearchSteps: z.number().int().min(1).max(20),
  /** Tool-call rounds inside one research step. */
  maxToolCallsPerStep: z.number().int().min(1).max(8),
  /** Output tokens of one section. */
  sectionMaxTokens: z.number().int().min(400).max(8000),
  /** Finished reports kept (oldest ones are pruned beyond this). */
  keepReports: z.number().int().min(10).max(5000),
  /** Chromium executable used for PDF and diagram rendering; '' = auto. */
  chromiumPath: z.string().trim().max(1000),
};
export const reportSettingsSchema = z.object({
  defaultModel: reportSettingFields.defaultModel.default(''),
  repairModel: reportSettingFields.repairModel.default(''),
  maxResearchSteps: reportSettingFields.maxResearchSteps.default(6),
  maxToolCallsPerStep: reportSettingFields.maxToolCallsPerStep.default(3),
  sectionMaxTokens: reportSettingFields.sectionMaxTokens.default(1800),
  keepReports: reportSettingFields.keepReports.default(200),
  chromiumPath: reportSettingFields.chromiumPath.default(''),
});
export type ReportSettings = z.infer<typeof reportSettingsSchema>;
/** Partial update: unlike `.partial()` on the schema above, it never fills in defaults. */
export const reportSettingsUpdateSchema = z.object(reportSettingFields).partial();

export interface ReportProgressDto {
  phase: ReportStatus;
  current: number;
  total: number;
  label: string;
}

export interface ReportSourceDto {
  kind: 'mcp' | 'library' | 'attachment';
  name: string;
  calls: number;
}

export interface ReportMetaDto {
  models: string[];
  sources: ReportSourceDto[];
  warnings: string[];
  limits: string[];
  diagrams: {
    total: number;
    rendered: number;
    repaired: number;
    failed: number;
    unvalidated: number;
  };
  libraryDocuments: { libraryId: string; documentId: string }[];
  generatedAt: number | null;
}

export interface ReportDto {
  id: string;
  title: string;
  kind: TemplateKind;
  templateId: string | null;
  templateName: string;
  status: ReportStatus;
  progress: ReportProgressDto;
  error: string | null;
  failedPhase: ReportStatus | null;
  cancelRequested: boolean;
  model: string;
  variables: Record<string, string>;
  libraryId: string | null;
  useMcp: boolean;
  conversationId: string | null;
  /** Research steps finished / planned (null until the plan exists). */
  researchDone: number;
  researchTotal: number | null;
  sectionCount: number;
  hasMarkdown: boolean;
  hasHtml: boolean;
  hasPdf: boolean;
  /** Where the generated HTML lives: waiting to be uploaded, or in the object store (null: n/a). */
  storage?: 'stored' | 'pending' | null;
  meta: ReportMetaDto;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ReportSectionDto {
  ordinal: number;
  title: string;
  role: 'section' | 'screen';
  status: 'pending' | 'writing' | 'done' | 'error';
  markdown: string;
  noteCount: number;
  model: string | null;
  providerId: string | null;
  warnings: string[];
  error: string | null;
  updatedAt: number;
}

export interface ReportDetailDto extends ReportDto {
  brief: string;
  /** Assembled document (Markdown); null until the assembly step runs. */
  markdown: string | null;
  sections: ReportSectionDto[];
  /** Research plan: what each step looked for. */
  plan: { objective: string; sections: number[] }[] | null;
  noteCount: number;
}

/** What the server can render: PDF and server-side diagram validation need Chromium. */
export interface ReportRendererStatusDto {
  pdf: boolean;
  diagrams: boolean;
  /** pt-BR explanation when something is unavailable. */
  reason: string | null;
  executablePath: string | null;
}

export interface ReportToLibraryResultDto {
  documentId: string;
  libraryId: string;
  name: string;
}
