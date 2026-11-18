import { convertStream, tapUsage, type UsageTotals } from '../../protocol/domain/convert';
import { applyToolCallDelta } from '../../protocol/domain/tool-call-accumulation';
import type { OAIChunk, OAIMessage, OAITool, OAIToolCall } from '../../protocol/domain/wire-types';
import type { RouteChatRequest } from '../../routing/application/route-chat-request';

/** One call may take this long before it is given up (slow free models). */
export const LLM_CALL_TIMEOUT_MS = 300_000;
export const PROVIDER_WAIT_ATTEMPTS = 4;
const MAX_WAIT_MS = 60_000;
const BASE_WAIT_MS = 10_000;

/** Reasons that a short wait usually fixes. */
const WAITABLE = new Set(['rate_limited', 'capacity', 'no_connection', 'server', 'network']);
/** Reasons of a model that answered badly (not of the provider): the caller may go on without it. */
const SOFT = new Set(['stream', 'empty', 'timeout', 'context_length']);

export class LlmError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    /** The router saw a transient failure along the way: waiting may help whatever the reason. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'LlmError';
  }

  get waitable(): boolean {
    return WAITABLE.has(this.reason) || this.retryable;
  }

  /** The step can be skipped or redone; every other reason ends the job (retry resumes it). */
  get soft(): boolean {
    return SOFT.has(this.reason);
  }
}

export interface LlmRequest {
  model: string;
  messages: OAIMessage[];
  tools?: OAITool[];
  maxTokens: number;
  temperature?: number;
}

export interface LlmResult {
  text: string;
  toolCalls: OAIToolCall[];
  providerId: string;
  model: string;
  usage: UsageTotals;
}

/**
 * One streamed chat completion through the router, collected into text + tool calls. Usage is
 * always reported (`routed.finish`), also when the stream fails midway.
 */
export async function completeChat(
  router: RouteChatRequest,
  request: LlmRequest,
  options: {
    source: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Privacy vault scope (the report id): the same value keeps the same token across calls. */
    scope?: string;
  },
): Promise<LlmResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? LLM_CALL_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    max_tokens: request.maxTokens,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.tools?.length ? { tools: request.tools } : {}),
  };
  let routed;
  try {
    routed = await router.execute(
      { format: 'openai', body },
      {
        source: options.source,
        signal,
        ...(options.scope ? { privacy: { scope: options.scope } } : {}),
      },
    );
  } catch (err) {
    throw classifyThrown(err, options.signal);
  }
  if (!routed.ok) throw new LlmError(routed.message, routed.reason, routed.retryable);

  const usage: UsageTotals = { inputTokens: null, outputTokens: null };
  const pending = new Map<number, OAIToolCall>();
  let text = '';
  try {
    const chunks = tapUsage(
      convertStream(routed.stream.events, routed.stream.format, 'openai', routed.model),
      'openai',
      usage,
    );
    for await (const raw of chunks) {
      const delta = (raw as unknown as OAIChunk).choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) text += delta.content;
      for (const call of delta.tool_calls ?? [])
        applyToolCallDelta(pending, call, `call_${call.index}`);
    }
    routed.finish(usage);
  } catch (err) {
    routed.finish({ ...usage, error: err instanceof Error ? err.message : String(err) });
    throw classifyThrown(err, options.signal);
  }
  return {
    text,
    toolCalls: [...pending.values()].filter((c) => c.function.name),
    providerId: routed.providerId,
    model: routed.model,
    usage,
  };
}

/** Cancellation stays an abort error; a timeout or a broken stream is a soft failure. */
function classifyThrown(err: unknown, outer: AbortSignal | undefined): unknown {
  if (outer?.aborted) return err;
  if (err instanceof LlmError) return err;
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError')
    return new LlmError('O modelo demorou demais para responder', 'timeout');
  return new LlmError(err instanceof Error ? err.message : String(err), 'stream');
}

export function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError') &&
    !(err instanceof LlmError)
  );
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Real timer that ends early (rejecting) when the signal aborts. */
export const sleepWithSignal: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const waitDelayMs = (attempt: number): number =>
  Math.min(MAX_WAIT_MS, BASE_WAIT_MS * 2 ** attempt);

export interface RetryOptions {
  signal?: AbortSignal | undefined;
  sleep: Sleep;
  /** Called before each wait with the number of the next attempt (2..max). */
  onWait?: (attempt: number, max: number, delayMs: number) => void | Promise<void>;
  maxAttempts?: number;
}

/**
 * Runs `fn`; when the provider is limiting us (rate limit, capacity, cooldown) waits
 * `min(60 s, 10 s · 2^attempt)` and tries again, up to `maxAttempts`. An exhausted quota is not
 * waited for: the user has to pick another model and use "Retomar".
 */
export async function withProviderRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const max = options.maxAttempts ?? PROVIDER_WAIT_ATTEMPTS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof LlmError) || options.signal?.aborted) throw err;
      if (err.reason === 'quota_exhausted' && !err.retryable)
        throw new LlmError(
          'Cota do provedor esgotada; escolha outro modelo e use Retomar.',
          'quota_exhausted',
        );
      if (!err.waitable || attempt >= max - 1) {
        if (err.waitable)
          throw new LlmError(
            `O provedor continua limitando as chamadas (${err.message}). Use Retomar mais tarde ou escolha outro modelo.`,
            err.reason,
            err.retryable,
          );
        throw err;
      }
      const delay = waitDelayMs(attempt);
      await options.onWait?.(attempt + 2, max, delay);
      await options.sleep(delay, options.signal);
    }
  }
}
