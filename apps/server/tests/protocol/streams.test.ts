import { describe, expect, it } from 'vitest';
import {
  accumulateAnthropic,
  accumulateOpenAI,
} from '../../src/contexts/protocol/domain/accumulators';
import { convertStream, tapUsage } from '../../src/contexts/protocol/domain/convert';
import { parseSSE } from '../../src/contexts/protocol/domain/sse';
import {
  AnthropicToOpenAIStream,
  OpenAIToAnthropicStream,
} from '../../src/contexts/protocol/domain/stream-translators';
import { completionToChunks, messageToEvents } from '../../src/contexts/protocol/domain/synthesize';
import type { AStreamEvent, OAIChunk } from '../../src/contexts/protocol/domain/wire-types';
import { anthropicFrames, collect, openAIFrames } from '../helpers';

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

const chunk = (
  delta: OAIChunk['choices'][number]['delta'],
  finish: string | null = null,
): OAIChunk => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'm',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

describe('parseSSE', () => {
  it('handles frames split across chunks, CRLF, comments and multi-line data', async () => {
    const parts = [
      'event: a\r\nda',
      'ta: {"x":1}\r\n\r\n',
      ': comment\n',
      'data: line1\ndata: line2\n\n',
      'data: tail',
    ];
    const out = await collect(parseSSE(from(parts)));
    expect(out).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: null, data: 'line1\nline2' },
      { event: null, data: 'tail' },
    ]);
  });
});

describe('OpenAIToAnthropicStream', () => {
  it('emits a valid Anthropic event sequence with text, reasoning and tool use', () => {
    const t = new OpenAIToAnthropicStream('claude-sonnet', 'msg_test');
    const events: AStreamEvent[] = [
      ...t.push(chunk({ role: 'assistant', reasoning: 'thinking…' })),
      ...t.push(chunk({ content: 'Hello' })),
      ...t.push(chunk({ content: ' world' })),
      ...t.push(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'Read', arguments: '{"pa' },
            },
          ],
        }),
      ),
      ...t.push(chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] })),
      ...t.push(chunk({}, 'tool_calls')),
      ...t.push({ ...chunk({}), choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }),
      ...t.flush(),
    ];
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start', // thinking
      'content_block_delta',
      'content_block_stop',
      'content_block_start', // text
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start', // tool_use
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const delta = events.find((e) => e.type === 'message_delta') as Extract<
      AStreamEvent,
      { type: 'message_delta' }
    >;
    expect(delta.delta.stop_reason).toBe('tool_use');
    expect(delta.usage).toEqual({ input_tokens: 11, output_tokens: 3 });
  });

  it('round-trips through the Anthropic accumulator', async () => {
    const t = new OpenAIToAnthropicStream('m');
    const events = [
      ...t.push(chunk({ content: 'Hi' })),
      ...t.push(
        chunk({
          tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"a":1}' } }],
        }),
      ),
      ...t.flush(),
    ];
    const message = await accumulateAnthropic(from(events), 'm');
    expect(message.content).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'tool_use', id: 'c', name: 'f', input: { a: 1 } },
    ]);
    expect(message.stop_reason).toBe('tool_use');
  });
});

describe('AnthropicToOpenAIStream', () => {
  it('converts text, tool use and usage', async () => {
    const t = new AnthropicToOpenAIStream('m');
    const input: AStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: 'claude',
          usage: { input_tokens: 5, cache_read_input_tokens: 5 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hey' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu', name: 'Grep', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ];
    const chunks = input.flatMap((e) => t.push(e));
    const completion = await accumulateOpenAI(from(chunks), 'm');
    expect(completion.id).toBe('msg_1');
    expect(completion.choices[0]?.message.content).toBe('Hey');
    expect(completion.choices[0]?.message.tool_calls).toEqual([
      { id: 'tu', type: 'function', function: { name: 'Grep', arguments: '{"q":"x"}' } },
    ]);
    expect(completion.choices[0]?.finish_reason).toBe('tool_calls');
    expect(completion.usage).toEqual({ prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 });
  });
});

describe('convertStream + tapUsage', () => {
  it('passes through same-format streams and tracks usage', async () => {
    const parsed = (await collect(parseSSE(from(openAIFrames('a b c')))))
      .filter((m) => m.data !== '[DONE]')
      .map((m) => JSON.parse(m.data) as Record<string, unknown>);
    const totals = { inputTokens: null as number | null, outputTokens: null as number | null };
    const out = await collect(
      tapUsage(convertStream(from(parsed), 'openai', 'openai', 'm'), 'openai', totals),
    );
    expect(out).toHaveLength(parsed.length);
    expect(totals).toEqual({ inputTokens: 12, outputTokens: 5 });
  });

  it('converts an Anthropic upstream for an OpenAI client', async () => {
    const parsed = (await collect(parseSSE(from(anthropicFrames('olá')))))
      .map((m) => JSON.parse(m.data) as Record<string, unknown>)
      .filter((e) => e.type !== 'ping');
    const completion = await accumulateOpenAI(
      convertStream(from(parsed), 'anthropic', 'openai', 'm') as AsyncIterable<OAIChunk>,
      'm',
    );
    expect(completion.choices[0]?.message.content).toBe('olá');
  });
});

describe('synthesize', () => {
  it('turns non-streaming payloads into equivalent streams', async () => {
    const chunks = completionToChunks({
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    expect((await accumulateOpenAI(from(chunks), 'm')).choices[0]?.message.content).toBe('done');

    const events = messageToEvents({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'c',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    expect((await accumulateAnthropic(from(events), 'c')).content).toEqual([
      { type: 'text', text: 'ok' },
    ]);
  });
});
