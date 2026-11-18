import type { McpToolResult } from '../../mcp/domain/mcp-server';
import type { OAITool } from '../../protocol/domain/wire-types';
import type { ChatToolSet } from '../domain/conversation';

/** The subset of the MCP toolset the chat loop needs. */
export interface McpToolsetLike {
  tools: { alias: string; description: string; inputSchema: Record<string, unknown> }[];
  call(alias: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>;
}

/** Everything the model can call this turn, with one entry point that routes by tool name. */
export interface Toolbox {
  defs: OAITool[];
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }>;
}

const MAX_DESCRIPTION_CHARS = 1000;

/**
 * Merges MCP tools and the other tool sets (library, document preset) into one toolbox (null when
 * there is nothing to call). Names owned by an extra set go to it (the first one wins), everything
 * else to MCP; unknown names yield an error result. Extra tools are listed before the MCP ones.
 */
export function combineToolsets(
  mcp: McpToolsetLike | null,
  ...sets: (ChatToolSet | null | undefined)[]
): Toolbox | null {
  const extras = sets.filter((set): set is ChatToolSet => !!set);
  const owner = new Map<string, ChatToolSet>();
  const defs: OAITool[] = [];
  for (const set of extras) {
    for (const t of set.tools) {
      if (owner.has(t.name)) continue;
      owner.set(t.name, set);
      defs.push({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description.slice(0, MAX_DESCRIPTION_CHARS),
          parameters: t.parameters,
        },
      });
    }
  }
  for (const t of mcp?.tools ?? []) {
    defs.push({
      type: 'function' as const,
      function: {
        name: t.alias,
        description: t.description.slice(0, MAX_DESCRIPTION_CHARS),
        parameters: t.inputSchema,
      },
    });
  }
  if (defs.length === 0) return null;
  const mcpNames = new Set(mcp?.tools.map((t) => t.alias) ?? []);
  return {
    defs,
    async call(name, args, signal) {
      const set = owner.get(name);
      if (set) return set.call(name, args, signal);
      if (mcp && mcpNames.has(name)) return mcp.call(name, args, signal);
      return { text: `Ferramenta desconhecida: ${name}`, isError: true };
    },
  };
}
