import type { OAIDeltaToolCall, OAIToolCall } from './wire-types';

/**
 * Applies one streamed tool-call delta to the pending calls (keyed by delta index): id, name and
 * arguments accumulate.
 */
export function applyToolCallDelta(
  pending: Map<number, OAIToolCall>,
  call: OAIDeltaToolCall,
  fallbackId: string,
): void {
  const current: OAIToolCall = pending.get(call.index) ?? {
    id: call.id ?? fallbackId,
    type: 'function' as const,
    function: { name: '', arguments: '' },
  };
  if (call.id) current.id = call.id;
  if (call.function?.name) current.function.name += call.function.name;
  if (call.function?.arguments) current.function.arguments += call.function.arguments;
  pending.set(call.index, current);
}
