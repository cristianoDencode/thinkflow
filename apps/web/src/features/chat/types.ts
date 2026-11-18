import type {
  AiReviewClosedReason,
  AiReviewDto,
  ChatStep,
  ChatStepStatus,
  QueryResultMetaDto,
  SqlBlockValidationDto,
  TemplateKind,
} from '@thinkflow/shared';

export type StepState = ChatStepStatus | 'pending';

/** Name of the server-side library search tool (see the library context). */
export const LIBRARY_TOOL_NAME = 'buscar_na_biblioteca';

export interface UiToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
}

/** A query run in "Dados com IA": rows are present while streaming, absent after a reload. */
export type UiQueryResult = QueryResultMetaDto & { rows?: unknown[][] };

/** Mode `data`: a column review the analyst must answer (or that was closed without an answer). */
export interface UiReview {
  review: AiReviewDto;
  /** Why the server stopped waiting; undefined while the card is open. */
  closed?: AiReviewClosedReason;
}

export interface UiContextInfo {
  keptMessages: number;
  omittedMessages: number;
  summarized: boolean;
  estimatedTokens: number;
  budgetTokens: number;
}

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolCalls: UiToolCall[];
  steps?: Record<ChatStep, StepState>;
  streaming?: boolean;
  error?: string;
  providerId?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  feedback?: 'up' | 'down' | null;
  /** How much of the stored history was sent to the model for this answer. */
  context?: UiContextInfo;
  attachments?: { name: string; mimeType: string }[];
  /** Copied from the parent conversation when this one was derived. */
  carried?: boolean;
  /** Library consulted to produce this answer. */
  library?: { id: string; name: string };
  /** Document (report, summary, PRD, prototype) started by this turn: shown as a progress card. */
  report?: { id: string; title: string; kind: TemplateKind };
  /** Mode `data`: queries run on this turn (rows only until the conversation is reloaded). */
  queryResults?: UiQueryResult[];
  /** Mode `data`: result of the server's check of each SQL block of the answer (nothing was run). */
  sqlValidation?: SqlBlockValidationDto[];
  /** Mode `data`: what the analyst is asked to decide about unclassified columns. */
  reviews?: UiReview[];
  /** Mode `data`: SQL typed by the analyst, run without the AI (no thinking, no text). */
  direct?: boolean;
  /** Cached diagram repairs (hash -> repaired code, null = failed). */
  diagramRepairs?: Record<string, string | null>;
}

export const INITIAL_STEPS: Record<ChatStep, StepState> = {
  analyze: 'pending',
  search: 'pending',
  compose: 'pending',
};
