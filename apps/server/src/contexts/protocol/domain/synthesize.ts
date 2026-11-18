import type { AMessageResponse, AStreamEvent, OAIChunk, OAICompletion } from './wire-types';

/** Turns a non-streaming OpenAI completion into equivalent stream chunks. */
export function completionToChunks(completion: OAICompletion): OAIChunk[] {
  const choice = completion.choices?.[0];
  const base = {
    id: completion.id,
    object: 'chat.completion.chunk' as const,
    created: completion.created,
    model: completion.model,
  };
  const chunks: OAIChunk[] = [];
  if (choice) {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: choice.message.content ?? '',
            ...(choice.message.reasoning_content
              ? { reasoning_content: choice.message.reasoning_content }
              : {}),
            ...(choice.message.tool_calls?.length
              ? { tool_calls: choice.message.tool_calls.map((t, index) => ({ index, ...t })) }
              : {}),
          },
          finish_reason: null,
        },
      ],
    });
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }],
    });
  }
  if (completion.usage) chunks.push({ ...base, choices: [], usage: completion.usage });
  return chunks;
}

/** Turns a non-streaming Anthropic message into equivalent stream events. */
export function messageToEvents(message: AMessageResponse): AStreamEvent[] {
  const events: AStreamEvent[] = [
    {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: message.usage?.input_tokens ?? 0, output_tokens: 0 },
      },
    },
  ];
  (message.content ?? []).forEach((block, index) => {
    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: String(block.text ?? '') },
      });
    } else if (block.type === 'tool_use') {
      const b = block as { id: string; name: string; input: unknown };
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) },
      });
    } else if (block.type === 'thinking') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: String(block.thinking ?? '') },
      });
    } else {
      events.push({ type: 'content_block_start', index, content_block: block });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason ?? 'end_turn',
      stop_sequence: message.stop_sequence ?? null,
    },
    usage: { output_tokens: message.usage?.output_tokens ?? 0 },
  });
  events.push({ type: 'message_stop' });
  return events;
}
