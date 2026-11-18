import { AnthropicToOpenAIStream, OpenAIToAnthropicStream } from './stream-translators';
import type { AStreamEvent, OAIChunk } from './wire-types';

export type WireFormat = 'openai' | 'anthropic';
export type WireEvent = Record<string, unknown>;

/** Re-emits an upstream event stream in the format the client expects. */
export async function* convertStream(
  events: AsyncIterable<WireEvent>,
  from: WireFormat,
  to: WireFormat,
  model: string,
): AsyncGenerator<WireEvent> {
  if (from === to) {
    yield* events;
    return;
  }
  if (to === 'anthropic') {
    const translator = new OpenAIToAnthropicStream(model);
    for await (const event of events)
      yield* translator.push(event as unknown as OAIChunk) as unknown as WireEvent[];
    yield* translator.flush() as unknown as WireEvent[];
    return;
  }
  const translator = new AnthropicToOpenAIStream(model);
  for await (const event of events)
    yield* translator.push(event as unknown as AStreamEvent) as unknown as WireEvent[];
}

export interface UsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Observes usage numbers while passing events through untouched. */
export async function* tapUsage(
  events: AsyncIterable<WireEvent>,
  format: WireFormat,
  totals: UsageTotals,
): AsyncGenerator<WireEvent> {
  for await (const event of events) {
    if (format === 'openai') {
      const usage = (
        event as { usage?: { prompt_tokens?: number; completion_tokens?: number } | null }
      ).usage;
      if (usage) {
        totals.inputTokens = usage.prompt_tokens ?? totals.inputTokens;
        totals.outputTokens = usage.completion_tokens ?? totals.outputTokens;
      }
    } else {
      const e = event as AStreamEvent;
      if (e.type === 'message_start')
        totals.inputTokens = e.message.usage?.input_tokens ?? totals.inputTokens;
      if (e.type === 'message_delta') {
        totals.outputTokens = e.usage?.output_tokens ?? totals.outputTokens;
        if (e.usage?.input_tokens) totals.inputTokens = e.usage.input_tokens;
      }
    }
    yield event;
  }
}
