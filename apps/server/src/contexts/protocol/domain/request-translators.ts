import type {
  AContentBlock,
  AMessage,
  ARequest,
  ATool,
  AToolChoice,
  OAIContentPart,
  OAIMessage,
  OAIRequest,
  OAITool,
  OAIToolChoice,
} from './wire-types';

export const DEFAULT_MAX_TOKENS = 8192;

/* ================= Anthropic Messages → OpenAI Chat ================= */

export function anthropicToOpenAIRequest(body: ARequest): OAIRequest {
  const messages: OAIMessage[] = [];
  const system = systemToText(body.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      const text = message.content
        .filter(isText)
        .map((b) => b.text)
        .join('');
      const toolCalls = message.content.filter(isToolUse).map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const out: OAIMessage = { role: 'assistant', content: text || null };
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      if (text || toolCalls.length > 0) messages.push(out);
      continue;
    }

    // user turn: tool results become separate `tool` messages (they must follow the assistant turn)
    const parts: OAIContentPart[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const b = block as Extract<AContentBlock, { type: 'tool_result' }>;
        const text = toolResultToText(b.content);
        messages.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: b.is_error ? `Erro: ${text}` : text,
        });
      } else if (isText(block)) {
        if (block.text) parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const url = imageSourceToUrl((block as Extract<AContentBlock, { type: 'image' }>).source);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      } else if (block.type === 'document') {
        const source = (block as Extract<AContentBlock, { type: 'document' }>).source;
        if (source?.type === 'text' && source.data) parts.push({ type: 'text', text: source.data });
      }
    }
    if (parts.length > 0) {
      const onlyText = parts.every((p) => p.type === 'text');
      messages.push({
        role: 'user',
        content: onlyText ? parts.map((p) => (p as { text: string }).text).join('\n') : parts,
      });
    }
  }

  const out: OAIRequest = { model: body.model, messages, stream: body.stream === true };
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;

  const tools: OAITool[] = (body.tools ?? []).filter(isCustomTool).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }));
  if (tools.length > 0) {
    out.tools = tools;
    const choice = anthropicToolChoiceToOpenAI(body.tool_choice);
    if (choice) out.tool_choice = choice;
  }
  return out;
}

function anthropicToolChoiceToOpenAI(choice: AToolChoice | undefined): OAIToolChoice | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
    default:
      return undefined;
  }
}

/* ================= OpenAI Chat → Anthropic Messages ================= */

export function openAIToAnthropicRequest(body: OAIRequest): ARequest {
  const systemParts: string[] = [];
  const messages: AMessage[] = [];

  const push = (role: 'user' | 'assistant', blocks: AContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') {
      const text = contentToText(m.content);
      if (text) systemParts.push(text);
    } else if (m.role === 'user') {
      push('user', openAIContentToBlocks(m.content));
    } else if (m.role === 'assistant') {
      const blocks: AContentBlock[] = [];
      const text = contentToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: safeJsonParse(call.function.arguments),
        });
      }
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: contentToText(m.content),
        },
      ]);
    }
  }

  if (messages[0]?.role === 'assistant')
    messages.unshift({ role: 'user', content: '(continuação)' });

  const out: ARequest = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
    stream: body.stream === true,
  };
  if (systemParts.length > 0) out.system = systemParts.join('\n\n');
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  if (body.tools?.length) {
    out.tools = body.tools.map((t): ATool => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
    const choice = openAIToolChoiceToAnthropic(body.tool_choice);
    if (choice) out.tool_choice = choice;
  }
  return out;
}

function openAIToolChoiceToAnthropic(choice: OAIToolChoice | undefined): AToolChoice | undefined {
  if (!choice) return undefined;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  if (typeof choice === 'object' && choice.function?.name)
    return { type: 'tool', name: choice.function.name };
  return undefined;
}

function openAIContentToBlocks(content: OAIMessage['content']): AContentBlock[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const blocks: AContentBlock[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
    if (part.type === 'image_url') {
      const source = urlToImageSource(part.image_url.url);
      if (source) blocks.push({ type: 'image', source });
    }
  }
  return blocks;
}

/* ============================== helpers ============================= */

/** Removes thinking blocks without a signature (produced by non-Anthropic upstreams). */
export function stripUnsignedThinking(body: ARequest): ARequest {
  return {
    ...body,
    messages: (body.messages ?? []).map((m) =>
      typeof m.content === 'string'
        ? m
        : {
            ...m,
            content: m.content.filter(
              (b) => !(b.type === 'thinking' && !(b as { signature?: string }).signature),
            ),
          },
    ),
  };
}

export function systemToText(system: ARequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system
    .map((b) => b.text)
    .filter(Boolean)
    .join('\n\n');
}

export function contentToText(content: OAIMessage['content']): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function toolResultToText(content: string | AContentBlock[] | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((b) => (isText(b) ? b.text : b.type === 'image' ? '[imagem]' : ''))
    .filter(Boolean)
    .join('\n');
}

function imageSourceToUrl(source: {
  type: string;
  media_type?: string;
  data?: string;
  url?: string;
}): string | null {
  if (source.type === 'base64' && source.data)
    return `data:${source.media_type ?? 'image/png'};base64,${source.data}`;
  if (source.type === 'url' && source.url) return source.url;
  return null;
}

function urlToImageSource(
  url: string,
): { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (match) return { type: 'base64', media_type: match[1]!, data: match[2]! };
  if (/^https?:\/\//.test(url)) return { type: 'url', url };
  return null;
}

function isText(block: AContentBlock): block is { type: 'text'; text: string } {
  return block.type === 'text' && typeof (block as { text?: unknown }).text === 'string';
}

function isToolUse(
  block: AContentBlock,
): block is { type: 'tool_use'; id: string; name: string; input: unknown } {
  return block.type === 'tool_use';
}

/** Server tools (web_search_*, bash_*, …) have a `type` and no input_schema — they can't be proxied. */
function isCustomTool(tool: ATool): boolean {
  return (tool.type === undefined || tool.type === 'custom') && typeof tool.name === 'string';
}

export function safeJsonParse(text: string | undefined): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
