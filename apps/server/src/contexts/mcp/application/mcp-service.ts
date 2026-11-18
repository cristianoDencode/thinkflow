import { mcpServerInputSchema, type McpServerDto, type McpTestResultDto } from '@thinkflow/shared';
import type { Clock } from '../../../shared/kernel/clock';
import type { IdGenerator } from '../../../shared/kernel/ids';
import { ConflictError, NotFoundError } from '../../../shared/kernel/errors';
import {
  toolAlias,
  type McpGateway,
  type McpServer,
  type McpServerConfig,
  type McpServerRepository,
  type McpTool,
  type McpToolResult,
} from '../domain/mcp-server';

export interface ExposedTool {
  alias: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: McpServer;
  tool: McpTool;
}

export interface Toolset {
  tools: ExposedTool[];
  errors: { server: string; message: string }[];
  call(alias: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>;
}

export class McpService {
  constructor(
    private readonly deps: {
      servers: McpServerRepository;
      gateway: McpGateway;
      clock: Clock;
      ids: IdGenerator;
    },
  ) {}

  async list(): Promise<McpServerDto[]> {
    return (await this.deps.servers.list()).map(toDto);
  }

  async create(input: unknown): Promise<McpServerDto> {
    const data = mcpServerInputSchema.parse(input);
    if (await this.deps.servers.findByName(data.name))
      throw new ConflictError(`Já existe um servidor "${data.name}"`);
    const server: McpServer = {
      id: this.deps.ids.next(),
      name: data.name,
      enabled: data.enabled,
      config: toConfig(data),
      createdAt: this.deps.clock.now(),
    };
    await this.deps.servers.save(server);
    return toDto(server);
  }

  async update(id: string, input: unknown): Promise<McpServerDto> {
    const server = await this.get(id);
    const raw = input as Record<string, unknown>;
    const data = mcpServerInputSchema.parse(input);
    const sameName = await this.deps.servers.findByName(data.name);
    if (sameName && sameName.id !== id)
      throw new ConflictError(`Já existe um servidor "${data.name}"`);
    const config = toConfig(data);
    // Secrets are write-only: keep previous env/header values when the client omitted them.
    if (
      config.transport === 'stdio' &&
      server.config.transport === 'stdio' &&
      raw.env === undefined
    ) {
      config.env = server.config.env;
    }
    if (
      config.transport === 'http' &&
      server.config.transport === 'http' &&
      raw.headers === undefined
    ) {
      config.headers = server.config.headers;
    }
    const updated: McpServer = { ...server, name: data.name, enabled: data.enabled, config };
    await this.deps.servers.save(updated);
    await this.deps.gateway.invalidate(id);
    return toDto(updated);
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerDto> {
    const server = await this.get(id);
    const updated = { ...server, enabled };
    await this.deps.servers.save(updated);
    if (!enabled) await this.deps.gateway.invalidate(id);
    return toDto(updated);
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.deps.gateway.invalidate(id);
    await this.deps.servers.delete(id);
  }

  async test(id: string): Promise<McpTestResultDto> {
    const server = await this.get(id);
    try {
      await this.deps.gateway.invalidate(id);
      const tools = await this.deps.gateway.listTools(server);
      return {
        ok: true,
        message: `Conectado — ${tools.length} ferramenta(s)`,
        tools: tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
        })),
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), tools: [] };
    }
  }

  /**
   * Tools of the enabled servers, flattened under collision-free aliases. `filter.servers` limits
   * them to those names; an empty (or missing) list means every enabled server.
   */
  async enabledToolset(filter: { servers?: string[] } = {}): Promise<Toolset> {
    const only = new Set((filter.servers ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean));
    const servers = (await this.deps.servers.list()).filter(
      (s) => s.enabled && (only.size === 0 || only.has(s.name.trim().toLowerCase())),
    );
    const tools: ExposedTool[] = [];
    const errors: Toolset['errors'] = [];
    await Promise.all(
      servers.map(async (server) => {
        try {
          for (const tool of await this.deps.gateway.listTools(server)) {
            tools.push({
              alias: toolAlias(server.name, tool.name),
              description: tool.description ?? `${tool.name} (${server.name})`,
              inputSchema: tool.inputSchema,
              server,
              tool,
            });
          }
        } catch (err) {
          errors.push({
            server: server.name,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    const byAlias = new Map(tools.map((t) => [t.alias, t]));
    return {
      tools,
      errors,
      call: async (alias, args, signal) => {
        const exposed = byAlias.get(alias);
        if (!exposed) return { text: `Ferramenta desconhecida: ${alias}`, isError: true };
        try {
          return await this.deps.gateway.callTool(exposed.server, exposed.tool.name, args, signal);
        } catch (err) {
          return { text: err instanceof Error ? err.message : String(err), isError: true };
        }
      },
    };
  }

  /** Enabled servers with full config (used to hand them to the Claude Agent SDK). */
  async enabledServers(): Promise<McpServer[]> {
    return (await this.deps.servers.list()).filter((s) => s.enabled);
  }

  private async get(id: string): Promise<McpServer> {
    const server = await this.deps.servers.findById(id);
    if (!server) throw new NotFoundError('Servidor MCP');
    return server;
  }
}

function toConfig(data: ReturnType<typeof mcpServerInputSchema.parse>): McpServerConfig {
  return data.transport === 'stdio'
    ? { transport: 'stdio', command: data.command, args: data.args, env: data.env }
    : { transport: 'http', url: data.url, headers: data.headers };
}

function toDto(server: McpServer): McpServerDto {
  const base = {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    createdAt: server.createdAt,
  };
  return server.config.transport === 'stdio'
    ? {
        ...base,
        transport: 'stdio',
        command: server.config.command,
        args: server.config.args,
        envKeys: Object.keys(server.config.env),
      }
    : {
        ...base,
        transport: 'http',
        url: server.config.url,
        headerKeys: Object.keys(server.config.headers),
      };
}
