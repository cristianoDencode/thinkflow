import type {
  McpGateway,
  McpServer,
  McpServerRepository,
  McpToolResult,
} from '../../mcp/domain/mcp-server';
import type {
  MetadataFieldMatch,
  MetadataLookup,
  MetadataTableMatch,
  MetadataTarget,
} from '../domain/ports';

const DEFAULT_TIMEOUT_MS = 5000;
const FIELD_TOOL = 'field_search';
const MAX_TERM_CHARS = 80;

export interface McpMetadataLookupOptions {
  servers: McpServerRepository;
  gateway: McpGateway;
  timeoutMs?: number;
}

/**
 * `MetadataLookup` over an MCP server that exposes a data dictionary (e-Cidade's "Mapeamento":
 * `list_projects`, `field_search`, `search`). The tools answer with text — usually a JSON document
 * (`search.hits[]`), with a Markdown rendering next to it — so the parsing is defensive: JSON when
 * it parses, otherwise the Markdown/plain lines; anything unrecognized becomes "no match".
 * Only identifier words travel to the server, never data values; failures and timeouts yield an
 * empty answer (the caller then relies on the catalog alone).
 */
export class McpMetadataLookup implements MetadataLookup {
  private readonly timeoutMs: number;

  constructor(private readonly deps: McpMetadataLookupOptions) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async findFields(
    target: MetadataTarget,
    term: string,
    opts: { limit: number; signal?: AbortSignal },
  ): Promise<MetadataFieldMatch[]> {
    const words = identifierWords(term);
    if (!words) return [];
    const result = await this.call(
      target.serverId,
      FIELD_TOOL,
      { project: target.project, term: words, limit: opts.limit },
      opts.signal,
    );
    return result ? parseFieldMatches(result.text).slice(0, opts.limit) : [];
  }

  async findTables(
    target: MetadataTarget,
    term: string,
    opts: { limit: number; signal?: AbortSignal },
  ): Promise<MetadataTableMatch[]> {
    const words = identifierWords(term);
    if (!words) return [];
    const search = async (anyTerm: boolean) => {
      const result = await this.call(
        target.serverId,
        'search',
        {
          query: words,
          project: target.project,
          label: 'Table',
          limit: opts.limit,
          ...(anyTerm ? { any_term: true } : {}),
        },
        opts.signal,
      );
      return result ? parseTableMatches(result.text).slice(0, opts.limit) : [];
    };
    // every word first; when nothing matches, any of them (the dictionary is fuzzy by design)
    const strict = await search(false);
    return strict.length > 0 ? strict : search(true);
  }

  async listProjects(serverId: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.call(serverId, 'list_projects', {}, signal);
    return result ? parseProjects(result.text) : [];
  }

  async listServers(signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
    const enabled = (await this.deps.servers.list()).filter((s) => s.enabled);
    const found = await Promise.all(
      enabled.map(async (server) => {
        try {
          const tools = await withTimeout(
            this.deps.gateway.listTools(server),
            this.timeoutMs,
            signal,
          );
          return tools.some((t) => t.name === FIELD_TOOL)
            ? { id: server.id, name: server.name }
            : null;
        } catch {
          return null;
        }
      }),
    );
    return found.filter((s): s is { id: string; name: string } => s !== null);
  }

  private async call(
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult | null> {
    try {
      const server: McpServer | null = await this.deps.servers.findById(serverId);
      if (!server || !server.enabled) return null;
      const result = await withTimeout(
        this.deps.gateway.callTool(server, tool, args, signal),
        this.timeoutMs,
        signal,
      );
      return result.isError ? null : result;
    } catch {
      return null;
    }
  }
}

/** Letters/digits of an identifier as words (`z01_nomee` → `z01 nomee`): no punctuation, no values. */
export function identifierWords(identifier: string): string {
  return identifier
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, MAX_TERM_CHARS);
}

function withTimeout<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    const onAbort = () => reject(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
  });
}

/* ------------------------------ parsing ------------------------------ */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** `Table:protocolo.cgm` / `protocolo.cgm` / `cgm` → schema + table. */
function splitTableId(id: string): { schema: string | null; table: string } | null {
  const bare = id.replace(/^Table:/i, '').trim();
  if (!bare || /\s/.test(bare)) return null;
  const parts = bare.split('.');
  const table = parts[parts.length - 1]!;
  if (!table) return null;
  return { schema: parts.length >= 2 ? parts[parts.length - 2]! : null, table };
}

/** `field_search`: `search.hits[]` (table_id, column, label, table_label), or the Markdown list. */
export function parseFieldMatches(raw: string): MetadataFieldMatch[] {
  const json = parseJson(raw);
  if (isObject(json)) {
    const hits = isObject(json.search) && Array.isArray(json.search.hits) ? json.search.hits : null;
    if (hits) {
      const out: MetadataFieldMatch[] = [];
      for (const h of hits) {
        if (!isObject(h)) continue;
        const id = text(h.table_id);
        const column = text(h.column);
        const table = id ? splitTableId(id) : null;
        if (!table || !column) continue;
        out.push({
          schema: table.schema,
          table: table.table,
          column,
          label: text(h.label),
          tableLabel: text(h.table_label),
        });
      }
      return out;
    }
    return parseFieldMarkdown(text(json.markdown) ?? '');
  }
  return parseFieldMarkdown(raw);
}

/** Lines like ``1. `protocolo.cgm.z01_nome` — Nome/Razão Social (placar 0.76)``. */
function parseFieldMarkdown(markdown: string): MetadataFieldMatch[] {
  const out: MetadataFieldMatch[] = [];
  const line = /^\s*(?:\d+\.|[-*])\s+`([^`\s]+)`(?:\s+[—–-]\s+(.*?))?(?:\s+\(placar[^)]*\))?\s*$/gm;
  for (const m of markdown.matchAll(line)) {
    const parts = m[1]!.split('.');
    if (parts.length < 2) continue;
    out.push({
      schema: parts.length >= 3 ? parts[parts.length - 3]! : null,
      table: parts[parts.length - 2]!,
      column: parts[parts.length - 1]!,
      label: text(m[2]),
      tableLabel: null,
    });
  }
  return out;
}

/** `search` (label Table): `hits[]` with `node_id: "Table:schema.table"` and a catalog snippet. */
export function parseTableMatches(raw: string): MetadataTableMatch[] {
  const json = parseJson(raw);
  const out: MetadataTableMatch[] = [];
  if (isObject(json) && Array.isArray(json.hits)) {
    for (const h of json.hits) {
      if (!isObject(h)) continue;
      const id = text(h.node_id) ?? text(h.name);
      if (!id || (text(h.label) && text(h.label)!.toLowerCase() !== 'table')) continue;
      const table = splitTableId(id);
      if (!table) continue;
      // the snippet describes the table only when it came from the dictionary's catalog text
      const snippet = text(h.snippet);
      const description =
        text(h.field) === 'catalog' && snippet
          ? text(snippet.split('\n')[0]!.replace(/[[\]]/g, '').replace(/^…+/, ''))
          : null;
      out.push({ schema: table.schema, table: table.table, description });
    }
    return out;
  }
  for (const m of raw.matchAll(/Table:([A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)?)/g)) {
    const table = splitTableId(m[1]!);
    if (table) out.push({ schema: table.schema, table: table.table, description: null });
  }
  return out;
}

/** `list_projects`: `{ projects: [{ slug, name }] }`, a JSON array, or one name per line. */
export function parseProjects(raw: string): string[] {
  const json = parseJson(raw);
  const list = isObject(json) ? json.projects : json;
  if (Array.isArray(list)) {
    const names = list
      .map((p) =>
        typeof p === 'string' ? p.trim() : isObject(p) ? (text(p.slug) ?? text(p.name)) : null,
      )
      .filter((p): p is string => !!p);
    return [...new Set(names)];
  }
  const lines = raw
    .split('\n')
    .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, '').trim())
    .filter((l) => l !== '' && !/\s/.test(l));
  return [...new Set(lines)];
}
