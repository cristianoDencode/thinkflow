import type { AContentBlock, AStreamEvent, AUsage, OAIChunk } from './wire-types';

let counter = 0;
function genId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function mapOpenAIFinishToAnthropic(reason: string | null, sawToolUse: boolean): string {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return sawToolUse ? 'tool_use' : 'end_turn';
  }
}

export function mapAnthropicStopToOpenAI(reason: string | null | undefined): string {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

type OpenBlock =
  { kind: 'text' } | { kind: 'thinking' } | { kind: 'tool'; oaiIndex: number } | null;

/** Converts a stream of OpenAI chat chunks into Anthropic Messages stream events. */
export class OpenAIToAnthropicStream {
  private started = false;
  private finished = false;
  private blockIndex = -1;
  private open: OpenBlock = null;
  private readonly toolBlocks = new Map<number, number>();
  private finishReason: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private sawToolUse = false;

  constructor(
    private readonly model: string,
    private readonly messageId: string = genId('msg_'),
  ) {}

  push(chunk: OAIChunk): AStreamEvent[] {
    const out: AStreamEvent[] = [];
    this.ensureStarted(out);
    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = chunk.usage.completion_tokens ?? this.outputTokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta ?? {};

    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) {
      this.openBlock(out, { kind: 'thinking' }, { type: 'thinking', thinking: '', signature: '' });
      out.push({
        type: 'content_block_delta',
        index: this.blockIndex,
        delta: { type: 'thinking_delta', thinking: reasoning },
      });
    }
    if (delta.content) {
      this.openBlock(out, { kind: 'text' }, { type: 'text', text: '' });
      out.push({
        type: 'content_block_delta',
        index: this.blockIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }
    for (const call of delta.tool_calls ?? []) {
      const oaiIndex = call.index ?? 0;
      if (!this.toolBlocks.has(oaiIndex)) {
        this.closeBlock(out);
        this.blockIndex += 1;
        this.toolBlocks.set(oaiIndex, this.blockIndex);
        this.open = { kind: 'tool', oaiIndex };
        this.sawToolUse = true;
        out.push({
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: {
            type: 'tool_use',
            id: call.id || genId('toolu_'),
            name: call.function?.name ?? '',
            input: {},
          },
        });
      }
      const args = call.function?.arguments;
      if (args) {
        out.push({
          type: 'content_block_delta',
          index: this.toolBlocks.get(oaiIndex)!,
          delta: { type: 'input_json_delta', partial_json: args },
        });
      }
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return out;
  }

  flush(): AStreamEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const out: AStreamEvent[] = [];
    this.ensureStarted(out);
    this.closeBlock(out);
    out.push({
      type: 'message_delta',
      delta: {
        stop_reason: mapOpenAIFinishToAnthropic(this.finishReason, this.sawToolUse),
        stop_sequence: null,
      },
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
    });
    out.push({ type: 'message_stop' });
    return out;
  }

  private ensureStarted(out: AStreamEvent[]): void {
    if (this.started) return;
    this.started = true;
    out.push({
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private openBlock(
    out: AStreamEvent[],
    kind: Exclude<OpenBlock, null>,
    block: AContentBlock,
  ): void {
    if (this.open && this.open.kind === kind.kind && kind.kind !== 'tool') return;
    this.closeBlock(out);
    this.blockIndex += 1;
    this.open = kind;
    out.push({ type: 'content_block_start', index: this.blockIndex, content_block: block });
  }

  private closeBlock(out: AStreamEvent[]): void {
    if (!this.open) return;
    out.push({ type: 'content_block_stop', index: this.blockIndex });
    this.open = null;
  }
}

/** Converts Anthropic Messages stream events into OpenAI chat chunks. */
export class AnthropicToOpenAIStream {
  private id = genId('chatcmpl-');
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly blocks = new Map<number, { type: string; toolIndex?: number }>();
  private toolCount = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(private model: string) {}

  push(event: AStreamEvent): OAIChunk[] {
    switch (event.type) {
      case 'message_start': {
        if (event.message.id) this.id = event.message.id;
        if (event.message.model) this.model = event.message.model;
        this.inputTokens = totalInput(event.message.usage);
        return [this.chunk({ role: 'assistant', content: '' })];
      }
      case 'content_block_start': {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          const toolIndex = this.toolCount++;
          this.blocks.set(event.index, { type: 'tool_use', toolIndex });
          const b = block as { id: string; name: string };
          return [
            this.chunk({
              tool_calls: [
                {
                  index: toolIndex,
                  id: b.id,
                  type: 'function',
                  function: { name: b.name, arguments: '' },
                },
              ],
            }),
          ];
        }
        this.blocks.set(event.index, { type: block.type });
        const text = (block as { text?: string }).text;
        return block.type === 'text' && text ? [this.chunk({ content: text })] : [];
      }
      case 'content_block_delta': {
        const delta = event.delta as {
          type: string;
          text?: string;
          partial_json?: string;
          thinking?: string;
        };
        if (delta.type === 'text_delta' && delta.text) return [this.chunk({ content: delta.text })];
        if (delta.type === 'thinking_delta' && delta.thinking)
          return [this.chunk({ reasoning_content: delta.thinking })];
        if (delta.type === 'input_json_delta' && delta.partial_json) {
          const toolIndex = this.blocks.get(event.index)?.toolIndex ?? 0;
          return [
            this.chunk({
              tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }],
            }),
          ];
        }
        return [];
      }
      case 'message_delta': {
        if (event.usage?.output_tokens !== undefined) this.outputTokens = event.usage.output_tokens;
        if (event.usage?.input_tokens) this.inputTokens = totalInput(event.usage);
        return [this.chunk({}, mapAnthropicStopToOpenAI(event.delta?.stop_reason))];
      }
      case 'message_stop':
        return [
          {
            id: this.id,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.model,
            choices: [],
            usage: {
              prompt_tokens: this.inputTokens,
              completion_tokens: this.outputTokens,
              total_tokens: this.inputTokens + this.outputTokens,
            },
          },
        ];
      default:
        return [];
    }
  }

  private chunk(
    delta: OAIChunk['choices'][number]['delta'],
    finishReason: string | null = null,
  ): OAIChunk {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }
}

function totalInput(usage: AUsage | undefined): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}
