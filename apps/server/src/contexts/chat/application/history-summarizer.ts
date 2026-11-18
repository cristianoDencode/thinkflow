import { convertStream, tapUsage, type UsageTotals } from '../../protocol/domain/convert';
import type { OAIChunk } from '../../protocol/domain/wire-types';
import type { RouteChatRequest } from '../../routing/application/route-chat-request';
import {
  SUMMARY_MAX_CHARS,
  buildSummaryRequest,
  chunkForSummary,
  extractiveSummary,
} from '../domain/context-window';
import type { StoredMessage } from '../domain/conversation';

const SUMMARY_TIMEOUT_MS = 30_000;
const SUMMARY_MAX_OUTPUT_TOKENS = 700;

/** Port-like contract so ChatService can be tested with a stub. */
export interface Summarizer {
  /** Folds `messages` into `previous`; throws when the model cannot produce a summary. */
  summarize(
    previous: string | null,
    messages: StoredMessage[],
    model: string,
    signal?: AbortSignal,
    /** Privacy vault scope (the conversation id) used to tokenize the messages sent to the model. */
    scope?: string,
  ): Promise<string>;
}

/** Writes rolling summaries of old messages through the same router as regular chat. */
export class HistorySummarizer implements Summarizer {
  constructor(private readonly router: RouteChatRequest) {}

  async summarize(
    previous: string | null,
    messages: StoredMessage[],
    model: string,
    signal?: AbortSignal,
    scope?: string,
  ): Promise<string> {
    const { skipped, chunks } = chunkForSummary(messages);
    // too much to summarize in one go: the oldest part is folded without the model
    let current = skipped.length > 0 ? extractiveSummary(previous, skipped) : previous;
    for (const chunk of chunks) {
      current = await this.summarizeChunk(current, chunk, model, signal, scope);
    }
    if (!current?.trim()) throw new Error('Resumo vazio');
    return current;
  }

  private async summarizeChunk(
    previous: string | null,
    chunk: StoredMessage[],
    model: string,
    signal?: AbortSignal,
    scope?: string,
  ): Promise<string> {
    const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const routed = await this.router.execute(
      {
        format: 'openai',
        body: {
          model,
          messages: buildSummaryRequest(previous, chunk),
          stream: true,
          max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
          temperature: 0.2,
        },
      },
      { source: 'summary', signal: combined, ...(scope ? { privacy: { scope } } : {}) },
    );
    if (!routed.ok) throw new Error(routed.message);

    const usage: UsageTotals = { inputTokens: null, outputTokens: null };
    let text = '';
    try {
      const chunks = tapUsage(
        convertStream(routed.stream.events, routed.stream.format, 'openai', routed.model),
        'openai',
        usage,
      );
      for await (const raw of chunks) {
        const delta = (raw as unknown as OAIChunk).choices?.[0]?.delta;
        if (delta?.content) text += delta.content;
      }
      routed.finish(usage);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      routed.finish({ ...usage, error: message });
      throw err;
    }
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Resumo vazio');
    return trimmed.slice(0, SUMMARY_MAX_CHARS);
  }
}
