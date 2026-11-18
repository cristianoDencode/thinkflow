import type { UpstreamEvent, WireFormat } from '../../routing/domain/types';
import { StreamRestorer } from '../domain/stream-restorer';
import type { Vault } from '../domain/vault';

export interface RestoreStreamOptions {
  /**
   * Also restore tokens inside tool-call arguments (JSON-escaped). Off by default: tools never get
   * real values unless their caller is the analyst's own tool (the /v1 gateway).
   */
  restoreToolArgs?: boolean;
}

const jsonEscape = (value: string): string => JSON.stringify(value).slice(1, -1);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One `StreamRestorer` per independent text stream (a choice's content, a content block...). */
class Restorers {
  private readonly byKey = new Map<string, StreamRestorer>();
  constructor(private readonly vault: Vault) {}

  push(key: string, chunk: string, json = false): string {
    let r = this.byKey.get(key);
    if (!r) {
      r = new StreamRestorer(this.vault, json ? jsonEscape : undefined);
      this.byKey.set(key, r);
    }
    return r.push(chunk);
  }

  flush(key: string): string {
    const r = this.byKey.get(key);
    this.byKey.delete(key);
    return r?.flush() ?? '';
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  keys(prefix = ''): string[] {
    return [...this.byKey.keys()].filter((k) => k.startsWith(prefix));
  }
}

/**
 * Wraps an upstream event stream so tokens (`[CPF_1]`) written by the model are turned back into
 * the real values the analyst gave. Only text is restored (content, reasoning); tool-call
 * arguments only with `restoreToolArgs`. Tokens split across deltas are held back until complete.
 * Anthropic `thinking` blocks are signed by the provider and never rewritten.
 */
export async function* restoreStream(
  events: AsyncIterable<UpstreamEvent>,
  format: WireFormat,
  vault: Vault,
  options: RestoreStreamOptions = {},
): AsyncGenerator<UpstreamEvent> {
  const restorers = new Restorers(vault);
  const toolArgs = options.restoreToolArgs === true;
  let last: UpstreamEvent | undefined;
  for await (const event of events) {
    last = event;
    if (format === 'anthropic') yield* anthropicEvent(event, restorers, toolArgs);
    else yield openAiEvent(event, restorers, toolArgs);
  }
  // stream ended without a closing event: whatever was held back is plain text after all
  const tail = format === 'anthropic' ? anthropicTail(restorers) : openAiTail(last, restorers);
  for (const e of tail) yield e;
}

/* ------------------------------ OpenAI ------------------------------ */

const TEXT_FIELDS = ['content', 'reasoning_content', 'reasoning'] as const;

function openAiEvent(event: UpstreamEvent, restorers: Restorers, toolArgs: boolean): UpstreamEvent {
  if (!Array.isArray(event.choices)) return event;
  const choices = event.choices.map((choice: unknown) => {
    if (!isObject(choice) || !isObject(choice.delta)) return choice;
    const index = Number(choice.index ?? 0);
    const delta: Record<string, unknown> = { ...choice.delta };
    const closing = choice.finish_reason != null;
    for (const field of TEXT_FIELDS) {
      const key = `${index}:${field}`;
      const incoming = typeof delta[field] === 'string' ? (delta[field] as string) : null;
      if (incoming === null && !(closing && restorers.has(key))) continue;
      delta[field] =
        (incoming === null ? '' : restorers.push(key, incoming)) +
        (closing ? restorers.flush(key) : '');
    }
    if (toolArgs && Array.isArray(delta.tool_calls)) {
      delta.tool_calls = delta.tool_calls.map((call: unknown) => {
        if (!isObject(call)) return call;
        const key = `${index}:tool:${Number(call.index ?? 0)}`;
        const fn = isObject(call.function) ? { ...call.function } : null;
        if (!fn || typeof fn.arguments !== 'string') return call;
        fn.arguments = restorers.push(key, fn.arguments, true);
        return { ...call, function: fn };
      });
    }
    if (closing && toolArgs) {
      // arguments held back at the end of a tool call (an unfinished "[CPF_1" is plain text)
      const rest = restorers
        .keys(`${index}:tool:`)
        .map((key) => ({ index: Number(key.split(':')[2]), arguments: restorers.flush(key) }))
        .filter((r) => r.arguments !== '');
      if (rest.length > 0) {
        const calls = Array.isArray(delta.tool_calls) ? [...(delta.tool_calls as unknown[])] : [];
        for (const r of rest) {
          const existing = calls.findIndex((c) => isObject(c) && Number(c.index ?? 0) === r.index);
          if (existing >= 0) {
            const c = calls[existing] as Record<string, unknown>;
            const fn = { ...(c.function as Record<string, unknown>) };
            fn.arguments = String(fn.arguments ?? '') + r.arguments;
            calls[existing] = { ...c, function: fn };
          } else calls.push({ index: r.index, function: { arguments: r.arguments } });
        }
        delta.tool_calls = calls;
      }
    }
    return { ...choice, delta };
  });
  return { ...event, choices };
}

function openAiTail(last: UpstreamEvent | undefined, restorers: Restorers): UpstreamEvent[] {
  const keys = restorers.keys();
  if (keys.length === 0 || !last) return [];
  const { choices: _choices, usage: _usage, ...base } = last;
  const byChoice = new Map<number, Record<string, unknown>>();
  for (const key of keys) {
    const [indexText, kind, toolIndex] = key.split(':') as [string, string, string | undefined];
    const rest = restorers.flush(key);
    if (rest === '') continue;
    const index = Number(indexText);
    const delta = byChoice.get(index) ?? {};
    if (kind === 'tool') {
      const calls = (delta.tool_calls as unknown[] | undefined) ?? [];
      calls.push({ index: Number(toolIndex), function: { arguments: rest } });
      delta.tool_calls = calls;
    } else delta[kind] = rest;
    byChoice.set(index, delta);
  }
  if (byChoice.size === 0) return [];
  return [
    {
      ...base,
      choices: [...byChoice].map(([index, delta]) => ({ index, delta, finish_reason: null })),
    },
  ];
}

/* ----------------------------- Anthropic ---------------------------- */

function* anthropicEvent(
  event: UpstreamEvent,
  restorers: Restorers,
  toolArgs: boolean,
): Generator<UpstreamEvent> {
  const index = typeof event.index === 'number' ? event.index : 0;
  switch (event.type) {
    case 'content_block_start': {
      const block = event.content_block;
      if (
        isObject(block) &&
        block.type === 'text' &&
        typeof block.text === 'string' &&
        block.text
      ) {
        yield {
          ...event,
          content_block: { ...block, text: restorers.push(`${index}:text`, block.text) },
        };
        return;
      }
      yield event;
      return;
    }
    case 'content_block_delta': {
      const delta = event.delta;
      if (isObject(delta) && delta.type === 'text_delta' && typeof delta.text === 'string') {
        yield { ...event, delta: { ...delta, text: restorers.push(`${index}:text`, delta.text) } };
        return;
      }
      if (
        toolArgs &&
        isObject(delta) &&
        delta.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        yield {
          ...event,
          delta: {
            ...delta,
            partial_json: restorers.push(`${index}:json`, delta.partial_json, true),
          },
        };
        return;
      }
      yield event;
      return;
    }
    case 'content_block_stop': {
      yield* anthropicFlush(index, restorers);
      yield event;
      return;
    }
    default:
      yield event;
  }
}

function* anthropicFlush(index: number, restorers: Restorers): Generator<UpstreamEvent> {
  const text = restorers.flush(`${index}:text`);
  if (text) yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text } };
  const json = restorers.flush(`${index}:json`);
  if (json)
    yield {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: json },
    };
}

function anthropicTail(restorers: Restorers): UpstreamEvent[] {
  const out: UpstreamEvent[] = [];
  const indexes = new Set(restorers.keys().map((k) => Number(k.split(':')[0])));
  for (const index of indexes) out.push(...anthropicFlush(index, restorers));
  return out;
}
