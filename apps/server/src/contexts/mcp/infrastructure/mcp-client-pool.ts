import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpGateway, McpServer, McpTool, McpToolResult } from '../domain/mcp-server';

interface PoolEntry {
  client: Client;
  tools: McpTool[] | null;
  fingerprint: string;
}

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

/** Keeps one live MCP client per server, reconnecting when its config changes. */
export class McpClientPool implements McpGateway {
  private readonly entries = new Map<string, Promise<PoolEntry>>();

  async listTools(server: McpServer): Promise<McpTool[]> {
    const entry = await this.entry(server);
    if (entry.tools) return entry.tools;
    try {
      const result = await entry.client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      entry.tools = result.tools.map((t) => ({
        serverId: server.id,
        serverName: server.name,
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
          type: 'object',
          properties: {},
        },
      }));
      return entry.tools;
    } catch (err) {
      await this.invalidate(server.id);
      throw err;
    }
  }

  async callTool(
    server: McpServer,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const entry = await this.entry(server);
    const result = await entry.client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return {
      text: renderToolContent(result),
      isError: Boolean((result as { isError?: boolean }).isError),
    };
  }

  async invalidate(serverId: string): Promise<void> {
    const pending = this.entries.get(serverId);
    this.entries.delete(serverId);
    if (!pending) return;
    try {
      const entry = await pending;
      await entry.client.close();
    } catch {
      // already closed / never connected
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.invalidate(id)));
  }

  private async entry(server: McpServer): Promise<PoolEntry> {
    const fingerprint = JSON.stringify(server.config);
    const existing = this.entries.get(server.id);
    if (existing) {
      const entry = await existing.catch(() => null);
      if (entry && entry.fingerprint === fingerprint) return entry;
      await this.invalidate(server.id);
    }
    const created = this.connect(server, fingerprint);
    this.entries.set(server.id, created);
    created.catch(() => this.entries.delete(server.id));
    return created;
  }

  private async connect(server: McpServer, fingerprint: string): Promise<PoolEntry> {
    const config = server.config;
    const client = new Client({ name: 'thinkflow', version: '0.1.0' });
    client.onclose = () => {
      this.entries.delete(server.id);
    };

    if (config.transport === 'stdio') {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...getDefaultEnvironment(), ...config.env },
        stderr: 'pipe',
      });
      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `Timeout ao iniciar "${config.command}"`,
      );
      return { client, tools: null, fingerprint };
    }

    const url = new URL(config.url);
    const requestInit = { headers: config.headers };
    try {
      await withTimeout(
        client.connect(new StreamableHTTPClientTransport(url, { requestInit })),
        CONNECT_TIMEOUT_MS,
        'Timeout ao conectar (streamable HTTP)',
      );
    } catch {
      // Older servers only speak the legacy SSE transport.
      const legacy = new Client({ name: 'thinkflow', version: '0.1.0' });
      legacy.onclose = client.onclose;
      await withTimeout(
        legacy.connect(new SSEClientTransport(url, { requestInit })),
        CONNECT_TIMEOUT_MS,
        'Timeout ao conectar (SSE)',
      );
      return { client: legacy, tools: null, fingerprint };
    }
    return { client, tools: null, fingerprint };
  }
}

function renderToolContent(result: unknown): string {
  const r = result as { content?: unknown[]; structuredContent?: unknown; toolResult?: unknown };
  if (Array.isArray(r.content)) {
    const parts = r.content.map((c) => {
      const item = c as {
        type: string;
        text?: string;
        mimeType?: string;
        resource?: { uri?: string; text?: string };
      };
      if (item.type === 'text') return item.text ?? '';
      if (item.type === 'resource')
        return item.resource?.text ?? `[recurso ${item.resource?.uri ?? ''}]`;
      if (item.type === 'resource_link') return `[link ${(c as { uri?: string }).uri ?? ''}]`;
      return `[${item.type}${item.mimeType ? ` ${item.mimeType}` : ''}]`;
    });
    const text = parts.filter(Boolean).join('\n');
    if (text) return text;
  }
  if (r.structuredContent !== undefined) return JSON.stringify(r.structuredContent);
  if (r.toolResult !== undefined) return JSON.stringify(r.toolResult);
  return '';
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
