import type {
  DiagramRenderer,
  DiagramRenderResult,
  PdfRenderer,
  RendererStatus,
} from '../../src/contexts/reports/domain/render-ports';
import type { FetchFn } from '../../src/contexts/connections/infrastructure/provider-http';

export const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
export const MODEL = 'groq/llama';

export const sse = (frames: object[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
const chunk = (delta: object, finish: string | null = null) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'llama',
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const usageChunk = {
  id: 'c',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'llama',
  choices: [],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
};
export const textResponse = (text: string) =>
  sse([chunk({ role: 'assistant', content: text }), chunk({}, 'stop'), usageChunk]);

export type Kind = 'outline' | 'section' | 'repair' | 'screens' | 'screen' | 'other';
export interface Call {
  kind: Kind;
  /** Section number (kind 'section'). */
  n: number;
  user: string;
}

function classify(user: string): { kind: Kind; n: number } {
  if (user.includes('Monte o roteiro')) return { kind: 'outline', n: 0 };
  if (user.includes('Corrija este diagrama Mermaid')) return { kind: 'repair', n: 0 };
  if (user.includes('Planeje as telas do protótipo')) return { kind: 'screens', n: 0 };
  if (user.includes('Escreva a tela "')) return { kind: 'screen', n: 0 };
  const section = user.match(/Escreva SOMENTE a seção (\d+) de/);
  if (section) return { kind: 'section', n: Number(section[1]) };
  return { kind: 'other', n: 0 };
}

export interface Provider {
  fetchFn: FetchFn;
  calls: Call[];
  count(kind: Kind): number;
  /** Answer of each kind (text); the default is a short filler text. */
  answer: Partial<Record<Kind, (call: Call) => string>>;
  /** While set, every call waits for it (lets a test observe a report mid-generation). */
  gate: Promise<void> | null;
}

/** Fake Groq: classifies the call by its prompt and answers with text (no tools). */
export function makeProvider(): Provider {
  const calls: Call[] = [];
  const provider: Provider = {
    calls,
    answer: {},
    gate: null,
    count: (kind) => calls.filter((c) => c.kind === kind).length,
    fetchFn: async (url, init) => {
      if (url !== GROQ) throw new TypeError(`fetch failed: no handler for ${url}`);
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content?: string }[];
      };
      const user = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      const call: Call = { ...classify(user), user };
      calls.push(call);
      await provider.gate;
      return textResponse(provider.answer[call.kind]?.(call) ?? `Conteúdo da seção ${call.n}.`);
    },
  };
  return provider;
}

/** Diagram renderer fake: `BROKEN` in the source is a syntax error; the SVG embeds the source. */
export class FakeDiagramRenderer implements DiagramRenderer {
  renders: string[] = [];
  available = true;
  async status(): Promise<RendererStatus> {
    return {
      available: this.available,
      reason: this.available ? null : 'sem chromium',
      executablePath: '/fake/chrome',
    };
  }
  async render(code: string): Promise<DiagramRenderResult> {
    this.renders.push(code);
    if (!this.available) return { ok: false, error: 'sem chromium', unavailable: true };
    if (code.includes('BROKEN')) return { ok: false, error: 'Parse error on line 2' };
    return {
      ok: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>fake-diagram</title><text>${code
        .split('\n')[0]!
        .replace(/[<>&]/g, '')}</text></svg>`,
    };
  }
}

export class FakePdfRenderer implements PdfRenderer {
  calls: { html: string; header: string; footer: string; pageSize: string }[] = [];
  available = true;
  async status(): Promise<RendererStatus> {
    return {
      available: this.available,
      reason: this.available ? null : 'sem chromium',
      executablePath: '/fake/chrome',
    };
  }
  async pdf(
    html: string,
    options: { headerTemplate: string; footerTemplate: string; pageSize: string },
  ): Promise<Uint8Array> {
    this.calls.push({
      html,
      header: options.headerTemplate,
      footer: options.footerTemplate,
      pageSize: options.pageSize,
    });
    return new TextEncoder().encode(`%PDF-1.4 fake ${this.calls.length}`);
  }
}
