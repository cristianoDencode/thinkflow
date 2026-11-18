import { Combo } from '../src/contexts/connections/domain/combo';
import { Connection } from '../src/contexts/connections/domain/connection';
import type {
  ComboRepository,
  ConnectionRepository,
} from '../src/contexts/connections/domain/ports';
import type { RequestLogEntry, RequestLogRepository } from '../src/contexts/routing/domain/ports';
import type { FetchFn } from '../src/contexts/connections/infrastructure/provider-http';

export function makeConnection(
  overrides: Partial<Parameters<typeof Connection.create>[0]> & { id: string },
): Connection {
  return Connection.create(
    {
      providerId: 'groq',
      name: overrides.id,
      apiKey: `key-${overrides.id}`,
      baseUrl: '',
      priority: 10,
      enabled: true,
      defaultModel: '',
      ...overrides,
    },
    0,
  );
}

export class InMemoryConnectionRepository implements ConnectionRepository {
  readonly items = new Map<string, Connection>();
  constructor(initial: Connection[] = []) {
    initial.forEach((c) => this.items.set(c.id, c));
  }
  async list() {
    return [...this.items.values()];
  }
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByProvider(providerId: string) {
    return [...this.items.values()].filter((c) => c.providerId === providerId);
  }
  async save(c: Connection) {
    this.items.set(c.id, c);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryComboRepository implements ComboRepository {
  readonly items = new Map<string, Combo>();
  constructor(initial: Combo[] = []) {
    initial.forEach((c) => this.items.set(c.id, c));
  }
  async list() {
    return [...this.items.values()];
  }
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByName(name: string) {
    return [...this.items.values()].find((c) => c.name === name) ?? null;
  }
  async save(c: Combo) {
    this.items.set(c.id, c);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryLogRepository implements RequestLogRepository {
  readonly entries: RequestLogEntry[] = [];
  async add(entry: RequestLogEntry) {
    this.entries.push(entry);
  }
  async list(limit: number) {
    return this.entries.slice(-limit).reverse();
  }
}

export function makeCombo(
  name: string,
  targets: { providerId: string; model: string; connectionId?: string }[],
  strategy: 'priority' | 'round-robin' = 'priority',
) {
  return Combo.create({ id: `combo-${name}`, name, strategy, targets, createdAt: 0 });
}

export const seqIds = () => {
  let n = 0;
  return { next: () => `id-${++n}` };
};

/* ------------------------------ fake HTTP ------------------------------ */

export function sseResponse(
  frames: string[],
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) },
  });
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function openAIFrames(
  text: string,
  options: { model?: string; usage?: boolean } = {},
): string[] {
  const base = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: options.model ?? 'm',
  };
  const frames = [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    },
    ...text.split(' ').map((w, i) => ({
      ...base,
      choices: [{ index: 0, delta: { content: i === 0 ? w : ` ${w}` }, finish_reason: null }],
    })),
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  if (options.usage !== false)
    frames.push({
      ...base,
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    } as never);
  return [...frames.map((f) => `data: ${JSON.stringify(f)}\n\n`), 'data: [DONE]\n\n'];
}

export function anthropicFrames(text: string): string[] {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 20, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'ping' },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 7 },
    },
    { type: 'message_stop' },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

export interface RecordedCall {
  url: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/** Fake fetch: routes each call to the first handler whose predicate matches. */
export function fakeFetch(
  handlers: {
    match: (
      url: string,
      body: Record<string, unknown> | null,
      headers: Record<string, string>,
    ) => boolean;
    respond: () => Response;
  }[],
) {
  const calls: RecordedCall[] = [];
  const fn: FetchFn = async (url, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    calls.push({ url, body, headers });
    const handler = handlers.find((h) => h.match(url, body, headers));
    if (!handler) throw new TypeError(`fetch failed: no handler for ${url}`);
    return handler.respond();
  };
  return { fn, calls };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** Serializes files into a multipart/form-data body (field `files`) using the platform's FormData. */
export async function multipartBody(
  files: { name: string; bytes: Uint8Array | string; type?: string }[],
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData();
  for (const f of files) {
    const bytes = typeof f.bytes === 'string' ? Buffer.from(f.bytes) : Buffer.from(f.bytes);
    form.append('files', new Blob([bytes], { type: f.type ?? '' }), f.name);
  }
  const res = new Response(form);
  return {
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { 'content-type': res.headers.get('content-type') ?? '' },
  };
}
