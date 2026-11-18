export interface SSEMessage {
  event: string | null;
  data: string;
}

/** Incremental Server-Sent Events parser (spec-compliant enough for LLM providers). */
export async function* parseSSE(
  body: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | null = null;
  let data: string[] = [];

  function* processLine(rawLine: string): Generator<SSEMessage> {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      if (data.length > 0) yield { event, data: data.join('\n') };
      event = null;
      data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      yield* processLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield* processLine(buffer);
  if (data.length > 0) yield { event, data: data.join('\n') };
}

export function formatOpenAISSE(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export const OPENAI_SSE_DONE = 'data: [DONE]\n\n';

export function formatAnthropicSSE(event: { type: string }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
