/**
 * Bounded context window: decides which part of a stored conversation is sent to the model,
 * replaces the rest by a rolling summary, and renders history as plain text (tool calls are
 * always flattened, never replayed as structured `tool` messages).
 *
 * Pure functions only: no I/O, no clock, no randomness.
 */
import type { OAIMessage } from '../../protocol/domain/wire-types';
import { estimateTokens } from '../../routing/domain/capacity';
import type { ConversationSummary, StoredMessage } from './conversation';

/** Default max input (estimate units) sent to the model. */
export const DEFAULT_CONTEXT_BUDGET = 16_000;
/** The budget never goes below this, whatever the learned limit says. */
export const MIN_CONTEXT_BUDGET = 1_500;
/** Learned provider limits are already estimate units; keep a further margin. */
export const LEARNED_LIMIT_FACTOR = 0.85;
/** After compaction, kept turns use at most this share of the allowance (hysteresis). */
export const LOW_WATERMARK = 0.6;
/** Compaction only starts once the tail has more than `recentTurns * this` turns or overflows. */
export const TURNS_TRIGGER_FACTOR = 2;
export const SUMMARY_MAX_CHARS = 4_000;
export const TOOL_OUTPUT_CHARS_LAST_TURN = 1_500;
export const TOOL_OUTPUT_CHARS_OLDER = 400;
export const TOOL_INPUT_CHARS = 500;
/** A single stored message above head+tail+margin is cut in the middle. */
export const MESSAGE_HEAD_CHARS = 8_000;
export const MESSAGE_TAIL_CHARS = 2_000;
export const ATTACHMENT_EXCERPT_CHARS_IN_CONTEXT = 4_000;
/** Max chars of a message inside a summarization prompt. */
export const SUMMARY_MESSAGE_CHARS = 2_000;
export const SUMMARY_TOOL_OUTPUT_CHARS = 300;
export const SUMMARY_ATTACHMENT_CHARS = 1_000;
export const SUMMARY_CHUNK_TOKENS = 6_000;
export const SUMMARY_MAX_CHUNKS = 4;

export const OMITTED_MARK = '…(trecho omitido)…';
export const SUMMARY_PREFIX =
  'Resumo da conversa até aqui (mensagens antigas foram omitidas para economizar contexto):\n';
export const SUMMARY_SYSTEM_PROMPT =
  'Você é um assistente que resume conversas para que elas possam continuar depois. Responda apenas com o resumo, em português do Brasil.';

/** Model-facing budget: configured value, capped by 85% of a learned limit, never below the minimum. */
export function resolveContextBudget(input: {
  configured: number;
  learnedLimit?: number | undefined;
}): number {
  const learned =
    input.learnedLimit !== undefined
      ? Math.floor(input.learnedLimit * LEARNED_LIMIT_FACTOR)
      : Number.POSITIVE_INFINITY;
  return Math.max(MIN_CONTEXT_BUDGET, Math.min(input.configured, learned));
}

/* ------------------------------ helpers ------------------------------ */

const charsToTokens = (chars: number) => Math.ceil(chars / 4);

export function messageTokens(message: OAIMessage): number {
  return charsToTokens(JSON.stringify(message).length);
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Keeps the start and the end of a long text, dropping the middle. */
export function headTail(
  text: string,
  head = MESSAGE_HEAD_CHARS,
  tail = MESSAGE_TAIL_CHARS,
): string {
  if (text.length <= head + tail + OMITTED_MARK.length * 2) return text;
  return `${text.slice(0, head)}\n${OMITTED_MARK}\n${text.slice(text.length - tail)}`;
}

function oneLine(text: string, max: number): string {
  return cut(text.replace(/\s+/g, ' ').trim(), max);
}

type ToolCalls = NonNullable<StoredMessage['meta']['toolCalls']>;

function inputText(input: unknown): string {
  try {
    return cut(JSON.stringify(input ?? {}), TOOL_INPUT_CHARS);
  } catch {
    return '{}';
  }
}

/** Tool calls as text: `name {input} -> output`, one per line. */
function flattenToolCalls(calls: ToolCalls, outputChars: number): string {
  const lines = calls.map((c) => {
    const output = c.output ? oneLine(c.output, outputChars) : '(sem saída)';
    return `- \`${c.name}\` ${inputText(c.input)} → resultado${c.isError ? ' (erro)' : ''}: ${output}`;
  });
  return `(Ferramentas usadas:\n${lines.join('\n')})`;
}

/** Groups messages in turns: each user message starts one; leading assistant messages form their own. */
export function groupTurns(history: StoredMessage[]): StoredMessage[][] {
  const turns: StoredMessage[][] = [];
  for (const m of history) {
    const current = turns.at(-1);
    if (m.role === 'user' || !current) turns.push([m]);
    else current.push(m);
  }
  return turns;
}

/* ------------------------------ rendering ------------------------------ */

export interface RenderOptions {
  /** True for the most recent turn: keeps long tool outputs and failed (⚠️) answers. */
  isLastTurn: boolean;
  /** Hard cap on the characters of each rendered message (used when even one turn overflows). */
  maxMessageChars?: number;
}

function renderUser(m: StoredMessage, maxChars: number | undefined): string {
  let text = headTail(m.content);
  for (const a of m.meta.attachments ?? []) {
    if (a.mimeType.startsWith('image/')) text += `\n[imagem anexada: ${a.name}]`;
    else if (a.excerpt)
      text += `\n\nArquivo anexado: ${a.name}\n\`\`\`\n${cut(a.excerpt, ATTACHMENT_EXCERPT_CHARS_IN_CONTEXT)}\n\`\`\``;
    else text += `\n[arquivo anexado: ${a.name}]`;
  }
  return maxChars !== undefined && text.length > maxChars
    ? headTail(text, Math.floor(maxChars * 0.8), Math.floor(maxChars * 0.2))
    : text;
}

function renderAssistant(
  m: StoredMessage,
  isLastTurn: boolean,
  maxChars: number | undefined,
): string | null {
  if (!isLastTurn && m.content.startsWith('⚠️')) return null;
  const parts: string[] = [];
  const calls = m.meta.toolCalls ?? [];
  if (calls.length > 0)
    parts.push(
      flattenToolCalls(calls, isLastTurn ? TOOL_OUTPUT_CHARS_LAST_TURN : TOOL_OUTPUT_CHARS_OLDER),
    );
  if (m.content) parts.push(headTail(m.content));
  if (parts.length === 0) return null;
  const text = parts.join('\n\n');
  return maxChars !== undefined && text.length > maxChars
    ? headTail(text, Math.floor(maxChars * 0.8), Math.floor(maxChars * 0.2))
    : text;
}

/** Renders one turn as plain user/assistant messages (never structured tool messages). */
export function renderHistoryMessages(turn: StoredMessage[], options: RenderOptions): OAIMessage[] {
  const out: OAIMessage[] = [];
  for (const m of turn) {
    const content =
      m.role === 'user'
        ? renderUser(m, options.maxMessageChars)
        : renderAssistant(m, options.isLastTurn, options.maxMessageChars);
    if (content) out.push({ role: m.role, content });
  }
  return out;
}

export function summaryMessage(text: string): OAIMessage {
  return { role: 'system', content: `${SUMMARY_PREFIX}${text}` };
}

/* ------------------------------ window ------------------------------ */

export interface ContextWindowInput {
  history: StoredMessage[];
  summary: ConversationSummary | null;
  /** Max input tokens (estimate units) for the whole request. */
  budget: number;
  /** Tokens of everything that is not history (system prompt, current user message, tools). */
  fixedTokens: number;
  recentTurns: number;
}

export interface ContextWindow {
  /** Summary (if any) followed by the kept history; goes right after the system prompt. */
  messages: OAIMessage[];
  keptMessageIds: string[];
  /** History messages that are not sent verbatim (covered by the summary). */
  omittedCount: number;
  /** Messages that must be folded into the summary (the gap between old summary and kept turns). */
  toSummarize: StoredMessage[];
  estimatedTokens: number;
  /** True when even the last turn had to be shortened to fit. */
  truncated: boolean;
}

export function buildContextWindow(input: ContextWindowInput): ContextWindow {
  const { history, summary, budget, fixedTokens, recentTurns } = input;
  const boundary = summary?.throughMessageId
    ? history.findIndex((m) => m.id === summary.throughMessageId)
    : -1;
  const tail = history.slice(boundary + 1);
  const turns = groupTurns(tail);
  const summaryMsg = summary ? summaryMessage(summary.text) : null;
  const summaryTokens = summaryMsg ? messageTokens(summaryMsg) : 0;
  const allowance = Math.max(0, budget - fixedTokens - summaryTokens);

  const render = (i: number) =>
    renderHistoryMessages(turns[i]!, { isLastTurn: i === turns.length - 1 });
  const rendered = turns.map((_, i) => render(i));
  const tokens = rendered.map((r) => r.reduce((sum, m) => sum + messageTokens(m), 0));
  const total = tokens.reduce((a, b) => a + b, 0);

  const base = (firstKept: number, messages: OAIMessage[], used: number, truncated: boolean) => {
    const keptTurns = turns.slice(firstKept);
    const keptMessages = keptTurns.flat();
    const firstIndex = history.length - keptMessages.length;
    return {
      messages: summaryMsg ? [summaryMsg, ...messages] : messages,
      keptMessageIds: keptMessages.map((m) => m.id),
      omittedCount: firstIndex,
      toSummarize: history.slice(boundary + 1, firstIndex),
      estimatedTokens: fixedTokens + summaryTokens + used,
      truncated,
    } satisfies ContextWindow;
  };

  if (turns.length === 0) return base(0, [], 0, false);

  // fits: keep everything after the summary (no compaction yet)
  if (total <= allowance && turns.length <= recentTurns * TURNS_TRIGGER_FACTOR)
    return base(0, rendered.flat(), total, false);

  // compact: newest to oldest while under the low watermark and the recent-turns cap
  const lowWatermark = allowance * LOW_WATERMARK;
  let firstKept = turns.length - 1;
  let used = tokens[firstKept]!;
  while (firstKept > 0) {
    const next = tokens[firstKept - 1]!;
    if (turns.length - firstKept >= recentTurns || used + next > lowWatermark) break;
    firstKept--;
    used += next;
  }

  let truncated = false;
  let keptRendered = rendered.slice(firstKept);
  if (firstKept === turns.length - 1 && used > allowance) {
    // even the newest turn overflows: shorter tool outputs and per-message caps
    truncated = true;
    const last = turns[turns.length - 1]!;
    const perMessage = Math.max(400, Math.floor((allowance * 4) / Math.max(1, last.length)));
    const shrunk = renderHistoryMessages(last, { isLastTurn: false, maxMessageChars: perMessage });
    keptRendered = [shrunk];
    used = shrunk.reduce((sum, m) => sum + messageTokens(m), 0);
  }
  return base(firstKept, keptRendered.flat(), used, truncated);
}

/* ------------------------------ summaries ------------------------------ */

function summaryLine(m: StoredMessage): string {
  const who = m.role === 'user' ? 'Usuário' : 'Assistente';
  const parts: string[] = [];
  const attachments = m.meta.attachments ?? [];
  if (m.content) parts.push(cut(m.content, SUMMARY_MESSAGE_CHARS));
  for (const a of attachments) {
    parts.push(
      a.excerpt && !a.mimeType.startsWith('image/')
        ? `(anexo ${a.name}: ${oneLine(a.excerpt, SUMMARY_ATTACHMENT_CHARS)})`
        : `(anexo ${a.name})`,
    );
  }
  for (const c of m.meta.toolCalls ?? [])
    parts.push(
      `(ferramenta \`${c.name}\` ${inputText(c.input)} → ${oneLine(c.output ?? '', SUMMARY_TOOL_OUTPUT_CHARS)})`,
    );
  return `[${who}] ${parts.join('\n')}`;
}

/** Prompt (system + user) that folds `messages` into `previous` as an updated summary. */
export function buildSummaryRequest(
  previous: string | null,
  messages: StoredMessage[],
): OAIMessage[] {
  const instructions = [
    previous
      ? 'Atualize o resumo abaixo incorporando as novas mensagens.'
      : 'Resuma as mensagens abaixo.',
    'Liste os assuntos tratados e preserve: o objetivo do usuário, decisões tomadas, fatos e números, nomes de arquivos e identificadores de código, e pendências em aberto.',
    'Escreva no máximo 300 palavras, em tópicos curtos.',
  ].join(' ');
  const body = [
    instructions,
    previous ? `Resumo atual:\n${previous}` : null,
    `Novas mensagens:\n${messages.map(summaryLine).join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: body },
  ];
}

/**
 * Splits messages (oldest first) in chunks that each fit a summarization request. When more than
 * `maxChunks` would be needed, the oldest messages are returned in `skipped` (fold them with
 * `extractiveSummary`) and only the newest chunks are summarized by the model.
 */
export function chunkForSummary(
  messages: StoredMessage[],
  maxTokens = SUMMARY_CHUNK_TOKENS,
  maxChunks = SUMMARY_MAX_CHUNKS,
): { skipped: StoredMessage[]; chunks: StoredMessage[][] } {
  const chunks: StoredMessage[][] = [];
  let current: StoredMessage[] = [];
  let used = 0;
  for (const m of messages) {
    const t = charsToTokens(summaryLine(m).length);
    if (current.length > 0 && used + t > maxTokens) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(m);
    used += t;
  }
  if (current.length > 0) chunks.push(current);
  const dropped = Math.max(0, chunks.length - maxChunks);
  return { skipped: chunks.slice(0, dropped).flat(), chunks: chunks.slice(dropped) };
}

/** Fallback without a model: previous text plus one bullet per message, oldest bullets dropped first. */
export function extractiveSummary(previous: string | null, messages: StoredMessage[]): string {
  const bullets = messages
    .map((m) => {
      const text = oneLine(
        m.content || (m.meta.toolCalls?.length ? '(usou ferramentas)' : ''),
        160,
      );
      return text ? `- ${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${text}` : null;
    })
    .filter((l): l is string => l !== null);
  const lines = [...(previous ? previous.split('\n') : []), ...bullets];
  while (lines.length > 1 && lines.join('\n').length > SUMMARY_MAX_CHARS) lines.shift();
  const text = lines.join('\n');
  return text.length > SUMMARY_MAX_CHARS ? text.slice(text.length - SUMMARY_MAX_CHARS) : text;
}

/**
 * Text block that seeds a brand-new session (agent, fork) with what happened before:
 * the summary plus the most recent exchanges, within `maxTokens`.
 */
export function buildCarryOver(
  summary: string | null,
  turns: StoredMessage[][],
  maxTokens: number,
): string {
  const maxChars = Math.max(0, maxTokens * 4);
  const header = '<contexto_anterior>\n';
  const footer = '\n</contexto_anterior>';
  let remaining = maxChars - header.length - footer.length;
  const summaryBlock = summary ? `Resumo: ${cut(summary, Math.floor(remaining * 0.5))}` : '';
  remaining -= summaryBlock.length;

  const kept: string[] = [];
  for (const m of turns.flat().reverse()) {
    const line = summaryLine(m);
    const entry = cut(line, Math.min(1_500, Math.max(0, remaining)));
    if (remaining <= 80 || entry.length > remaining) break;
    kept.unshift(entry);
    remaining -= entry.length + 1;
  }
  if (!summaryBlock && kept.length === 0) return '';
  const sections = [summaryBlock, kept.length ? `Últimas trocas:\n${kept.join('\n')}` : ''].filter(
    Boolean,
  );
  return `${header}${sections.join('\n')}${footer}`;
}

/** Tokens of a prospective request body, using the same estimator as the router. */
export function estimateRequestTokens(messages: OAIMessage[], tools: unknown[] = []): number {
  return estimateTokens({ messages, tools });
}
