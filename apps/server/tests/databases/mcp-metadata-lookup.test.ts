import { describe, expect, it } from 'vitest';
import {
  identifierWords,
  McpMetadataLookup,
  parseFieldMatches,
  parseProjects,
  parseTableMatches,
} from '../../src/contexts/databases/infrastructure/mcp-metadata-lookup';
import type {
  McpGateway,
  McpServer,
  McpServerRepository,
  McpTool,
} from '../../src/contexts/mcp/domain/mcp-server';

/* Shapes below were captured from the real "Mapeamento" MCP server (ecidade-map), trimmed. */
const PROJECTS = JSON.stringify({
  projects: [{ slug: 'e-cidade', name: 'e-cidade', profile: 'ecidade', nodes: 167278 }],
});

const FIELD_SEARCH = JSON.stringify({
  project: 'e-cidade',
  markdown:
    '# Busca de campo: nome contribuinte\n\n## Usadas em cálculo\n\n1. `protocolo.cgm.z01_nome` — Nome/Razão Social (placar 0.76)\n   - tabela: Cadastro Geral de Contribuinte\n\n## Sem cadastro conhecido\n\n4. `issqn.issplan.q20_nomecontri` — Nome do contribuinte (placar 1.00)\n',
  search: {
    term: 'nome contribuinte',
    hits: [
      {
        table_id: 'Table:issqn.issplan',
        column: 'q20_nomecontri',
        label: 'Nome do contribuinte',
        table_label: 'Planilha de retenção na fonte',
        score: 1.0,
      },
      {
        table_id: 'Table:protocolo.cgm',
        column: 'z01_nome',
        label: 'Nome/Razão Social',
        table_label: 'Cadastro Geral de Contribuinte',
        score: 0.757,
      },
    ],
  },
});

const TABLE_SEARCH = JSON.stringify({
  query: 'cadastro geral contribuinte',
  total: 2,
  hits: [
    {
      node_id: 'Table:protocolo.db_cgmcpf',
      label: 'Table',
      name: 'protocolo.db_cgmcpf',
      field: 'catalog',
      snippet: '[cadastro] do CPF do cgm\nProtocolo',
      score: 17.85,
    },
    {
      node_id: 'Table:caixa.cgmnatureza',
      label: 'Table',
      name: 'caixa.cgmnatureza',
      field: 'name',
      snippet: '[cgmnatureza] c05',
      score: 6.64,
    },
  ],
});

describe('parsers of the dictionary output', () => {
  it('field_search: reads search.hits[] with table, column and labels', () => {
    expect(parseFieldMatches(FIELD_SEARCH)).toEqual([
      {
        schema: 'issqn',
        table: 'issplan',
        column: 'q20_nomecontri',
        label: 'Nome do contribuinte',
        tableLabel: 'Planilha de retenção na fonte',
      },
      {
        schema: 'protocolo',
        table: 'cgm',
        column: 'z01_nome',
        label: 'Nome/Razão Social',
        tableLabel: 'Cadastro Geral de Contribuinte',
      },
    ]);
  });

  it('field_search: falls back to the Markdown lines when the JSON has no hits[] or is not JSON', () => {
    const markdown =
      '1. `protocolo.cgm.z01_nome` — Nome/Razão Social (placar 0.76)\n2. `cadastro.facevalor.j81_valorterreno` — Valor m2 terreno (placar 1.10)\ntexto solto\n';
    const expected = [
      { schema: 'protocolo', table: 'cgm', column: 'z01_nome', label: 'Nome/Razão Social' },
      {
        schema: 'cadastro',
        table: 'facevalor',
        column: 'j81_valorterreno',
        label: 'Valor m2 terreno',
      },
    ];
    expect(parseFieldMatches(markdown)).toMatchObject(expected);
    expect(parseFieldMatches(JSON.stringify({ markdown }))).toMatchObject(expected);
    expect(parseFieldMatches('Aviso: nada encontrado')).toEqual([]);
    expect(parseFieldMatches(JSON.stringify({ search: { hits: [] } }))).toEqual([]);
  });

  it('search: keeps the description only when it came from the dictionary catalog', () => {
    expect(parseTableMatches(TABLE_SEARCH)).toEqual([
      { schema: 'protocolo', table: 'db_cgmcpf', description: 'cadastro do CPF do cgm' },
      { schema: 'caixa', table: 'cgmnatureza', description: null },
    ]);
    expect(parseTableMatches('achei Table:protocolo.cgm e Table:caixa.x')).toMatchObject([
      { schema: 'protocolo', table: 'cgm' },
      { schema: 'caixa', table: 'x' },
    ]);
    expect(parseTableMatches(JSON.stringify({ total: 0, hits: [] }))).toEqual([]);
  });

  it('search ignores hits that are not tables', () => {
    const raw = JSON.stringify({
      hits: [{ node_id: 'Route:GET /v4/api/x', label: 'Route', name: 'GET /v4/api/x' }],
    });
    expect(parseTableMatches(raw)).toEqual([]);
  });

  it('list_projects: JSON object, JSON array or plain lines', () => {
    expect(parseProjects(PROJECTS)).toEqual(['e-cidade']);
    expect(parseProjects(JSON.stringify(['a', { name: 'b' }]))).toEqual(['a', 'b']);
    expect(parseProjects('- e-cidade\n- outro\n')).toEqual(['e-cidade', 'outro']);
  });

  it('only identifier words travel to the dictionary', () => {
    expect(identifierWords('z01_nomee')).toBe('z01 nomee');
    expect(identifierWords('nome do "contribuinte"; drop')).toBe('nome do contribuinte drop');
    expect(identifierWords('x'.repeat(200))).toHaveLength(80);
  });
});

describe('McpMetadataLookup', () => {
  const server: McpServer = {
    id: 'mcp-1',
    name: 'Mapeamento',
    enabled: true,
    config: { transport: 'http', url: 'http://127.0.0.1:8765/mcp', headers: {} },
    createdAt: 0,
  };
  const off: McpServer = { ...server, id: 'mcp-2', name: 'Desligado', enabled: false };
  const other: McpServer = { ...server, id: 'mcp-3', name: 'Outro' };

  class Servers implements McpServerRepository {
    async list() {
      return [server, off, other];
    }
    async findById(id: string) {
      return [server, off, other].find((s) => s.id === id) ?? null;
    }
    async findByName() {
      return null;
    }
    async save() {}
    async delete() {}
  }

  class Gateway implements McpGateway {
    calls: { tool: string; args: Record<string, unknown> }[] = [];
    reply: (tool: string) => { text: string; isError: boolean } = (tool) => ({
      text:
        tool === 'field_search' ? FIELD_SEARCH : tool === 'list_projects' ? PROJECTS : TABLE_SEARCH,
      isError: false,
    });
    hang = false;
    async listTools(s: McpServer): Promise<McpTool[]> {
      const names = s.id === 'mcp-3' ? ['outra'] : ['list_projects', 'field_search', 'search'];
      return names.map((name) => ({
        serverId: s.id,
        serverName: s.name,
        name,
        inputSchema: {},
      }));
    }
    async callTool(_s: McpServer, tool: string, args: Record<string, unknown>) {
      this.calls.push({ tool, args });
      if (this.hang) return new Promise<never>(() => undefined);
      return this.reply(tool);
    }
    async invalidate() {}
    async closeAll() {}
  }

  const target = { serverId: 'mcp-1', project: 'e-cidade' };

  it('calls field_search / search / list_projects with the documented arguments', async () => {
    const gateway = new Gateway();
    const lookup = new McpMetadataLookup({ servers: new Servers(), gateway });
    expect(await lookup.findFields(target, 'z01_nomee', { limit: 5 })).toHaveLength(2);
    expect(await lookup.findTables(target, 'cadastro_geral', { limit: 5 })).toHaveLength(2);
    expect(await lookup.listProjects('mcp-1')).toEqual(['e-cidade']);
    expect(gateway.calls).toEqual([
      { tool: 'field_search', args: { project: 'e-cidade', term: 'z01 nomee', limit: 5 } },
      {
        tool: 'search',
        args: { query: 'cadastro geral', project: 'e-cidade', label: 'Table', limit: 5 },
      },
      { tool: 'list_projects', args: {} },
    ]);
  });

  it('degrades to an empty answer: tool error, unknown or disabled server, timeout', async () => {
    const gateway = new Gateway();
    const lookup = new McpMetadataLookup({ servers: new Servers(), gateway, timeoutMs: 30 });
    gateway.reply = () => ({ text: 'Error executing tool field_search', isError: true });
    expect(await lookup.findFields(target, 'abc', { limit: 5 })).toEqual([]);
    gateway.reply = () => ({ text: FIELD_SEARCH, isError: false });
    expect(await lookup.findFields({ ...target, serverId: 'nope' }, 'abc', { limit: 5 })).toEqual(
      [],
    );
    expect(await lookup.findFields({ ...target, serverId: 'mcp-2' }, 'abc', { limit: 5 })).toEqual(
      [],
    );
    expect(await lookup.findFields(target, '   ', { limit: 5 })).toEqual([]);
    gateway.hang = true;
    expect(await lookup.findTables(target, 'abc', { limit: 5 })).toEqual([]);
  });

  it('lists only enabled servers that expose field_search', async () => {
    const lookup = new McpMetadataLookup({ servers: new Servers(), gateway: new Gateway() });
    expect(await lookup.listServers()).toEqual([{ id: 'mcp-1', name: 'Mapeamento' }]);
  });
});
