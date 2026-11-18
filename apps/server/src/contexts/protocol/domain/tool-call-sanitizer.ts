import type { OAIMessage } from './wire-types';

/**
 * Strips provider-specific `extra_content` from assistant tool calls without mutating the input.
 * No supported provider takes it back, and OpenAI-compatible servers may reject unknown fields.
 */
export function stripToolCallExtraContent(messages: OAIMessage[]): OAIMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call) => {
        if (call.extra_content === undefined) return call;
        const { extra_content: _dropped, ...rest } = call;
        return rest;
      }),
    };
  });
}
