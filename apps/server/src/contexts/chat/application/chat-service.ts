import {
  aiReviewAnswerSchema,
  chatRequestSchema,
  conversationForkSchema,
  conversationListQuerySchema,
  conversationUpdateSchema,
  DIAGRAM_PROMPT_RULES,
  normalizeDiagrams,
  type ChatAttachment,
  type ChatMessageDto,
  type ChatStreamEvent,
  type ConversationDetailDto,
  type ConversationDto,
  type ConversationSummaryDto,
  type HistorySettings,
  type QueryResultDto,
  type QueryResultMetaDto,
  type SqlBlockValidationDto,
} from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import type { IdGenerator } from '../../../shared/kernel/ids';
import { DomainError, NotFoundError } from '../../../shared/kernel/errors';
import type { McpService, Toolset } from '../../mcp/application/mcp-service';
import { convertStream, tapUsage, type UsageTotals } from '../../protocol/domain/convert';
import { safeJsonParse } from '../../protocol/domain/request-translators';
import { applyToolCallDelta } from '../../protocol/domain/tool-call-accumulation';
import type {
  OAIChunk,
  OAIContentPart,
  OAIMessage,
  OAIRequest,
  OAIToolCall,
} from '../../protocol/domain/wire-types';
import type { VaultStore } from '../../privacy/domain/ports';
import { restore } from '../../privacy/domain/tokenizer';
import type { RouteChatRequest } from '../../routing/application/route-chat-request';
import {
  buildCarryOver,
  buildContextWindow,
  estimateRequestTokens,
  extractiveSummary,
  groupTurns,
  resolveContextBudget,
  type ContextWindow,
} from '../domain/context-window';
import { HistorySummarizer, type Summarizer } from './history-summarizer';
import { checkAnswerSql } from './answer-sql-check';
import { ReviewBroker } from './review-broker';
import { combineToolsets, type Toolbox } from './toolbox';
import { DATA_SYSTEM_PROMPT } from '../domain/data-prompt';
import {
  titleFromPrompt,
  type AgentRunner,
  type Conversation,
  type ConversationListItem,
  type DataChatTools,
  type DataToolPort,
  type ConversationRepository,
  type CreatedDocument,
  type DocumentPresetPort,
  type EmitFn,
  type LibraryChatTools,
  type LibraryToolPort,
  type MessageMeta,
  type PresetChatTools,
  type StoredMessage,
} from '../domain/conversation';

const MAX_TOOL_ITERATIONS = 8;
/** Data exploration (catalog, columns, queries) needs more rounds than a plain chat. */
const MAX_DATA_TOOL_ITERATIONS = 14;
const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_DIAGRAM_REPAIRS = 20;

export const SYSTEM_PROMPT = [
  'Você é o Thinkflow, um assistente para analistas e desenvolvedores.',
  'Responda em português do Brasil, de forma clara e objetiva, usando Markdown quando ajudar.',
  'Quando houver ferramentas disponíveis (servidores MCP), use-as sempre que precisar de dados externos e explique brevemente o que fez.',
  DIAGRAM_PROMPT_RULES,
].join(' ');

export interface ChatServiceDeps {
  conversations: ConversationRepository;
  router: RouteChatRequest;
  mcp: McpService;
  agent: AgentRunner;
  clock: Clock;
  ids: IdGenerator;
  defaultAgentCwd: () => string;
  /** Current history/context settings (read on every turn). */
  historySettings: () => HistorySettings;
  /** Largest input the router knows the model's candidates accept (estimate units), if known. */
  inputLimitHint?: (model: string) => Promise<number | undefined>;
  /** Defaults to an LLM summarizer on top of `router`. */
  summarizer?: Summarizer;
  /** Document library tool (optional: chat works without it). */
  library?: LibraryToolPort;
  /** Document-template modes (optional: chat works without them). */
  presets?: DocumentPresetPort;
  /** Postgres connections of "Dados com IA" (optional: the `data` mode needs it). */
  data?: DataToolPort;
  /**
   * Privacy vaults (reversible tokens). A conversation's vault scope (`scopeId` = conversation id)
   * is deleted together with it. Optional: chat works without the firewall.
   */
  vaults?: VaultStore;
  /** How long an `ai_review` waits for the analyst (default 5 min); tests shorten it. */
  reviewTimeoutMs?: number;
}

const NO_DATABASE_MESSAGE = 'Escolha uma conexão de banco em Database.';

/** Mode-specific system prompt (also used to size forks). */
function basePromptFor(mode: Conversation['mode']): string {
  return mode === 'data' ? DATA_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

/** What one chat/data turn works with: system prompt text, callable tools and the per-mode tool sets. */
interface TurnKit {
  prompt: string;
  toolbox: Toolbox | null;
  library: LibraryChatTools | null;
  preset: PresetChatTools | null;
  data: DataChatTools | null;
}

/** Stored copy of a text attachment, so later turns still see the document. */
const MAX_ATTACHMENT_EXCERPT_CHARS = 20_000;
/** A fork carries at most this many of the latest turns verbatim; the rest becomes a summary. */
const FORK_MAX_CARRIED_TURNS = 3;
/** Hard limits that keep a single conversation from growing without bound. */
const MAX_STORED_ASSISTANT_CHARS = 200_000;
const MAX_MESSAGES_PER_CONVERSATION = 2_000;
const FORK_TITLE_SUFFIX = ' (derivada)';
/** Share of the budget (in chars) one live tool output may take inside a turn. */
const LIVE_TOOL_OUTPUT_SHARE = 0.25;
/** Cap (tokens) of the carry-over that seeds a new agent session. */
const AGENT_CARRY_MAX_TOKENS = 8_000;
/** What Claude Code prints when `resume` points at a session it cannot load ("No conversation found with session ID: ..."). */
const SESSION_LOST =
  /no conversation found|failed to resume session|session\b.{0,40}\b(not found|does not exist|não encontrad)/i;

export class ChatService {
  private readonly summarizer: Summarizer;
  /** `ai_review` cards waiting for the analyst (data mode). */
  private readonly reviews: ReviewBroker;

  constructor(private readonly deps: ChatServiceDeps) {
    this.summarizer = deps.summarizer ?? new HistorySummarizer(deps.router);
    this.reviews = new ReviewBroker(deps.reviewTimeoutMs);
  }

  /** The analyst's answer to an `ai_review`; `NotFoundError` when it is gone (answered/timed out/aborted). */
  answerReview(reviewId: string, body: unknown): void {
    const { decisions } = aiReviewAnswerSchema.parse(body);
    if (!this.reviews.answer(reviewId, decisions)) throw new NotFoundError('Revisão');
  }

  async list(query: unknown = {}): Promise<ConversationDto[]> {
    const parsed = conversationListQuerySchema.parse(query);
    return (await this.deps.conversations.list(parsed)).map(toConversationDto);
  }

  async get(id: string): Promise<ConversationDetailDto> {
    const conversation = await this.deps.conversations.findById(id);
    if (!conversation) throw new NotFoundError('Conversa');
    const messages = await this.deps.conversations.messages(id);
    const vault = this.deps.vaults?.forScope(id);
    const parent = conversation.parentConversationId
      ? await this.deps.conversations.findById(conversation.parentConversationId)
      : null;
    return {
      ...toConversationDto({
        ...conversation,
        messageCount: messages.length,
        preview: messages.at(-1)?.content.slice(0, 160) ?? '',
      }),
      // answers are stored with real values (the router restores them); a token that is still
      // there (older data-mode turns) is resolved here, for the analyst's eyes only
      messages: messages.map((m) =>
        toMessageDto(
          vault && m.role === 'assistant' && m.content.includes('[')
            ? { ...m, content: restore(m.content, vault) }
            : m,
        ),
      ),
      summary: conversation.summary ? toSummaryDto(conversation.summary) : null,
      parentTitle: parent?.title ?? null,
      agent: { cwd: conversation.agentCwd, permissionMode: conversation.agentPermissionMode },
    };
  }

  async update(id: string, input: unknown): Promise<ConversationDto> {
    const patch = conversationUpdateSchema.parse(input);
    if (!(await this.deps.conversations.findById(id))) throw new NotFoundError('Conversa');
    await this.deps.conversations.update(id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    });
    const { messages: _messages, ...dto } = await this.get(id);
    const { summary: _summary, parentTitle: _parentTitle, agent: _agent, ...rest } = dto;
    return rest;
  }

  /**
   * Derives a new conversation from an assistant message: the older part of the history becomes
   * a summary and only the last few turns are copied (flagged `carried`). The parent is untouched.
   */
  async fork(id: string, input: unknown): Promise<ConversationDto> {
    const body = conversationForkSchema.parse(input);
    const parent = await this.deps.conversations.findById(id);
    if (!parent) throw new NotFoundError('Conversa');
    const history = await this.deps.conversations.messages(id);
    const index = history.findIndex((m) => m.id === body.messageId);
    if (index < 0) throw new NotFoundError('Mensagem');
    if (history[index]!.role !== 'assistant')
      throw new DomainError(
        'Só é possível derivar a partir de uma resposta do assistente',
        'invalid_fork_point',
      );

    const upTo = history.slice(0, index + 1);
    const settings = this.deps.historySettings();
    const budget = resolveContextBudget({
      configured: settings.contextBudgetTokens,
      learnedLimit: await this.deps.inputLimitHint?.(parent.model),
    });
    const recentTurns = Math.min(settings.recentTurns, FORK_MAX_CARRIED_TURNS);
    // candidates: the last turns; the window then trims them to half the budget
    const candidates = groupTurns(upTo).slice(-recentTurns).flat();
    const window = buildContextWindow({
      history: candidates,
      summary: null,
      budget: Math.floor(budget / 2),
      fixedTokens: estimateRequestTokens([{ role: 'system', content: basePromptFor(parent.mode) }]),
      recentTurns,
    });
    const keep = new Set(window.keptMessageIds);
    const carried = candidates.filter((m) => keep.has(m.id));
    const firstCarried = carried[0] ? upTo.findIndex((m) => m.id === carried[0]!.id) : upTo.length;
    const older = upTo.slice(0, firstCarried);

    let summary: Conversation['summary'] = null;
    if (older.length > 0) {
      const covered = parent.summary?.throughMessageId
        ? older.findIndex((m) => m.id === parent.summary!.throughMessageId)
        : -1;
      const delta = covered >= 0 ? older.slice(covered + 1) : older;
      const previous = covered >= 0 ? parent.summary!.text : null;
      const now = this.deps.clock.now();
      if (delta.length === 0 && previous !== null) {
        summary = {
          text: previous,
          throughMessageId: null,
          kind: parent.summary!.kind,
          updatedAt: now,
        };
      } else {
        const result = await this.summarizeWithFallback(
          previous,
          delta,
          settings.summaryModel || parent.model,
          undefined,
          parent.id,
        );
        summary = { text: result.text, throughMessageId: null, kind: result.kind, updatedAt: now };
      }
    }

    const now = this.deps.clock.now();
    const base = `${parent.title}`.slice(0, 120 - FORK_TITLE_SUFFIX.length);
    const fork: Conversation = {
      id: this.deps.ids.next(),
      title: body.title ?? `${base}${FORK_TITLE_SUFFIX}`,
      mode: parent.mode,
      model: parent.model,
      agentSessionId: null,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      parentConversationId: parent.id,
      forkedFromMessageId: body.messageId,
      summary: null,
      agentCwd: parent.agentCwd,
      agentPermissionMode: parent.agentPermissionMode,
      libraryId: parent.libraryId,
      preset: parent.preset,
      databaseId: parent.databaseId,
    };
    await this.deps.conversations.save(fork);
    // the fork starts with the parent's tokens (same numbers): carried tool outputs keep resolving
    this.deps.vaults?.copyScope(parent.id, fork.id);
    this.prune();
    if (summary) await this.deps.conversations.update(fork.id, { summary });
    // strictly increasing timestamps keep the order stable; they end just before `now`
    for (const [i, m] of carried.entries()) {
      const { feedback: _feedback, ...meta } = m.meta;
      await this.deps.conversations.addMessage({
        id: this.deps.ids.next(),
        conversationId: fork.id,
        role: m.role,
        content: m.content,
        meta: { ...meta, carried: true },
        createdAt: now - (carried.length - i),
      });
    }
    const created = await this.deps.conversations.findById(fork.id);
    return toConversationDto({
      ...(created ?? fork),
      messageCount: carried.length,
      preview: carried.at(-1)?.content.slice(0, 160) ?? '',
    });
  }

  async delete(id: string): Promise<void> {
    const conversation = await this.deps.conversations.findById(id);
    await this.deps.conversations.delete(id);
    this.forgetVault(id);
    // best effort: drop the Claude Code transcript too; failures never block the delete
    if (conversation) this.forgetTranscript(conversation);
  }

  /** Drops the privacy-vault tokens of a conversation; failures never block the delete. */
  private forgetVault(conversationId: string): void {
    try {
      this.deps.vaults?.deleteScope(conversationId);
    } catch {
      /* best effort */
    }
  }

  private forgetTranscript(c: { agentSessionId: string | null; agentCwd: string | null }): void {
    const { agentSessionId, agentCwd } = c;
    const forget = this.deps.agent.deleteSession;
    if (agentSessionId && agentCwd && forget) {
      void Promise.resolve()
        .then(() => forget.call(this.deps.agent, agentSessionId, agentCwd))
        .catch(() => undefined);
    }
  }

  /** Enforces `maxConversations` (pinned ones are kept) and drops the pruned agent transcripts. */
  private prune(): void {
    const keep = this.deps.historySettings().maxConversations;
    void this.deps.conversations
      .pruneOldest(keep)
      .then((rows) =>
        rows.forEach((r) => {
          this.forgetTranscript(r);
          this.forgetVault(r.id);
        }),
      )
      .catch(() => undefined);
  }

  async setFeedback(messageId: string, feedback: 'up' | 'down' | null): Promise<void> {
    const message = await this.deps.conversations.findMessage(messageId);
    if (!message) throw new NotFoundError('Mensagem');
    await this.deps.conversations.updateMessageMeta(messageId, { ...message.meta, feedback });
  }

  /** Caches a diagram repair in the message meta (hash -> code, null = failed; keeps the 20 newest). */
  async rememberDiagramRepair(messageId: string, hash: string, code: string | null): Promise<void> {
    const message = await this.deps.conversations.findMessage(messageId);
    if (!message || message.role !== 'assistant') return;
    const { [hash]: _old, ...rest } = message.meta.diagramRepairs ?? {};
    const entries = Object.entries({ ...rest, [hash]: code }).slice(-MAX_DIAGRAM_REPAIRS);
    await this.deps.conversations.updateMessageMeta(messageId, {
      ...message.meta,
      diagramRepairs: Object.fromEntries(entries),
    });
  }

  /** Runs one user turn, streaming progress through `emit`. Never throws for model/provider errors. */
  async send(input: unknown, emit: EmitFn, signal?: AbortSignal): Promise<void> {
    const request = chatRequestSchema.parse(input);
    const now = this.deps.clock.now();
    const isData = request.mode === 'data';

    let conversation = request.conversationId
      ? await this.deps.conversations.findById(request.conversationId)
      : null;

    // mode data: the connection must exist before anything is created or stored
    let databaseId = conversation?.databaseId ?? null;
    if (isData) {
      databaseId = request.databaseId ?? databaseId;
      const known = databaseId && this.deps.data ? await this.deps.data.name(databaseId) : null;
      if (!databaseId || known === null) {
        emit({ type: 'error', message: NO_DATABASE_MESSAGE });
        return;
      }
    }
    const directSql = isData && request.directSql === true;

    if (!conversation) {
      conversation = {
        id: this.deps.ids.next(),
        title: titleFromPrompt(directSql ? request.content.replace(/\s+/g, ' ') : request.content),
        mode: request.mode,
        model: request.model,
        agentSessionId: null,
        createdAt: now,
        updatedAt: now,
        pinned: false,
        parentConversationId: null,
        forkedFromMessageId: null,
        summary: null,
        agentCwd: null,
        agentPermissionMode: null,
        libraryId: isData ? null : (request.libraryId ?? null),
        preset: null,
        databaseId,
      };
    }
    // switching model/mode mid-conversation is allowed; the agent session restarts if the model changes
    if (conversation.mode === 'agent' && conversation.model !== request.model)
      conversation.agentSessionId = null;
    conversation = {
      ...conversation,
      mode: request.mode,
      model: request.model,
      // `undefined` keeps the connected library, `null` disconnects it
      // (library, preset and agent options do not apply to the data mode)
      libraryId:
        isData || request.libraryId === undefined ? conversation.libraryId : request.libraryId,
      // same for the document preset; only the chat mode uses (and changes) it
      preset:
        request.mode === 'chat' && request.preset !== undefined
          ? request.preset
          : conversation.preset,
      databaseId: isData ? databaseId : conversation.databaseId,
      updatedAt: now,
    };
    if (request.mode === 'agent') {
      if (request.agent) conversation.agentPermissionMode = request.agent.permissionMode;
      const cwd = request.agent?.cwd || conversation.agentCwd || this.deps.defaultAgentCwd();
      // Claude Code keeps sessions per directory: another cwd cannot resume the stored one
      if (conversation.agentCwd && conversation.agentCwd !== cwd)
        conversation.agentSessionId = null;
      conversation.agentCwd = cwd;
    }
    await this.deps.conversations.save(conversation);
    if (!request.conversationId) this.prune();
    emit({ type: 'conversation', conversationId: conversation.id, title: conversation.title });

    const history = await this.deps.conversations.messages(conversation.id);
    if (history.length >= MAX_MESSAGES_PER_CONVERSATION) {
      emit({
        type: 'error',
        message: 'Esta conversa atingiu o limite de mensagens. Use Derivar para continuar.',
      });
      return;
    }
    await this.deps.conversations.addMessage({
      id: this.deps.ids.next(),
      conversationId: conversation.id,
      role: 'user',
      content: request.content,
      meta: request.attachments.length
        ? {
            attachments: request.attachments.map((a) => ({
              name: a.name,
              mimeType: a.mimeType,
              ...(a.mimeType.startsWith('image/')
                ? {}
                : { excerpt: truncate(a.data, MAX_ATTACHMENT_EXCERPT_CHARS) }),
            })),
          }
        : {},
      createdAt: now,
    });

    if (request.mode === 'agent') {
      await this.runAgent(conversation, history, request, emit, signal);
    } else if (directSql && databaseId) {
      await this.runDirectSql(conversation, databaseId, request.content, emit, signal);
    } else {
      await this.runChat(conversation, history, request, emit, signal);
    }
  }

  /* ------------------------------ chat ------------------------------ */

  private async runChat(
    conversation: Conversation,
    history: StoredMessage[],
    request: ReturnType<typeof chatRequestSchema.parse>,
    emit: EmitFn,
    signal?: AbortSignal,
  ): Promise<void> {
    emit({ type: 'step', step: 'analyze', status: 'active' });

    const settings = this.deps.historySettings();
    let budget = resolveContextBudget({
      configured: settings.contextBudgetTokens,
      learnedLimit: await this.deps.inputLimitHint?.(request.model),
    });

    let toolset: Toolset | null = null;
    if (request.useMcp) {
      toolset = await this.deps.mcp.enabledToolset();
      if (toolset.tools.length === 0) toolset = null;
    }
    /** One live tool output may take this share of the budget (the persisted copy is capped separately). */
    const liveToolCap = () =>
      Math.min(MAX_TOOL_OUTPUT_CHARS, Math.floor(budget * 4 * LIVE_TOOL_OUTPUT_SHARE));
    // mode data: every query run by the tools; the full rows go to the screen, never to SQLite
    const queryResults: QueryResultDto[] = [];
    const onQueryResult = (result: QueryResultDto) => {
      queryResults.push(result);
      emit({ type: 'query_result', result });
    };
    const kitContext = { conversation, request, toolset, liveToolCap, emit, onQueryResult };
    let kit: TurnKit;
    try {
      kit = await this.buildKit(kitContext, null);
    } catch (err) {
      emit({ type: 'step', step: 'analyze', status: 'done' });
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    const systemMessage: OAIMessage = { role: 'system', content: kit.prompt };
    const currentUser: OAIMessage = {
      role: 'user',
      content: userContent(request.content, request.attachments),
    };
    const fixedTokens = estimateRequestTokens(
      [systemMessage, currentUser],
      kit.toolbox?.defs ?? [],
    );
    let window = await this.prepareWindow(
      conversation,
      history,
      { budget, fixedTokens, settings },
      request.model,
      signal,
    );
    let messages: OAIMessage[] = [systemMessage, ...window.messages, currentUser];
    const emitContext = () =>
      emit({
        type: 'context',
        keptMessages: window.keptMessageIds.length,
        omittedMessages: window.omittedCount,
        summarized: conversation.summary !== null,
        estimatedTokens: window.estimatedTokens,
        budgetTokens: budget,
      });
    emitContext();
    let retried = false;

    let text = '';
    let providerId: string | null = null;
    let model: string | null = null;
    const toolCalls: NonNullable<MessageMeta['toolCalls']> = [];
    const usage: UsageTotals = { inputTokens: null, outputTokens: null };
    let searchStarted = false;
    let composeStarted = false;
    let libraryUsed = false;
    let failure: string | null = null;
    // mode data: SQL blocks of the answer checked against the database (nothing runs)
    let sqlValidation: SqlBlockValidationDto[] = [];
    let rewritten = false;
    // documents started by this turn, announced to the client once each
    const started: { document: CreatedDocument | null } = { document: null };
    const announceDocuments = () => {
      const [first] = kit.preset?.created() ?? [];
      if (!first || started.document) return;
      started.document = first;
      emit({ type: 'report', reportId: first.id, title: first.title, kind: first.kind });
    };

    const isData = conversation.mode === 'data';
    const maxIterations = isData ? MAX_DATA_TOOL_ITERATIONS : MAX_TOOL_ITERATIONS;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const body: OAIRequest = { model: request.model, messages, stream: true };
      if (kit.toolbox) body.tools = kit.toolbox.defs;

      const routed = await this.deps.router.execute(
        { format: 'openai', body: body as unknown as Record<string, unknown> },
        {
          source: isData ? 'data-ai' : 'chat',
          // personal data is tokenized with this conversation's vault and restored in the answer
          privacy: { scope: conversation.id },
          ...(signal ? { signal } : {}),
        },
      );
      if (!routed.ok && iteration === 0 && routed.reason === 'context_length' && !retried) {
        // the provider rejected the size: rebuild with half the budget (and what the router just learned)
        retried = true;
        budget = resolveContextBudget({
          configured: Math.floor(budget / 2),
          learnedLimit: await this.deps.inputLimitHint?.(request.model),
        });
        window = await this.prepareWindow(
          conversation,
          history,
          { budget, fixedTokens, settings },
          request.model,
          signal,
        );
        messages = [systemMessage, ...window.messages, currentUser];
        // the live tool-output cap follows the (smaller) budget
        kit = await this.buildKit(kitContext, kit);
        emitContext();
        iteration--;
        continue;
      }
      if (iteration === 0) emit({ type: 'step', step: 'analyze', status: 'done' });
      if (!routed.ok) {
        failure = routed.message;
        break;
      }
      providerId = routed.providerId;
      model = routed.model;

      const turnUsage: UsageTotals = { inputTokens: null, outputTokens: null };
      const pending = new Map<number, OAIToolCall>();
      let turnText = '';
      try {
        const chunks = tapUsage(
          convertStream(routed.stream.events, routed.stream.format, 'openai', routed.model),
          'openai',
          turnUsage,
        );
        for await (const raw of chunks) {
          const chunk = raw as unknown as OAIChunk;
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (reasoning) emit({ type: 'reasoning', text: reasoning });
          if (delta.content) {
            if (!composeStarted) {
              composeStarted = true;
              emit({ type: 'step', step: 'compose', status: 'active' });
            }
            turnText += delta.content;
            emit({ type: 'delta', text: delta.content });
          }
          for (const call of delta.tool_calls ?? [])
            applyToolCallDelta(pending, call, `call_${iteration}_${call.index}`);
        }
        routed.finish(turnUsage);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        routed.finish({ ...turnUsage, error: failure });
        text += turnText;
        break;
      }
      text += turnText;
      usage.inputTokens = (usage.inputTokens ?? 0) + (turnUsage.inputTokens ?? 0);
      usage.outputTokens = (usage.outputTokens ?? 0) + (turnUsage.outputTokens ?? 0);

      const calls = [...pending.values()].filter((c) => c.function.name);
      if (calls.length === 0 || !kit.toolbox) {
        // the answer is final: its SQL must only name tables/columns that exist
        if (isData && kit.data && text) {
          const check = await checkAnswerSql(kit.data, text, signal);
          sqlValidation = check.blocks;
          // ONE corrective round: the model rewrites its last draft, then the check is final
          if (check.correction && !rewritten && iteration < maxIterations - 1) {
            rewritten = true;
            sqlValidation = [];
            emit({ type: 'answer_rewrite', keepChars: text.length - turnText.length });
            text = text.slice(0, text.length - turnText.length);
            messages.push({ role: 'assistant', content: turnText });
            messages.push({ role: 'user', content: check.correction });
            continue;
          }
        }
        break;
      }

      if (!searchStarted) {
        searchStarted = true;
        emit({ type: 'step', step: 'search', status: 'active' });
      }
      messages.push({ role: 'assistant', content: turnText || null, tool_calls: calls });
      for (const call of calls) {
        const input = safeJsonParse(call.function.arguments) as Record<string, unknown>;
        emit({ type: 'tool_call', id: call.id, name: call.function.name, input });
        const result = await kit.toolbox.call(call.function.name, input, signal);
        if (kit.library?.tools.some((t) => t.name === call.function.name)) libraryUsed = true;
        announceDocuments();
        const output = truncate(result.text, MAX_TOOL_OUTPUT_CHARS);
        emit({
          type: 'tool_result',
          id: call.id,
          name: call.function.name,
          output,
          isError: result.isError,
        });
        toolCalls.push({
          id: call.id,
          name: call.function.name,
          input,
          output,
          isError: result.isError,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: truncate(output, liveToolCap()) || '(sem saída)',
        });
      }
      if (iteration === maxIterations - 1) {
        failure = 'Limite de chamadas de ferramentas atingido';
      }
    }

    emit({ type: 'step', step: 'search', status: searchStarted ? 'done' : 'skipped' });
    emit({ type: 'step', step: 'compose', status: 'done' });

    // models without tool calling ask for the generation with a text tag
    if (kit.preset && text.includes('<gerar_documento')) {
      const fallback = await kit.preset.fromText(text);
      text = fallback.text;
      if (fallback.notice) {
        text = `${text}\n\n${fallback.notice}`;
        emit({ type: 'delta', text: `\n\n${fallback.notice}` });
      }
      announceDocuments();
    }

    if (failure) emit({ type: 'error', message: failure });
    if (sqlValidation.length > 0) emit({ type: 'sql_validation', blocks: sqlValidation });
    const messageId = await this.saveAssistant(
      conversation.id,
      text ? normalizeDiagrams(text).text : failure ? `⚠️ ${failure}` : '',
      {
        providerId,
        model,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(started.document ? { report: started.document } : {}),
        ...(libraryUsed && kit.library
          ? { library: { id: kit.library.libraryId, name: kit.library.libraryName } }
          : {}),
        ...(queryResults.length ? { queryResults: queryResults.map(withoutRows) } : {}),
        ...(sqlValidation.length ? { sqlValidation } : {}),
      },
    );
    emit({
      type: 'done',
      messageId,
      providerId,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
  }

  /**
   * Connects the tools of the conversation's mode for ONE turn: `data` gets the Postgres tools
   * (plus MCP), `chat` the library and document-preset ones (plus MCP). With `previous` (the
   * retry after a context-length error) only the budget-dependent connections are rebuilt.
   */
  private async buildKit(
    ctx: {
      conversation: Conversation;
      request: ReturnType<typeof chatRequestSchema.parse>;
      toolset: Toolset | null;
      liveToolCap: () => number;
      emit: EmitFn;
      onQueryResult: (result: QueryResultDto) => void;
    },
    previous: TurnKit | null,
  ): Promise<TurnKit> {
    const { conversation, request, toolset, liveToolCap, emit } = ctx;

    if (conversation.mode === 'data') {
      const connected = conversation.databaseId
        ? await this.deps.data?.chatTools(conversation.databaseId, {
            maxOutputChars: liveToolCap(),
            onResult: ctx.onQueryResult,
            // everything the model reads of this conversation's data is tokenized with its vault
            ...(this.deps.vaults ? { vault: this.deps.vaults.forScope(conversation.id) } : {}),
            requestReview: (review, signal) => this.reviews.request(review, emit, signal),
          })
        : null;
      const data = connected ?? previous?.data ?? null;
      if (!data) throw new DomainError(NO_DATABASE_MESSAGE, 'database_not_found');
      return {
        prompt: [DATA_SYSTEM_PROMPT, data.systemNote].filter(Boolean).join('\n\n'),
        toolbox: combineToolsets(toolset, data),
        library: null,
        preset: null,
        data,
      };
    }

    // built once per turn: its call counters are per turn
    const connectLibrary = async (): Promise<LibraryChatTools | null> => {
      if (!conversation.libraryId || !this.deps.library) return null;
      return this.deps.library.chatTools(conversation.libraryId, {
        maxOutputChars: liveToolCap(),
      });
    };
    let library = await connectLibrary();
    let preset = previous?.preset ?? null;
    if (previous) {
      library = library ?? previous.library;
    } else {
      if (conversation.libraryId && this.deps.library && !library) {
        emit({
          type: 'reasoning',
          text: 'A biblioteca conectada não foi encontrada; seguindo sem biblioteca.',
        });
        conversation.libraryId = null;
        await this.deps.conversations.update(conversation.id, { libraryId: null });
      }
      if (conversation.preset && this.deps.presets) {
        preset = await this.deps.presets.chatTools(conversation.preset, {
          conversationId: conversation.id,
          model: request.model,
          libraryId: conversation.libraryId,
          useMcp: request.useMcp,
        });
        if (!preset) {
          emit({
            type: 'reasoning',
            text: 'O modelo de documento não foi encontrado; seguindo como chat normal.',
          });
          conversation.preset = null;
          await this.deps.conversations.update(conversation.id, { preset: null });
        }
      }
    }
    return {
      prompt: [SYSTEM_PROMPT, library?.systemNote, preset?.systemNote].filter(Boolean).join('\n\n'),
      toolbox: combineToolsets(toolset, library, preset),
      library,
      preset,
      data: null,
    };
  }

  /* --------------------------- data: direct SQL --------------------------- */

  /** "Executar SQL": the analyst's own query, run read-only without calling any model. */
  private async runDirectSql(
    conversation: Conversation,
    databaseId: string,
    sql: string,
    emit: EmitFn,
    signal?: AbortSignal,
  ): Promise<void> {
    let content: string;
    const meta: MessageMeta = { providerId: null, model: null };
    try {
      const result = await this.deps.data!.runDirect(databaseId, sql, signal);
      emit({ type: 'query_result', result });
      meta.queryResults = [withoutRows(result)];
      content = result.error
        ? `⚠️ ${result.error}`
        : `Consulta executada: ${result.rowCount} linha(s)${result.truncated ? ' (resultado limitado)' : ''}.`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', message });
      content = `⚠️ ${message}`;
    }
    const messageId = await this.saveAssistant(conversation.id, content, meta);
    emit({
      type: 'done',
      messageId,
      providerId: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
    });
  }

  /**
   * Builds the bounded context for this turn. When older messages no longer fit they are
   * folded into the rolling summary first (LLM, falling back to an extractive one), which is
   * persisted so the next turns only summarize what is new.
   */
  private async prepareWindow(
    conversation: Conversation,
    history: StoredMessage[],
    limits: { budget: number; fixedTokens: number; settings: HistorySettings },
    model: string,
    signal?: AbortSignal,
  ): Promise<ContextWindow> {
    const { budget, fixedTokens, settings } = limits;
    const build = () =>
      buildContextWindow({
        history,
        summary: conversation.summary,
        budget,
        fixedTokens,
        recentTurns: settings.recentTurns,
      });
    const window = build();
    const last = window.toSummarize.at(-1);
    if (!last) return window;

    const previous = conversation.summary?.text ?? null;
    const { text, kind } = await this.summarizeWithFallback(
      previous,
      window.toSummarize,
      settings.summaryModel || model,
      signal,
      conversation.id,
    );
    const summary = {
      text,
      throughMessageId: last.id,
      kind,
      updatedAt: this.deps.clock.now(),
    };
    await this.deps.conversations.update(conversation.id, { summary });
    conversation.summary = summary;
    return build();
  }

  /**
   * Folds `messages` into `previous` with the LLM summarizer; on any failure uses the extractive
   * summary so callers never have to handle errors. Shared by history compaction and forks.
   */
  private async summarizeWithFallback(
    previous: string | null,
    messages: StoredMessage[],
    model: string,
    signal?: AbortSignal,
    /** Privacy vault scope of the conversation the messages belong to. */
    scope?: string,
  ): Promise<{ text: string; kind: 'llm' | 'extractive' }> {
    try {
      return {
        text: await this.summarizer.summarize(previous, messages, model, signal, scope),
        kind: 'llm',
      };
    } catch {
      return { text: extractiveSummary(previous, messages), kind: 'extractive' };
    }
  }

  /**
   * `<contexto_anterior>` block for a fresh agent session: rolling summary of the older turns
   * (summarizing what is not covered yet, persisted) plus the latest turns, capped at half the
   * budget (at most 8k tokens). Empty when there is nothing to carry.
   */
  private async buildAgentCarryOver(
    conversation: Conversation,
    history: StoredMessage[],
    model: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (history.length === 0) return '';
    const settings = this.deps.historySettings();
    const budget = resolveContextBudget({
      configured: settings.contextBudgetTokens,
      learnedLimit: await this.deps.inputLimitHint?.(model),
    });
    const maxTokens = Math.min(Math.floor(budget / 2), AGENT_CARRY_MAX_TOKENS);
    const turns = groupTurns(history);
    const recent = turns.slice(-settings.recentTurns);
    const older = turns.slice(0, Math.max(0, turns.length - settings.recentTurns)).flat();

    let summary = conversation.summary;
    const covered = summary?.throughMessageId
      ? history.findIndex((m) => m.id === summary!.throughMessageId)
      : -1;
    const delta = older.filter((m) => history.indexOf(m) > covered);
    const last = delta.at(-1);
    if (last) {
      const result = await this.summarizeWithFallback(
        summary?.text ?? null,
        delta,
        settings.summaryModel || model,
        signal,
        conversation.id,
      );
      summary = {
        text: result.text,
        throughMessageId: last.id,
        kind: result.kind,
        updatedAt: this.deps.clock.now(),
      };
      await this.deps.conversations.update(conversation.id, { summary });
      conversation.summary = summary;
    }
    return buildCarryOver(summary?.text ?? null, recent, maxTokens);
  }

  /* ------------------------------ agent ----------------------------- */

  private async runAgent(
    conversation: Conversation,
    history: StoredMessage[],
    request: ReturnType<typeof chatRequestSchema.parse>,
    emit: EmitFn,
    signal?: AbortSignal,
  ): Promise<void> {
    emit({ type: 'step', step: 'analyze', status: 'active' });
    const mcpServers = request.useMcp ? await this.deps.mcp.enabledServers() : [];
    let firstEvent = true;
    let composeStarted = false;
    let searchStarted = false;

    const turnPrompt = userContentAsText(request.content, request.attachments);
    const permissionMode =
      request.agent?.permissionMode ?? conversation.agentPermissionMode ?? 'plan';
    const cwd = conversation.agentCwd || this.deps.defaultAgentCwd();
    const onEvent = (event: ChatStreamEvent) => {
      if (firstEvent) {
        firstEvent = false;
        emit({ type: 'step', step: 'analyze', status: 'done' });
      }
      if (event.type === 'tool_call' && !searchStarted) {
        searchStarted = true;
        emit({ type: 'step', step: 'search', status: 'active' });
      }
      if (event.type === 'delta' && !composeStarted) {
        composeStarted = true;
        emit({ type: 'step', step: 'compose', status: 'active' });
      }
      emit(event);
    };
    const run = (sessionId: string | null, prompt: string) =>
      this.deps.agent.run(
        {
          conversationId: conversation.id,
          prompt,
          model: request.model,
          sessionId,
          permissionMode,
          cwd,
          mcpServers,
          ...(signal ? { signal } : {}),
        },
        onEvent,
      );

    // A brand-new session (first turn, model/cwd change, chat -> agent, fork) knows nothing of
    // the earlier messages: seed it with the summary plus the latest exchanges.
    const seeded = async () => {
      const carry = await this.buildAgentCarryOver(conversation, history, request.model, signal);
      return carry ? `${carry}\n\n${turnPrompt}` : turnPrompt;
    };
    const resumed = conversation.agentSessionId;
    let result = await run(resumed, resumed ? turnPrompt : await seeded());

    if (resumed && result.error && SESSION_LOST.test(result.error) && !signal?.aborted) {
      // the transcript is gone (other machine, cleaned ~/.claude, ...): restart from a summary
      await this.deps.conversations.update(conversation.id, { agentSessionId: null });
      conversation.agentSessionId = null;
      emit({
        type: 'reasoning',
        text: 'Sessão anterior do agente não encontrada; continuando com um resumo da conversa.',
      });
      result = await run(null, await seeded());
    }

    if (firstEvent) emit({ type: 'step', step: 'analyze', status: 'done' });
    emit({ type: 'step', step: 'search', status: searchStarted ? 'done' : 'skipped' });
    emit({ type: 'step', step: 'compose', status: 'done' });

    if (result.sessionId) {
      await this.deps.conversations.save({
        ...conversation,
        agentSessionId: result.sessionId,
        updatedAt: this.deps.clock.now(),
      });
    }
    if (result.error) emit({ type: 'error', message: result.error });
    const messageId = await this.saveAssistant(
      conversation.id,
      result.text || (result.error ? `⚠️ ${result.error}` : ''),
      {
        providerId: 'agent',
        model: request.model,
        ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
      },
    );
    emit({
      type: 'done',
      messageId,
      providerId: 'agent',
      model: request.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    });
  }

  private async saveAssistant(
    conversationId: string,
    content: string,
    meta: MessageMeta,
  ): Promise<string> {
    const id = this.deps.ids.next();
    await this.deps.conversations.addMessage({
      id,
      conversationId,
      role: 'assistant',
      content:
        content.length > MAX_STORED_ASSISTANT_CHARS
          ? `${content.slice(0, MAX_STORED_ASSISTANT_CHARS)}\n…(truncado)`
          : content,
      meta,
      createdAt: this.deps.clock.now(),
    });
    return id;
  }
}

function userContent(content: string, attachments: ChatAttachment[]): string | OAIContentPart[] {
  const images = attachments.filter((a) => a.mimeType.startsWith('image/'));
  const text = userContentAsText(content, attachments);
  if (images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((a) => ({ type: 'image_url' as const, image_url: { url: a.data } })),
  ];
}

function userContentAsText(content: string, attachments: ChatAttachment[]): string {
  const files = attachments.filter((a) => !a.mimeType.startsWith('image/'));
  if (files.length === 0) return content;
  const blocks = files.map(
    (f) => `Arquivo anexado: ${f.name}\n\`\`\`\n${truncate(f.data, 100_000)}\n\`\`\``,
  );
  return `${content}\n\n${blocks.join('\n\n')}`;
}

/** Rows are never persisted: "Executar de novo" fetches them again from the source database. */
function withoutRows(result: QueryResultDto): QueryResultMetaDto {
  const { rows: _rows, ...meta } = result;
  return meta;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncado)` : text;
}

function toConversationDto(c: ConversationListItem): ConversationDto {
  return {
    id: c.id,
    title: c.title,
    mode: c.mode,
    model: c.model,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    pinned: c.pinned,
    parentConversationId: c.parentConversationId,
    forkedFromMessageId: c.forkedFromMessageId,
    messageCount: c.messageCount,
    preview: c.preview,
    hasSummary: c.summary !== null,
    libraryId: c.libraryId,
    preset: c.preset,
    databaseId: c.databaseId,
  };
}

function toSummaryDto(s: NonNullable<Conversation['summary']>): ConversationSummaryDto {
  return {
    text: s.text,
    kind: s.kind,
    throughMessageId: s.throughMessageId,
    updatedAt: s.updatedAt,
  };
}

function toMessageDto(m: StoredMessage): ChatMessageDto {
  const { attachments, ...rest } = m.meta;
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    // stored excerpts are for the model only
    meta: attachments
      ? { ...rest, attachments: attachments.map((a) => ({ name: a.name, mimeType: a.mimeType })) }
      : rest,
  };
}
