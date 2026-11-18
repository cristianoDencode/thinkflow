import type { ChatToolSet } from '../../chat/domain/conversation';
import { combineToolsets } from '../../chat/application/toolbox';
import type { LibraryService } from '../../library/application/library-service';
import type { McpService } from '../../mcp/application/mcp-service';
import type { CtAssistantTools, CtAssistantToolsPort } from '../application/ct-assistant';

/** Library calls over one request (each library also enforces its own limits). */
const LIBRARY_MAX_CALLS = 4;
const LIBRARY_MAX_TOTAL_CHARS = 18_000;

/**
 * Opens the sources of one assistant request: the chosen libraries (retrieval tool, one per
 * library) and the chosen MCP servers (their tools, e.g. the e-Cidade data dictionary). Unknown,
 * disabled or unreachable sources become warnings instead of failing the request.
 */
export class CtAssistantToolsAdapter implements CtAssistantToolsPort {
  constructor(
    private readonly deps: { library: Pick<LibraryService, 'chatTools'>; mcp: McpService },
  ) {}

  async open(options: {
    libraryIds: string[];
    mcpServerIds: string[];
    maxOutputChars: number;
  }): Promise<CtAssistantTools> {
    const warnings: string[] = [];

    const sets: ChatToolSet[] = [];
    const notes: string[] = [];
    for (const [i, id] of options.libraryIds.entries()) {
      const tools = await this.deps.library.chatTools(id, {
        maxOutputChars: options.maxOutputChars,
        maxCalls: LIBRARY_MAX_CALLS,
        maxTotalChars: LIBRARY_MAX_TOTAL_CHARS,
        remoteMaxCalls: 2,
      });
      if (!tools) {
        warnings.push('Uma biblioteca escolhida não existe mais e foi ignorada.');
        continue;
      }
      // every library exposes the same tool name: later ones get a suffix so none is shadowed
      const rename = (name: string) => (i === 0 ? name : `${name}_${i + 1}`);
      const original = new Map(tools.tools.map((t) => [rename(t.name), t.name]));
      sets.push({
        tools: tools.tools.map((t) => ({ ...t, name: rename(t.name) })),
        call: (name, args, signal) => tools.call(original.get(name) ?? name, args, signal),
      });
      const toolName = tools.tools[0]?.name;
      notes.push(
        toolName && i > 0
          ? tools.systemNote.split(toolName).join(rename(toolName))
          : tools.systemNote,
      );
    }

    let mcpToolset = null;
    if (options.mcpServerIds.length > 0) {
      const known = await this.deps.mcp.list();
      const chosen = options.mcpServerIds.map((id) => known.find((s) => s.id === id));
      if (chosen.some((s) => !s))
        warnings.push('Um servidor MCP escolhido não existe mais e foi ignorado.');
      const usable = chosen.filter((s): s is NonNullable<typeof s> => !!s && s.enabled);
      for (const s of chosen)
        if (s && !s.enabled)
          warnings.push(`O servidor MCP "${s.name}" está desativado e foi ignorado.`);
      if (usable.length > 0) {
        const toolset = await this.deps.mcp.enabledToolset({ servers: usable.map((s) => s.name) });
        for (const e of toolset.errors)
          warnings.push(`Não consegui usar o servidor MCP "${e.server}": ${e.message}`);
        if (toolset.tools.length > 0) mcpToolset = toolset;
      }
    }

    const toolbox = combineToolsets(mcpToolset, ...sets);
    return {
      toolbox,
      systemNote: toolbox ? notes.join('\n') : '',
      warnings,
    };
  }
}
