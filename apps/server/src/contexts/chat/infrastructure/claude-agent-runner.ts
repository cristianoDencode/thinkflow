import {
  deleteSession,
  query,
  type McpServerConfig,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { McpServer } from '../../mcp/domain/mcp-server';
import type { AgentRunParams, AgentRunResult, AgentRunner, EmitFn } from '../domain/conversation';

export interface ClaudeAgentRunnerOptions {
  /** Base URL of this Thinkflow instance (the agent sends /v1/messages back to us). */
  baseUrl: () => string;
  /** API key accepted by our /v1 endpoints. */
  apiKey: () => string;
  /** Injectable for tests. */
  queryFn?: typeof query;
}

const MAX_TOOL_OUTPUT_CHARS = 20_000;

/**
 * Runs Claude Code (via the Claude Agent SDK) with ANTHROPIC_BASE_URL pointing at
 * Thinkflow's own /v1/messages, so every model call goes through the router while the
 * agent keeps Claude Code's tools, MCP support, plan mode and permission handling.
 */
export class ClaudeAgentRunner implements AgentRunner {
  constructor(private readonly options: ClaudeAgentRunnerOptions) {}

  async deleteSession(sessionId: string, cwd: string): Promise<void> {
    await deleteSession(sessionId, { dir: cwd });
  }

  async run(params: AgentRunParams, emit: EmitFn): Promise<AgentRunResult> {
    const abortController = new AbortController();
    params.signal?.addEventListener('abort', () => abortController.abort(), { once: true });

    const env: Record<string, string | undefined> = {
      ...process.env,
      ANTHROPIC_BASE_URL: this.options.baseUrl(),
      ANTHROPIC_AUTH_TOKEN: this.options.apiKey(),
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: params.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: params.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: params.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: params.model,
      CLAUDE_CODE_SUBAGENT_MODEL: params.model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'thinkflow/0.1.0',
      // the gateway maps this to the conversation's privacy vault (honored for our internal key only)
      ...(params.conversationId
        ? { ANTHROPIC_CUSTOM_HEADERS: `x-thinkflow-privacy-scope: ${params.conversationId}` }
        : {}),
    };

    const sdkOptions: Options = {
      cwd: params.cwd,
      model: params.model,
      env,
      abortController,
      includePartialMessages: true,
      permissionMode: params.permissionMode,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Responda em português do Brasil, a menos que o usuário peça outro idioma.',
      },
      mcpServers: toSdkMcpServers(params.mcpServers),
      ...(params.permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(params.sessionId ? { resume: params.sessionId } : {}),
      // No interactive prompt exists in the dashboard: anything not pre-approved by the mode is denied.
      canUseTool: async (toolName, input) =>
        params.permissionMode === 'default'
          ? {
              behavior: 'deny',
              message: `A ferramenta ${toolName} exige permissão. Troque o modo de permissão no Thinkflow para permitir.`,
            }
          : { behavior: 'allow', updatedInput: input },
    };

    const result: AgentRunResult = {
      sessionId: params.sessionId,
      text: '',
      toolCalls: [],
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
    };
    const toolNames = new Map<string, string>();
    let streamedText = '';

    try {
      const run = (this.options.queryFn ?? query)({ prompt: params.prompt, options: sdkOptions });
      for await (const message of run as AsyncIterable<SDKMessage>) {
        this.handle(message, { emit, result, toolNames, appendText: (t) => (streamedText += t) });
      }
    } catch (err) {
      result.error = abortController.signal.aborted
        ? 'Execução cancelada'
        : err instanceof Error
          ? err.message
          : String(err);
    }
    if (!result.text) result.text = streamedText;
    return result;
  }

  private handle(
    message: SDKMessage,
    ctx: {
      emit: EmitFn;
      result: AgentRunResult;
      toolNames: Map<string, string>;
      appendText: (t: string) => void;
    },
  ): void {
    const { emit, result, toolNames } = ctx;
    const m = message as {
      type: string;
      subtype?: string;
      session_id?: string;
      parent_tool_use_id?: string | null;
    };
    if (m.session_id) result.sessionId = m.session_id;

    switch (m.type) {
      case 'stream_event': {
        if (m.parent_tool_use_id) return; // sub-agent output stays inside its Task tool result
        const event = (
          message as {
            event: { type: string; delta?: { type: string; text?: string; thinking?: string } };
          }
        ).event;
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          event.delta.text
        ) {
          ctx.appendText(event.delta.text);
          emit({ type: 'delta', text: event.delta.text });
        } else if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'thinking_delta' &&
          event.delta.thinking
        ) {
          emit({ type: 'reasoning', text: event.delta.thinking });
        }
        return;
      }
      case 'assistant': {
        if (m.parent_tool_use_id) return;
        const content = (
          message as {
            message: { content: { type: string; id?: string; name?: string; input?: unknown }[] };
          }
        ).message.content;
        let hasText = false;
        for (const block of content ?? []) {
          if (block.type === 'tool_use' && block.id && block.name) {
            toolNames.set(block.id, block.name);
            result.toolCalls.push({ id: block.id, name: block.name, input: block.input });
            emit({ type: 'tool_call', id: block.id, name: block.name, input: block.input });
          }
          if (block.type === 'text') hasText = true;
        }
        if (hasText) ctx.appendText('\n\n');
        return;
      }
      case 'user': {
        if (m.parent_tool_use_id) return;
        const content = (message as { message: { content: unknown } }).message.content;
        if (!Array.isArray(content)) return;
        for (const block of content as {
          type: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }[]) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const output = truncate(renderToolResult(block.content), MAX_TOOL_OUTPUT_CHARS);
          const name = toolNames.get(block.tool_use_id) ?? 'tool';
          const call = result.toolCalls.find((c) => c.id === block.tool_use_id);
          if (call) {
            call.output = output;
            call.isError = Boolean(block.is_error);
          }
          emit({
            type: 'tool_result',
            id: block.tool_use_id,
            name,
            output,
            isError: Boolean(block.is_error),
          });
        }
        return;
      }
      case 'result': {
        const r = message as {
          subtype: string;
          result?: string;
          total_cost_usd?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
          errors?: string[];
          is_error?: boolean;
        };
        result.costUsd = r.total_cost_usd ?? null;
        result.inputTokens = r.usage?.input_tokens ?? null;
        result.outputTokens = r.usage?.output_tokens ?? null;
        if (r.subtype === 'success' && typeof r.result === 'string') {
          result.text = r.result;
          if (r.is_error) result.error = r.result;
        } else if (r.subtype !== 'success') {
          result.error = r.errors?.join('\n') || `O agente terminou com erro (${r.subtype})`;
        }
        return;
      }
      default:
        return;
    }
  }
}

export function toSdkMcpServers(servers: McpServer[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of servers) {
    out[s.name] =
      s.config.transport === 'stdio'
        ? { type: 'stdio', command: s.config.command, args: s.config.args, env: s.config.env }
        : { type: 'http', url: s.config.url, headers: s.config.headers };
  }
  return out;
}

function renderToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string }) =>
        c.type === 'text' ? (c.text ?? '') : `[${c.type ?? 'conteúdo'}]`,
      )
      .join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncado)` : text;
}
