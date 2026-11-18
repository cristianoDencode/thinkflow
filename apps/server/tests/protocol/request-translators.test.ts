import { describe, expect, it } from 'vitest';
import {
  anthropicToOpenAIRequest,
  openAIToAnthropicRequest,
  stripUnsignedThinking,
} from '../../src/contexts/protocol/domain/request-translators';
import type { ARequest, OAIRequest } from '../../src/contexts/protocol/domain/wire-types';

describe('anthropicToOpenAIRequest', () => {
  const claudeCodeLike: ARequest = {
    model: 'claude-sonnet-5-5',
    max_tokens: 4096,
    stream: true,
    system: [
      { type: 'text', text: 'You are Claude Code.' },
      { type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } },
    ],
    tools: [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
      { type: 'web_search_20260209', name: 'web_search' },
    ],
    tool_choice: { type: 'auto' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read a.txt' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'need to read', signature: 'sig' },
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: 'hello' }],
          },
          { type: 'text', text: 'Summarize it' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        ],
      },
    ],
  };

  it('converts system, tools, tool calls and tool results', () => {
    const out = anthropicToOpenAIRequest(claudeCodeLike);
    expect(out.messages[0]).toEqual({
      role: 'system',
      content: 'You are Claude Code.\n\nBe concise.',
    });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'Read a.txt' });
    expect(out.messages[2]).toEqual({
      role: 'assistant',
      content: 'Reading.',
      tool_calls: [
        {
          id: 'toolu_1',
          type: 'function',
          function: { name: 'Read', arguments: '{"path":"a.txt"}' },
        },
      ],
    });
    expect(out.messages[3]).toEqual({ role: 'tool', tool_call_id: 'toolu_1', content: 'hello' });
    expect(out.messages[4]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Summarize it' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    });
    expect(out.tools).toHaveLength(1); // server tool dropped
    expect(out.tools?.[0]?.function.name).toBe('Read');
    expect(out.tool_choice).toBe('auto');
    expect(out.max_tokens).toBe(4096);
    expect(out.stream).toBe(true);
  });

  it('maps tool_choice variants', () => {
    const base = { ...claudeCodeLike };
    expect(anthropicToOpenAIRequest({ ...base, tool_choice: { type: 'any' } }).tool_choice).toBe(
      'required',
    );
    expect(
      anthropicToOpenAIRequest({ ...base, tool_choice: { type: 'tool', name: 'Read' } })
        .tool_choice,
    ).toEqual({
      type: 'function',
      function: { name: 'Read' },
    });
  });

  it('marks failed tool results', () => {
    const out = anthropicToOpenAIRequest({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }],
        },
      ],
    });
    expect(out.messages[0]).toEqual({ role: 'tool', tool_call_id: 't', content: 'Erro: boom' });
  });
});

describe('openAIToAnthropicRequest', () => {
  it('converts a tool conversation and merges consecutive tool results', () => {
    const body: OAIRequest = {
      model: 'claude-x',
      stream: true,
      stop: 'END',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
            { id: 'c2', type: 'function', function: { name: 'b', arguments: 'not json' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
        { role: 'tool', tool_call_id: 'c2', content: 'r2' },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZZZ' } }],
        },
      ],
      tools: [{ type: 'function', function: { name: 'a', parameters: { type: 'object' } } }],
      tool_choice: 'required',
    };
    const out = openAIToAnthropicRequest(body);
    expect(out.system).toBe('sys');
    expect(out.max_tokens).toBe(8192);
    expect(out.stop_sequences).toEqual(['END']);
    expect(out.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'a', input: { x: 1 } },
          { type: 'tool_use', id: 'c2', name: 'b', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
          { type: 'tool_result', tool_use_id: 'c2', content: 'r2' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZZZ' } },
        ],
      },
    ]);
    expect(out.tools).toEqual([{ name: 'a', input_schema: { type: 'object' } }]);
    expect(out.tool_choice).toEqual({ type: 'any' });
  });

  it('round-trips a simple conversation', () => {
    const original: OAIRequest = {
      model: 'm',
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
      ],
    };
    const back = anthropicToOpenAIRequest(openAIToAnthropicRequest(original));
    expect(back.messages).toEqual(original.messages);
  });
});

describe('stripUnsignedThinking', () => {
  it('removes thinking blocks produced by non-Anthropic upstreams only', () => {
    const out = stripUnsignedThinking({
      model: 'x',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'a', signature: '' },
            { type: 'thinking', thinking: 'b', signature: 'real' },
            { type: 'text', text: 't' },
          ],
        },
      ],
    });
    expect((out.messages[0]!.content as unknown[]).length).toBe(2);
  });
});
