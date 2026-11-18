import { safeJsonParse } from './request-translators';
import { applyToolCallDelta } from './tool-call-accumulation';
import type {
  AContentBlock,
  AMessageResponse,
  AStreamEvent,
  OAIChunk,
  OAICompletion,
  OAIToolCall,
} from './wire-types';

/** Builds a non-streaming chat.completion from OpenAI stream chunks. */
export async function accumulateOpenAI(
  chunks: AsyncIterable<OAIChunk>,
  fallbackModel: string,
): Promise<OAICompletion> {
  let id = '';
  let model = fallbackModel;
  let created = Math.floor(Date.now() / 1000);
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  const tools = new Map<number, OAIToolCall>();
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for await (const chunk of chunks) {
    id ||= chunk.id;
    if (chunk.model) model = chunk.model;
    if (chunk.created) created = chunk.created;
    if (chunk.usage) {
      const p = chunk.usage.prompt_tokens ?? 0;
      const c = chunk.usage.completion_tokens ?? 0;
      usage = {
        prompt_tokens: p,
        completion_tokens: c,
        total_tokens: chunk.usage.total_tokens ?? p + c,
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const d = choice.delta ?? {};
    if (d.content) content += d.content;
    const r = d.reasoning_content ?? d.reasoning;
    if (r) reasoning += r;
    for (const call of d.tool_calls ?? []) applyToolCallDelta(tools, call, `call_${call.index}`);
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const message: OAICompletion['choices'][number]['message'] = {
    role: 'assistant',
    content: content || null,
  };
  if (reasoning) message.reasoning_content = reasoning;
  if (tools.size > 0)
    message.tool_calls = [...tools.entries()].sort(([a], [b]) => a - b).map(([, t]) => t);

  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason ?? (tools.size > 0 ? 'tool_calls' : 'stop'),
      },
    ],
    usage,
  };
}

/** Builds a non-streaming Anthropic message from stream events. */
export async function accumulateAnthropic(
  events: AsyncIterable<AStreamEvent>,
  fallbackModel: string,
): Promise<AMessageResponse> {
  const result: AMessageResponse = {
    id: '',
    type: 'message',
    role: 'assistant',
    model: fallbackModel,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const blocks = new Map<number, AContentBlock & { _json?: string }>();

  for await (const event of events) {
    switch (event.type) {
      case 'message_start':
        result.id = event.message.id ?? result.id;
        result.model = event.message.model ?? result.model;
        result.usage.input_tokens = event.message.usage?.input_tokens ?? 0;
        break;
      case 'content_block_start':
        blocks.set(event.index, { ...event.content_block } as AContentBlock);
        break;
      case 'content_block_delta': {
        const block = blocks.get(event.index) as Record<string, unknown> | undefined;
        if (!block) break;
        const d = event.delta as {
          type: string;
          text?: string;
          partial_json?: string;
          thinking?: string;
          signature?: string;
        };
        if (d.type === 'text_delta') block.text = String(block.text ?? '') + (d.text ?? '');
        if (d.type === 'thinking_delta')
          block.thinking = String(block.thinking ?? '') + (d.thinking ?? '');
        if (d.type === 'signature_delta') block.signature = d.signature;
        if (d.type === 'input_json_delta')
          block._json = String(block._json ?? '') + (d.partial_json ?? '');
        break;
      }
      case 'message_delta':
        result.stop_reason = event.delta?.stop_reason ?? result.stop_reason;
        result.stop_sequence = event.delta?.stop_sequence ?? null;
        if (event.usage?.output_tokens !== undefined)
          result.usage.output_tokens = event.usage.output_tokens;
        if (event.usage?.input_tokens) result.usage.input_tokens = event.usage.input_tokens;
        break;
      default:
        break;
    }
  }

  result.content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => {
      const { _json, ...rest } = block as Record<string, unknown> & { _json?: string };
      if (rest.type === 'tool_use')
        rest.input = _json !== undefined ? safeJsonParse(_json) : (rest.input ?? {});
      return rest as AContentBlock;
    });
  result.id ||= `msg_${Date.now()}`;
  return result;
}
