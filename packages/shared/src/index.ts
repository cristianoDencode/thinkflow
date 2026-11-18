import { z } from 'zod';
import { chatPresetSchema, type ChatPreset, type TemplateKind } from './templates';
import type { QueryResultDto, QueryResultMetaDto } from './databases';
import type { SqlBlockValidationDto } from './sql-blocks';
import {
  privacySettingsUpdateSchema,
  type AiReviewClosedReason,
  type AiReviewDto,
  type PrivacySettings,
} from './privacy';

export * from './diagrams';
export * from './templates';
export * from './reports';
export * from './storage';
export * from './tests';
export * from './test-text';
export * from './databases';
export * from './sql-blocks';
export * from './privacy';
export * from './onedrive';
export * from './prototypes';
export * from './prototype-assistant';
export * from './system-profiles';
export * from './prototype-import';
export * from './prototype-scene';
export * from './ct-assistant';
export * from './ct-fields';
export * from './ct-layout';
export * from './ct';
export * from './ct-menu-path';

/* ------------------------------------------------------------------ */
/* Provider catalog                                                    */
/* ------------------------------------------------------------------ */

export const wireFormatSchema = z.enum(['openai', 'anthropic']);
export type WireFormat = z.infer<typeof wireFormatSchema>;

export interface ProviderModelDto {
  id: string;
  name?: string;
  toolCalling?: boolean;
  free?: boolean;
}

export interface ProviderDto {
  id: string;
  name: string;
  format: WireFormat;
  baseUrl: string;
  requiresApiKey: boolean;
  requiresBaseUrl: boolean;
  freeTier: boolean;
  description: string;
  keyUrl?: string;
  suggestedModels: ProviderModelDto[];
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

export const connectionInputSchema = z.object({
  providerId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  apiKey: z.string().trim().max(4096).optional().default(''),
  baseUrl: z.string().trim().url().optional().or(z.literal('')).default(''),
  priority: z.number().int().min(0).max(1000).default(10),
  enabled: z.boolean().default(true),
  defaultModel: z.string().trim().max(200).optional().default(''),
});
export type ConnectionInput = z.input<typeof connectionInputSchema>;

export const connectionUpdateSchema = connectionInputSchema
  .omit({ providerId: true })
  .partial()
  .extend({ apiKey: z.string().trim().max(4096).optional() });
export type ConnectionUpdate = z.input<typeof connectionUpdateSchema>;

export type ConnectionStatus = 'ok' | 'cooldown' | 'error' | 'disabled' | 'untested';

export type QuotaMetric = 'requests' | 'tokens';
export type QuotaWindow = 'day' | 'minute' | 'unknown';

/** What a provider reported about a connection's quota (rate-limit headers or a 429 message). */
export interface QuotaSnapshotDto {
  metric: QuotaMetric;
  window: QuotaWindow;
  limit: number;
  /** Null when unknown, and always null for 'minute' windows (a stale remaining is misleading). */
  remaining: number | null;
  used: number | null;
  /** Epoch ms when the window refills; null when unknown. */
  resetAt: number | null;
  model: string | null;
  source: 'headers' | 'error';
  observedAt: number;
}

/** What this app itself sent through a connection since local midnight (server timezone). */
export interface ConnectionUsageTodayDto {
  requests: number;
  tokens: number;
}

export interface ConnectionDto {
  id: string;
  providerId: string;
  providerName: string;
  name: string;
  apiKeyPreview: string;
  baseUrl: string;
  priority: number;
  enabled: boolean;
  defaultModel: string;
  status: ConnectionStatus;
  cooldownUntil: number | null;
  backoffLevel: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastUsedAt: number | null;
  successCount: number;
  failureCount: number;
  createdAt: number;
  usageToday: ConnectionUsageTodayDto;
  quota: QuotaSnapshotDto[];
}

export interface TestConnectionResultDto {
  ok: boolean;
  message: string;
  latencyMs: number;
  models?: string[];
  quota?: QuotaSnapshotDto[];
  usageToday?: ConnectionUsageTodayDto;
}

/* ------------------------------------------------------------------ */
/* Combos                                                              */
/* ------------------------------------------------------------------ */

export const comboTargetSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().trim().min(1).max(200),
  connectionId: z.string().optional().nullable(),
});
export type ComboTarget = z.infer<typeof comboTargetSchema>;

export const comboStrategySchema = z.enum(['priority', 'round-robin']);
export type ComboStrategy = z.infer<typeof comboStrategySchema>;

export const comboInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-zA-Z0-9._/-]+$/, 'Use apenas letras, números, ".", "_", "-" e "/"'),
  strategy: comboStrategySchema.default('priority'),
  targets: z.array(comboTargetSchema).min(1),
});
export type ComboInput = z.input<typeof comboInputSchema>;

export interface ComboDto {
  id: string;
  name: string;
  strategy: ComboStrategy;
  targets: ComboTarget[];
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Request logs                                                        */
/* ------------------------------------------------------------------ */

export interface RequestAttemptDto {
  providerId: string;
  model: string;
  connectionId: string | null;
  status?: number;
  reason: string;
  message?: string;
}

export interface RequestLogDto {
  id: string;
  createdAt: number;
  source: string;
  requestedModel: string;
  providerId: string | null;
  model: string | null;
  connectionId: string | null;
  success: boolean;
  httpStatus: number | null;
  reason: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  attempts: RequestAttemptDto[];
}

/* ---------------------------- usage ---------------------------- */

export interface UsageReportDto {
  /** 'YYYY-MM' */
  month: string;
  current: boolean;
  daysInMonth: number;
  daysElapsed: number;
  /** Start of the next month (ms) — when the counter resets. */
  resetsAt: number;
  totals: {
    requests: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedRequests: number;
  };
  previous: { totalTokens: number; requests: number } | null;
  daily: {
    day: string;
    inputTokens: number;
    outputTokens: number;
    requests: number;
    failures: number;
  }[];
  byProvider: {
    providerId: string;
    requests: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
  }[];
  byModel: {
    providerId: string;
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }[];
  bySource: { source: string; requests: number; totalTokens: number }[];
  projection: {
    basis: 'month' | 'last7days';
    basisDays: number;
    daily: number;
    weekly: number;
    monthly: number;
    yearly: number;
  };
  budget: { monthlyTokens: number; usedPct: number; projectedPct: number } | null;
}

export interface UsageMonthsDto {
  current: string;
  months: string[];
}

export const usageBudgetSchema = z.object({
  /** Monthly token budget; 0 removes it. */
  monthlyTokens: z.number().int().min(0).max(1_000_000_000_000),
});

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

export const mcpServerInputSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-zA-Z0-9_-]+$/, 'Use apenas letras, números, "_" e "-"'),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
  }),
  z.object({
    transport: z.literal('http'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-zA-Z0-9_-]+$/, 'Use apenas letras, números, "_" e "-"'),
    url: z.string().trim().url(),
    headers: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
  }),
]);
export type McpServerInput = z.input<typeof mcpServerInputSchema>;

export interface McpToolDto {
  name: string;
  description?: string;
}

export interface McpServerDto {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  envKeys?: string[];
  url?: string;
  headerKeys?: string[];
  enabled: boolean;
  createdAt: number;
}

export interface McpTestResultDto {
  ok: boolean;
  message: string;
  tools: McpToolDto[];
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

/** `data` = "Dados com IA" (read-only assistant over a Postgres connection). */
export const chatModeSchema = z.enum(['chat', 'agent', 'data']);
export type ChatMode = z.infer<typeof chatModeSchema>;

export const agentPermissionSchema = z.enum([
  'plan',
  'default',
  'acceptEdits',
  'bypassPermissions',
]);
export type AgentPermission = z.infer<typeof agentPermissionSchema>;

export const chatAttachmentSchema = z.object({
  name: z.string().max(255),
  mimeType: z.string().max(120),
  /** data URL for images, plain text for text files */
  data: z.string().max(8_000_000),
});
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;

export const chatRequestSchema = z.object({
  conversationId: z.string().optional(),
  mode: chatModeSchema.default('chat'),
  model: z.string().trim().min(1),
  content: z.string().trim().min(1).max(200_000),
  attachments: z.array(chatAttachmentSchema).max(10).default([]),
  useMcp: z.boolean().default(true),
  /** `undefined` keeps the conversation's library, `null` disconnects it. */
  libraryId: z.string().min(1).nullable().optional(),
  /**
   * Document-template mode (chat only). `undefined` keeps the conversation's preset, `null` clears
   * it. Only ids travel: the server builds the instructions from the stored template.
   */
  preset: chatPresetSchema.nullable().optional(),
  /** Mode `data`: the Postgres connection (`undefined` keeps the conversation's). */
  databaseId: z.string().min(1).optional(),
  /** Mode `data`: `content` is SQL typed by the analyst, run read-only without the AI. */
  directSql: z.boolean().optional(),
  agent: z
    .object({
      permissionMode: agentPermissionSchema.default('plan'),
      cwd: z.string().trim().optional(),
    })
    .optional(),
});
export type ChatRequestInput = z.input<typeof chatRequestSchema>;

export type ChatStep = 'analyze' | 'search' | 'compose';
export type ChatStepStatus = 'active' | 'done' | 'skipped';

export type ChatStreamEvent =
  | { type: 'conversation'; conversationId: string; title: string }
  | { type: 'step'; step: ChatStep; status: ChatStepStatus }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean }
  | {
      type: 'done';
      messageId: string;
      providerId?: string | null;
      model?: string | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      costUsd?: number | null;
    }
  | {
      type: 'context';
      /** Messages from the stored history sent verbatim to the model. */
      keptMessages: number;
      /** Older messages left out (covered by the rolling summary). */
      omittedMessages: number;
      /** True when a rolling summary of the older messages is part of the context. */
      summarized: boolean;
      estimatedTokens: number;
      budgetTokens: number;
    }
  /** A background document (report/summary/PRD/prototype) was started from this turn. */
  | { type: 'report'; reportId: string; title: string; kind: TemplateKind }
  /** Mode `data`: a query ran (full rows for the screen; the AI only got a digest). */
  | { type: 'query_result'; result: QueryResultDto }
  /**
   * Mode `data`: the answer ended and its SQL blocks were checked against the database (nothing
   * ran). Sent once, before `done`; also stored in the message meta (`sqlValidation`).
   */
  | { type: 'sql_validation'; blocks: SqlBlockValidationDto[] }
  /**
   * Mode `data`: the model is rewriting its last draft because its SQL named things that do not
   * exist. The client keeps only the first `keepChars` characters of the answer; the rewrite follows.
   */
  | { type: 'answer_rewrite'; keepChars: number }
  /** Mode `data`: the analyst must decide what the AI gets of some columns (blocks the tool call). */
  | { type: 'ai_review'; review: AiReviewDto }
  | { type: 'ai_review_closed'; reviewId: string; reason: AiReviewClosedReason }
  | { type: 'error'; message: string };

export interface ChatMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  meta: {
    providerId?: string | null;
    model?: string | null;
    toolCalls?: { id: string; name: string; input: unknown; output?: string; isError?: boolean }[];
    attachments?: { name: string; mimeType: string; excerpt?: string }[];
    feedback?: 'up' | 'down' | null;
    /** Copied from the parent conversation when this one was forked. */
    carried?: boolean;
    /** Library consulted on this turn (assistant messages). */
    library?: { id: string; name: string };
    /** Document started by this turn (progress card in the chat). */
    report?: { id: string; title: string; kind: TemplateKind };
    /** Cached diagram repairs: hashDiagram(code) -> repaired code, or null = known failure (max 20). */
    diagramRepairs?: Record<string, string | null>;
    /** Mode `data`: queries run on this turn, without their rows ("Executar de novo" fetches them). */
    queryResults?: QueryResultMetaDto[];
    /** Mode `data`: result of checking each SQL block of the answer (nothing was run). */
    sqlValidation?: SqlBlockValidationDto[];
  };
}

/* Diagrams */

export const diagramRepairSchema = z.object({
  code: z.string().min(1).max(20_000),
  error: z.string().max(2_000).default(''),
  model: z.string().min(1).max(200),
  messageId: z.string().min(1).max(100).optional(),
});
export type DiagramRepairInput = z.infer<typeof diagramRepairSchema>;

export interface DiagramRepairResultDto {
  /** Repaired Mermaid source, or null when the model could not fix it. */
  code: string | null;
  repaired: boolean;
}

export interface ConversationDto {
  id: string;
  title: string;
  mode: ChatMode;
  model: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  parentConversationId: string | null;
  forkedFromMessageId: string | null;
  messageCount: number;
  preview: string;
  hasSummary: boolean;
  libraryId: string | null;
  /** Document-template preset (report/summary/PRD/prototype chat modes), if any. */
  preset: ChatPreset | null;
  /** Mode `data`: the Postgres connection the conversation queries. */
  databaseId: string | null;
}

export interface ConversationSummaryDto {
  text: string;
  kind: 'llm' | 'extractive';
  throughMessageId: string | null;
  updatedAt: number;
}

export interface ConversationDetailDto extends ConversationDto {
  messages: ChatMessageDto[];
  summary: ConversationSummaryDto | null;
  parentTitle: string | null;
  agent: { cwd: string | null; permissionMode: AgentPermission | null };
}

/**
 * Where a conversation came from (History label and filter): `chat` = "Pergunte à AI" without a
 * document template, `document` = chat in a document-template mode, `agent`, `data` = "Dados com IA".
 */
export const conversationOriginSchema = z.enum(['chat', 'document', 'agent', 'data']);
export type ConversationOrigin = z.infer<typeof conversationOriginSchema>;

export function conversationOrigin(c: {
  mode: ChatMode;
  preset: ChatPreset | null;
}): ConversationOrigin {
  if (c.mode === 'chat') return c.preset ? 'document' : 'chat';
  return c.mode;
}

export const conversationListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  mode: chatModeSchema.optional(),
  origin: conversationOriginSchema.optional(),
  /** Mode `data`: only conversations on this Postgres connection. */
  databaseId: z.string().trim().min(1).max(100).optional(),
  /** Last activity (`updatedAt`, epoch ms) within [from, to]. */
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  pinned: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

export const conversationUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((v) => v.title !== undefined || v.pinned !== undefined, 'Nada para atualizar');
export type ConversationUpdateInput = z.infer<typeof conversationUpdateSchema>;

export const conversationForkSchema = z.object({
  /** Assistant message of the conversation the fork starts from (inclusive). */
  messageId: z.string().min(1),
  title: z.string().trim().min(1).max(120).optional(),
});
export type ConversationForkInput = z.infer<typeof conversationForkSchema>;

/* ------------------------------------------------------------------ */
/* Identity / settings                                                 */
/* ------------------------------------------------------------------ */

export const setupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().max(80).default(''),
  password: z.string().min(8).max(200),
});
export type SetupInput = z.input<typeof setupSchema>;

export const loginSchema = z.object({ password: z.string().min(1).max(200) });

export const profileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().max(80).default(''),
});

export interface AuthStatusDto {
  setupRequired: boolean;
  authenticated: boolean;
  user: { name: string; title: string } | null;
}

export const apiKeyInputSchema = z.object({ name: z.string().trim().min(1).max(80) });

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export const modelAliasesSchema = z.object({
  default: z.string().trim().default(''),
  opus: z.string().trim().default(''),
  sonnet: z.string().trim().default(''),
  haiku: z.string().trim().default(''),
});
export type ModelAliases = z.infer<typeof modelAliasesSchema>;

const historySettingFields = {
  /** Max input tokens (estimate) sent to the model; a smaller learned provider limit wins. */
  contextBudgetTokens: z.number().int().min(2000).max(1_000_000),
  /** Recent turns always kept verbatim when older ones are summarized. */
  recentTurns: z.number().int().min(1).max(50),
  /** Model used to write rolling summaries; empty = the conversation's own model. */
  summaryModel: z.string().trim().max(200),
  /** Conversations kept (oldest unpinned ones are pruned beyond this). */
  maxConversations: z.number().int().min(10).max(10_000),
};
export const historySettingsSchema = z.object({
  contextBudgetTokens: historySettingFields.contextBudgetTokens.default(16_000),
  recentTurns: historySettingFields.recentTurns.default(6),
  summaryModel: historySettingFields.summaryModel.default(''),
  maxConversations: historySettingFields.maxConversations.default(500),
});
/** Partial update: unlike `.partial()` on the schema above, it never fills in defaults. */
export const historySettingsUpdateSchema = z.object(historySettingFields).partial();
export type HistorySettings = z.infer<typeof historySettingsSchema>;

export interface SettingsDto {
  aliases: ModelAliases;
  agentDefaultCwd: string;
  baseUrl: string;
  history: HistorySettings;
  privacy: PrivacySettings;
}

export const settingsUpdateSchema = z.object({
  aliases: modelAliasesSchema.optional(),
  agentDefaultCwd: z.string().trim().max(1000).optional(),
  history: historySettingsUpdateSchema.optional(),
  privacy: privacySettingsUpdateSchema.optional(),
});

export interface ModelOptionDto {
  id: string;
  label: string;
  kind: 'combo' | 'model';
  toolCalling?: boolean;
}

export interface HealthDto {
  status: 'ok';
  version: string;
  uptimeSec: number;
}

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */

export const LIBRARY_LIMITS = {
  maxLibraries: 100,
  /** Documents in a local library (the SQLite FTS5 index scales well past this). */
  maxLocalDocuments: 1000,
  /** NotebookLM libraries when the account's own limit is unknown (the Free plan). */
  defaultNotebookLmSources: 50,
  maxFileBytes: 20 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024,
  maxDocumentChars: 1_500_000,
  maxLibraryChars: 60_000_000,
  maxFilesPerUpload: 10,
  maxOcrPdfPages: 30,
} as const;

export const LIBRARY_ACCEPT = '.pdf,.docx,.md,.markdown,.txt,.png,.jpg,.jpeg,.webp';

export const libraryEngineSchema = z.enum(['local', 'notebooklm']);
export type LibraryEngine = z.infer<typeof libraryEngineSchema>;

/**
 * How many documents a library of this engine may hold. Local libraries have a fixed (high) limit;
 * NotebookLM libraries follow the connected account's source limit per notebook (Free = 50 when
 * unknown).
 */
export function maxDocumentsFor(
  engine: LibraryEngine,
  notebookLmSourceLimit?: number | null,
): number {
  if (engine === 'local') return LIBRARY_LIMITS.maxLocalDocuments;
  return notebookLmSourceLimit && notebookLmSourceLimit > 0
    ? Math.floor(notebookLmSourceLimit)
    : LIBRARY_LIMITS.defaultNotebookLmSources;
}

/** Plan of the Google account behind NotebookLM. `auto` = use what the account reports. */
export const notebookLmPlanSchema = z.enum([
  'auto',
  'free',
  'plus',
  'pro',
  'ultra20',
  'ultra30',
  'workspace',
]);
export type NotebookLmPlan = z.infer<typeof notebookLmPlanSchema>;
export type NotebookLmPlanKey = Exclude<NotebookLmPlan, 'auto'>;

export interface NotebookLmPlanInfo {
  label: string;
  /** The `tier` key notebooklm-py reports for this plan (opaque, not an ordinal). */
  tier: number;
  notebooks: number;
  sourcesPerNotebook: number;
  chatsPerDay: number;
}

/** Published limits (notebooklm-py docs/quota-limits.md, 2026-07-09). Google may change them. */
export const NOTEBOOKLM_PLANS: Record<NotebookLmPlanKey, NotebookLmPlanInfo> = {
  free: { label: 'Gratuito', tier: 1, notebooks: 100, sourcesPerNotebook: 50, chatsPerDay: 50 },
  plus: { label: 'Plus', tier: 4, notebooks: 200, sourcesPerNotebook: 100, chatsPerDay: 200 },
  pro: { label: 'Pro', tier: 2, notebooks: 500, sourcesPerNotebook: 300, chatsPerDay: 500 },
  ultra20: {
    label: 'Ultra 20 TB',
    tier: 3,
    notebooks: 500,
    sourcesPerNotebook: 500,
    chatsPerDay: 2500,
  },
  ultra30: {
    label: 'Ultra 30 TB',
    tier: 6,
    notebooks: 500,
    sourcesPerNotebook: 600,
    chatsPerDay: 5000,
  },
  workspace: {
    label: 'Workspace Expanded',
    tier: 5,
    notebooks: 500,
    sourcesPerNotebook: 400,
    chatsPerDay: 1000,
  },
};

export const NOTEBOOKLM_PLAN_LABELS: Record<NotebookLmPlan, string> = {
  auto: 'Automático (detectar)',
  free: NOTEBOOKLM_PLANS.free.label,
  plus: NOTEBOOKLM_PLANS.plus.label,
  pro: NOTEBOOKLM_PLANS.pro.label,
  ultra20: NOTEBOOKLM_PLANS.ultra20.label,
  ultra30: NOTEBOOKLM_PLANS.ultra30.label,
  workspace: NOTEBOOKLM_PLANS.workspace.label,
};

/** The plan whose `tier` key matches what notebooklm-py reported, or null for an unknown tier. */
export function notebookLmPlanForTier(tier: number | null | undefined): NotebookLmPlanKey | null {
  if (tier === null || tier === undefined) return null;
  const found = (Object.keys(NOTEBOOKLM_PLANS) as NotebookLmPlanKey[]).find(
    (key) => NOTEBOOKLM_PLANS[key].tier === tier,
  );
  return found ?? null;
}

export const libraryInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  engine: libraryEngineSchema.default('local'),
  /** Must be true when engine = notebooklm (documents leave the server). */
  acceptRemoteUpload: z.boolean().default(false),
});
export type LibraryInput = z.input<typeof libraryInputSchema>;

export const libraryUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, 'Nada para atualizar');
export type LibraryUpdateInput = z.infer<typeof libraryUpdateSchema>;

export type LibraryDocumentStatus = 'processing' | 'ready' | 'error';
export type LibraryDocumentKind = 'pdf' | 'docx' | 'markdown' | 'text' | 'image';
export type LibraryExtractionMethod = 'text' | 'ocr-local' | 'ocr-vision';
export type LibraryRemoteStatus = 'pending' | 'syncing' | 'synced' | 'error';

export interface LibraryDocumentDto {
  id: string;
  libraryId: string;
  name: string;
  mimeType: string;
  kind: LibraryDocumentKind;
  sizeBytes: number;
  status: LibraryDocumentStatus;
  error: string | null;
  extraction: LibraryExtractionMethod | null;
  pageCount: number | null;
  charCount: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
  remote: { status: LibraryRemoteStatus; error: string | null } | null;
}

export interface LibraryDto {
  id: string;
  name: string;
  description: string;
  engine: LibraryEngine;
  documentCount: number;
  /** Documents this library may hold: fixed for local ones, the account's source limit for NotebookLM. */
  maxDocuments: number;
  readyCount: number;
  processingCount: number;
  errorCount: number;
  totalChars: number;
  createdAt: number;
  updatedAt: number;
  remoteNotebookId: string | null;
}

export interface LibraryDetailDto extends LibraryDto {
  documents: LibraryDocumentDto[];
}

export interface LibraryUploadResultDto {
  accepted: LibraryDocumentDto[];
  rejected: { name: string; reason: string }[];
}

export const librarySearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  k: z.coerce.number().int().min(1).max(8).default(5),
});
export type LibrarySearchQuery = z.infer<typeof librarySearchQuerySchema>;

export interface LibrarySearchHitDto {
  documentId: string;
  documentName: string;
  heading: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  excerpt: string;
  score: number;
}

export interface LibrarySearchResultDto {
  engine: LibraryEngine;
  hits: LibrarySearchHitDto[];
  /** Exactly what the AI receives from the tool. */
  toolOutput: string;
  isError: boolean;
}

/** Extracted text preview of a document (chunks joined, paginated by characters). */
export interface LibraryDocumentTextDto {
  text: string;
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export const libraryTextQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(20_000).default(20_000),
});

export const librarySettingsSchema = z.object({
  ocr: z.enum(['local', 'vision', 'off']).default('local'),
  /** Model used when ocr = 'vision'; '' = first model option. */
  ocrModel: z.string().trim().max(200).default(''),
  ocrLanguages: z
    .string()
    .trim()
    .regex(/^[a-z_]+(\+[a-z_]+)*$/)
    .default('por+eng'),
});
export type LibrarySettings = z.infer<typeof librarySettingsSchema>;

export interface NotebookLmDetectionDto {
  /** When the account limits were last read from the account (null = never). */
  at: number | null;
  sourceLimit: number | null;
  notebookLimit: number | null;
  tier: number | null;
  /** Plan label for the reported tier, when it is a known one. */
  planLabel: string | null;
  /** Why the last attempt could not read the limits (pt-BR), or null. */
  unavailableReason: string | null;
}

export interface NotebookLmSettingsDto {
  enabled: boolean;
  hasCredentials: boolean;
  credentialsUpdatedAt: number | null;
  cliCommand: string;
  /** Plan chosen by the user; `auto` uses the detected limits. */
  plan: NotebookLmPlan;
  detection: NotebookLmDetectionDto;
  /** Effective limits: detected → chosen plan → Free. */
  sourceLimit: number;
  notebookLimit: number;
  /** Effective daily query limit (a custom value, or the plan's chats per day). */
  dailyQueryLimit: number;
  /** The user typed their own daily limit instead of following the plan. */
  dailyQueryLimitCustom: boolean;
  queriesToday: number;
  timeoutSec: number;
  fallbackToLocal: boolean;
  lastCheck: { at: number; ok: boolean; message: string; account?: string | null } | null;
  /** The server can open a browser window for the Google login (a display is available). */
  loginSupported: boolean;
  /** The CLI's own profile (`~/.notebooklm/profiles/<p>/storage_state.json`) exists on the server machine. */
  localProfileAvailable: boolean;
}

export type NotebookLmLoginState = 'idle' | 'waiting' | 'done' | 'error' | 'unsupported';

export interface NotebookLmLoginStatusDto {
  state: NotebookLmLoginState;
  message: string;
}

export const notebookLmSettingsUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  /** Content of Playwright's storage_state.json (write-only). */
  authJson: z.string().max(500_000).optional(),
  cliCommand: z.string().trim().min(1).max(500).optional(),
  plan: notebookLmPlanSchema.optional(),
  /** `null` goes back to the plan's chats per day. */
  dailyQueryLimit: z.number().int().min(1).max(10_000).nullable().optional(),
  timeoutSec: z.number().int().min(15).max(300).optional(),
  fallbackToLocal: z.boolean().optional(),
});
export type NotebookLmSettingsUpdate = z.infer<typeof notebookLmSettingsUpdateSchema>;
