import { describe, expect, it } from 'vitest';
import { stripToolCallExtraContent } from '../../src/contexts/protocol/domain/tool-call-sanitizer';
import type { OAIMessage } from '../../src/contexts/protocol/domain/wire-types';

describe('stripToolCallExtraContent', () => {
  it('drops extra_content from tool calls, leaving other messages and the input untouched', () => {
    const input: OAIMessage[] = [
      { role: 'user', content: 'oi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c',
            type: 'function',
            function: { name: 'f', arguments: '{}' },
            extra_content: { google: { thought_signature: 'REAL' } },
          },
        ],
      },
    ];
    const out = stripToolCallExtraContent(input);
    expect(out[1]!.tool_calls![0]).not.toHaveProperty('extra_content');
    expect(out[1]!.tool_calls![0]!.function.name).toBe('f');
    expect(out[0]).toBe(input[0]);
    expect(input[1]!.tool_calls![0]!.extra_content).toBeDefined();
  });
});
