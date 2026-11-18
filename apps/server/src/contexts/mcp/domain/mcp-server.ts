export type McpServerConfig =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { transport: 'http'; url: string; headers: Record<string, string> };

export interface McpServer {
  id: string;
  name: string;
  enabled: boolean;
  config: McpServerConfig;
  createdAt: number;
}

export interface McpTool {
  serverId: string;
  serverName: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

export interface McpServerRepository {
  list(): Promise<McpServer[]>;
  findById(id: string): Promise<McpServer | null>;
  findByName(name: string): Promise<McpServer | null>;
  save(server: McpServer): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Port: talks MCP to external servers. */
export interface McpGateway {
  listTools(server: McpServer): Promise<McpTool[]>;
  callTool(
    server: McpServer,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult>;
  invalidate(serverId: string): Promise<void>;
  closeAll(): Promise<void>;
}

/** Tool names exposed to LLMs must match ^[a-zA-Z0-9_-]{1,64}$. Mirrors Claude Code's `mcp__server__tool`. */
export function toolAlias(serverName: string, toolName: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${clean(serverName)}__${clean(toolName)}`.slice(0, 64);
}
