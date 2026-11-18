import type {
  AgentPermission,
  AiReviewDecision,
  AiReviewDto,
  ChatMessageDto,
  ChatMode,
  ChatPreset,
  ChatStreamEvent,
  QueryResultDto,
  SqlValidationDto,
  TemplateKind,
} from '@thinkflow/shared';
import type { McpServer } from '../../mcp/domain/mcp-server';
import type { Vault } from '../../privacy/domain/vault';

export interface Conversation {
  id: string;
  title: string;
  mode: ChatMode;
  model: string;
  agentSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  parentConversationId: string | null;
  forkedFromMessageId: string | null;
  summary: ConversationSummary | null;
  agentCwd: string | null;
  agentPermissionMode: AgentPermission | null;
  /** Connected library (may dangle if the library was deleted). */
  libraryId: string | null;
  /** Document-template preset (may dangle if the template was deleted). */
  preset: ChatPreset | null;
  /** Mode `data`: Postgres connection queried (may dangle if the connection was deleted). */
  databaseId: string | null;
}

export interface ConversationSummary {
  text: string;
  throughMessageId: string | null;
  kind: 'llm' | 'extractive';
  updatedAt: number;
}

export interface ConversationListQuery {
  q?: string | undefined;
  mode?: ChatMode | undefined;
  /** chat = mode chat without a document preset; document = with one; agent/data = the mode. */
  origin?: 'chat' | 'document' | 'agent' | 'data' | undefined;
  databaseId?: string | undefined;
  /** `updatedAt` range (epoch ms, inclusive). */
  from?: number | undefined;
  to?: number | undefined;
  pinned?: boolean | undefined;
  limit: number;
  offset: number;
}

export type ConversationListItem = Conversation & { messageCount: number; preview: string };

export type ConversationPatch = Partial<
  Pick<
    Conversation,
    | 'title'
    | 'pinned'
    | 'summary'
    | 'agentSessionId'
    | 'agentCwd'
    | 'agentPermissionMode'
    | 'libraryId'
    | 'preset'
    | 'databaseId'
  >
>;

export type MessageMeta = ChatMessageDto['meta'];

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  meta: MessageMeta;
  createdAt: number;
}

export interface PrunedConversation {
  id: string;
  agentSessionId: string | null;
  agentCwd: string | null;
}

export interface ConversationRepository {
  list(query: ConversationListQuery): Promise<ConversationListItem[]>;
  findById(id: string): Promise<Conversation | null>;
  /** Upserts; on conflict only mode/model/agent fields/libraryId/preset/databaseId/updatedAt change (title, pin and summary use `update`). */
  save(conversation: Conversation): Promise<void>;
  update(id: string, patch: ConversationPatch): Promise<void>;
  /**
   * Deletes the oldest unpinned conversations so that at most `keep` remain (pinned ones count but are kept); returns the
   * deleted rows' agent transcripts so callers can clean them up too.
   */
  pruneOldest(keep: number): Promise<PrunedConversation[]>;
  delete(id: string): Promise<void>;
  messages(conversationId: string): Promise<StoredMessage[]>;
  addMessage(message: StoredMessage): Promise<void>;
  findMessage(id: string): Promise<StoredMessage | null>;
  updateMessageMeta(id: string, meta: MessageMeta): Promise<void>;
}

/** A tool the chat model may call (OpenAI function shape, minus the wrapper). */
export interface ChatToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatToolSet {
  tools: ChatToolDef[];
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }>;
}

/** Library tool for ONE turn (per-turn call counters live inside it). */
export interface LibraryChatTools extends ChatToolSet {
  libraryId: string;
  libraryName: string;
  /** Appended to the system prompt while the library is connected. */
  systemNote: string;
}

/** Port: the chat context reaches the document library only through this. */
export interface LibraryToolPort {
  /** `null` when the library no longer exists. */
  chatTools(libraryId: string, opts: { maxOutputChars: number }): Promise<LibraryChatTools | null>;
}

/** "Dados com IA" tools for ONE turn over one Postgres connection (read-only). */
export interface DataChatTools extends ChatToolSet {
  databaseId: string;
  databaseName: string;
  /** Appended to the data-mode system prompt (connection, schemas, what the AI may see). */
  systemNote: string;
  /**
   * Checks a SQL written in the model's answer (privacy tokens allowed) against the database
   * WITHOUT running it. `aiText` words the missing names for the model (null = nothing to fix).
   */
  validateSql?(
    sql: string,
    signal?: AbortSignal,
  ): Promise<{ validation: SqlValidationDto; aiText: string | null }>;
}

/**
 * Port: the chat context reaches Postgres connections only through this (implemented by the
 * `databases` context). Rows never reach the model beyond what the connection's `aiAccess` allows.
 */
export interface DataToolPort {
  /**
   * `null` when the connection no longer exists. `onResult` receives every query run by the tools
   * (full rows, for the screen) — the tool output given to the model is only a digest.
   */
  chatTools(
    databaseId: string,
    opts: {
      maxOutputChars: number;
      onResult: (result: QueryResultDto) => void;
      /** Reversible tokens of the conversation: what the model reads is tokenized with it. */
      vault?: Vault;
      /**
       * Asks the analyst which columns the model may see (blocks the tool call until answered);
       * resolves with the decisions, columns left out are tokenized.
       */
      requestReview?: (review: AiReviewDto, signal?: AbortSignal) => Promise<AiReviewDecision[]>;
    },
  ): Promise<DataChatTools | null>;
  /** The analyst's own SQL ("Executar SQL"): read-only, no AI. Never throws: errors go in `error`. */
  runDirect(databaseId: string, sql: string, signal?: AbortSignal): Promise<QueryResultDto>;
  /** Name of the connection (null when it no longer exists). */
  name(databaseId: string): Promise<string | null>;
}

/** A document started by the chat (background report job). */
export interface CreatedDocument {
  id: string;
  title: string;
  kind: TemplateKind;
}

/** Tools and instructions of a document-template mode for ONE turn (built from the stored template). */
export interface PresetChatTools extends ChatToolSet {
  templateName: string;
  /** Appended to the system prompt: interview the user, then call `gerar_documento`. */
  systemNote: string;
  /** Documents created by tool calls during this turn (at most one). */
  created(): CreatedDocument[];
  /**
   * Fallback for models without tool calling: reads `<gerar_documento>{...}</gerar_documento>` from
   * the answer, starts the generation and returns the text without the tag (plus a notice to show
   * when the directive could not be executed).
   */
  fromText(
    text: string,
  ): Promise<{ document: CreatedDocument | null; text: string; notice: string | null }>;
}

/** Port: the chat context reaches the document templates/reports only through this. */
export interface DocumentPresetPort {
  /** `null` when the template no longer exists. */
  chatTools(
    preset: ChatPreset,
    ctx: { conversationId: string; model: string; libraryId: string | null; useMcp: boolean },
  ): Promise<PresetChatTools | null>;
}

export type EmitFn = (event: ChatStreamEvent) => void;

export interface AgentRunParams {
  /** Conversation the turn belongs to (its privacy vault scope). */
  conversationId?: string;
  prompt: string;
  model: string;
  sessionId: string | null;
  permissionMode: AgentPermission;
  cwd: string;
  mcpServers: McpServer[];
  signal?: AbortSignal;
}

export interface AgentRunResult {
  sessionId: string | null;
  text: string;
  toolCalls: NonNullable<MessageMeta['toolCalls']>;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error?: string;
}

/** Port: runs one turn of the Claude Code agent loop. */
export interface AgentRunner {
  run(params: AgentRunParams, emit: EmitFn): Promise<AgentRunResult>;
  /** Best effort: removes the stored transcript of a session (the directory it ran in is needed). */
  deleteSession?(sessionId: string, cwd: string): Promise<void>;
}

export function titleFromPrompt(content: string): string {
  const firstLine = content.trim().split('\n')[0] ?? '';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine || 'Nova conversa';
}
