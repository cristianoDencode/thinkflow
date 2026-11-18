import type { ChatRequestInput, ChatStreamEvent } from '@thinkflow/shared';
import { ApiError, UNAUTHORIZED_EVENT } from './api';

/** Parses `data:` frames from a fetch body stream. */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith('data:')) yield rest.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

/** Sends a chat turn and dispatches each streamed event. */
export async function streamChat(
  request: ChatRequestInput,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    let message = `Erro ${response.status}`;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // keep default
    }
    if (response.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(message, response.status);
  }
  for await (const data of readSSE(response.body)) {
    try {
      onEvent(JSON.parse(data) as ChatStreamEvent);
    } catch {
      // ignore malformed frames
    }
  }
}
