import { describe, expect, it } from 'vitest';
import { readSSE } from './sse';

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      parts.forEach((p) => controller.enqueue(encoder.encode(p)));
      controller.close();
    },
  });
}

describe('readSSE', () => {
  it('yields data payloads across chunk boundaries and skips comments', async () => {
    const out: string[] = [];
    for await (const data of readSSE(
      streamOf(['data: {"a"', ':1}\n\n: keep-alive\n\n', 'data: {"b":2}\r\n\r\n', 'data: tail']),
    )) {
      out.push(data);
    }
    expect(out).toEqual(['{"a":1}', '{"b":2}', 'tail']);
  });
});
