import type {
  ColumnRuleDto,
  DatabaseConnectionDto,
  McpServerDto,
  DatabaseTestResultDto,
  QueryResultDto,
} from '@thinkflow/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpGateway, McpServer } from '../../src/contexts/mcp/domain/mcp-server';
import { aiColumnRules, databaseConnections } from '../../src/shared/infrastructure/db/schema';
import { FakePgGateway } from '../databases/fake-pg-gateway';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp;
let fake: FakePgGateway;

/** Two MCP servers: one is the e-Cidade dictionary (field_search), the other something else. */
class DictionaryMcp implements McpGateway {
  calls: { server: string; tool: string; args: Record<string, unknown> }[] = [];
  async listTools(server: McpServer) {
    const names =
      server.name === 'Mapeamento' ? ['list_projects', 'field_search', 'search'] : ['echo'];
    return names.map((name) => ({
      serverId: server.id,
      serverName: server.name,
      name,
      inputSchema: { type: 'object' },
    }));
  }
  async callTool(server: McpServer, tool: string, args: Record<string, unknown>) {
    this.calls.push({ server: server.name, tool, args });
    if (tool === 'list_projects')
      return {
        text: JSON.stringify({
          projects: [{ slug: 'e-cidade', name: 'e-cidade' }, { slug: 'outro' }],
        }),
        isError: false,
      };
    if (tool === 'field_search')
      return {
        text: JSON.stringify({
          search: {
            hits: [
              { table_id: 'Table:protocolo.cgm', column: 'z01_nome', label: 'Nome/Razão Social' },
            ],
          },
        }),
        isError: false,
      };
    return { text: JSON.stringify({ hits: [] }), isError: false };
  }
  async invalidate() {}
  async closeAll() {}
}

beforeEach(async () => {
  fake = new FakePgGateway();
  t = await createTestApp({ pgGateway: fake });
});
afterEach(async () => t?.close());

const body = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  host: 'db.local',
  port: 5432,
  database: 'ecidade',
  user: 'leitor',
  password: 'segredo-super',
  ...extra,
});

async function create(name = 'e-Cidade', extra: Record<string, unknown> = {}) {
  const res = await t.api<DatabaseConnectionDto>('POST', '/api/databases', body(name, extra));
  expect(res.status).toBe(201);
  return res.json;
}

describe('databases API', () => {
  it('requires authentication', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/databases' });
    expect(res.statusCode).toBe(401);
  });

  it('creates a connection without ever returning the password', async () => {
    const dto = await create();
    expect(dto).toMatchObject({
      name: 'e-Cidade',
      passwordSet: true,
      isDefault: true,
      aiAccess: 'schema',
    });
    expect(JSON.stringify(dto)).not.toContain('segredo-super');

    const list = await t.api<DatabaseConnectionDto[]>('GET', '/api/databases');
    expect(list.json).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain('segredo-super');
    const one = await t.api<DatabaseConnectionDto>('GET', `/api/databases/${dto.id}`);
    expect(one.json.id).toBe(dto.id);
  });

  it('stores the password encrypted at rest', async () => {
    const dto = await create();
    const row = t.db
      .select({ enc: databaseConnections.passwordEnc })
      .from(databaseConnections)
      .where(eq(databaseConnections.id, dto.id))
      .get()!;
    expect(row.enc).toMatch(/^v1:/);
    expect(row.enc).not.toContain('segredo-super');
  });

  it('rejects a duplicated name with 409 and invalid bodies with 400', async () => {
    await create('A');
    const dup = await t.api('POST', '/api/databases', body('A'));
    expect(dup.status).toBe(409);
    const bad = await t.api('POST', '/api/databases', { name: '' });
    expect(bad.status).toBe(400);
    expect((await t.api('GET', '/api/databases/nope')).status).toBe(404);
  });

  it('updates keeping the stored password when it is empty', async () => {
    const dto = await create();
    const res = await t.api<DatabaseConnectionDto>('PUT', `/api/databases/${dto.id}`, {
      host: 'outro.local',
      password: '',
      aiAccess: 'masked',
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ host: 'outro.local', aiAccess: 'masked', passwordSet: true });
    expect(fake.invalidated).toContain(dto.id);

    await t.api('POST', `/api/databases/${dto.id}/test`);
    expect(fake.tested.at(-1)).toMatchObject({ host: 'outro.local', password: 'segredo-super' });
  });

  it('tests the connection and warns when the login can write', async () => {
    const dto = await create();
    const ok = await t.api<DatabaseTestResultDto>('POST', `/api/databases/${dto.id}/test`);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, canWrite: false, currentUser: 'leitor' });

    fake.info = { ...fake.info, canWrite: true };
    const warn = await t.api<DatabaseTestResultDto>('POST', `/api/databases/${dto.id}/test`);
    expect(warn.json).toMatchObject({ ok: true, canWrite: true });
    expect(warn.json.message).toContain('pode alterar dados');

    fake.failTest = 'boom';
    const failed = await t.api<DatabaseTestResultDto>('POST', `/api/databases/${dto.id}/test`);
    expect(failed.status).toBe(200);
    expect(failed.json.ok).toBe(false);
  });

  it('runs the analyst SQL read-only and refuses writes without touching the database', async () => {
    const dto = await create();
    const ok = await t.api<QueryResultDto>('POST', `/api/databases/${dto.id}/query`, {
      sql: 'select * from contribuintes',
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ source: 'direct', error: null, rowCount: 3, purpose: null });
    expect(ok.json.rows[0]).toEqual([1, 'Maria da Silva', '10123456760', '150.00']);
    expect(fake.queries).toHaveLength(1);

    const refused = await t.api<QueryResultDto>('POST', `/api/databases/${dto.id}/query`, {
      sql: 'delete from contribuintes',
    });
    expect(refused.status).toBe(200);
    expect(refused.json.error).toContain('Consulta recusada');
    expect(refused.json.rows).toEqual([]);
    expect(fake.queries).toHaveLength(1);

    const empty = await t.api('POST', `/api/databases/${dto.id}/query`, { sql: '  ' });
    expect(empty.status).toBe(400);
    const missing = await t.api('POST', '/api/databases/nope/query', { sql: 'select 1' });
    expect(missing.status).toBe(404);
  });

  it('validates a SQL on demand (POST /validate) without ever running it', async () => {
    const dto = await create();
    const ok = await t.api('POST', `/api/databases/${dto.id}/validate`, {
      sql: 'select c.z01_nome from public.cgm c limit 1',
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ status: 'ok', issues: [], reason: null });

    const bad = await t.api<{
      status: string;
      issues: { message: string; suggestions: string[] }[];
    }>('POST', `/api/databases/${dto.id}/validate`, {
      sql: 'select c.z01_nomee from public.cgm c',
    });
    expect(bad.json.status).toBe('invalid');
    expect(bad.json.issues[0]?.suggestions).toContain('z01_nome');

    const refused = await t.api<{ status: string }>('POST', `/api/databases/${dto.id}/validate`, {
      sql: 'drop table cgm',
    });
    expect(refused.json.status).toBe('invalid');

    fake.unreachable = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const down = await t.api<{ status: string; reason: string }>(
      'POST',
      `/api/databases/${dto.id}/validate`,
      { sql: 'select 1 from cgm' },
    );
    expect(down.status).toBe(200);
    expect(down.json).toMatchObject({ status: 'unchecked' });
    expect(down.json.reason).toContain('Conexão recusada');

    // nothing was ever executed, whatever the outcome
    expect(fake.queries).toEqual([]);

    expect((await t.api('POST', `/api/databases/${dto.id}/validate`, { sql: '  ' })).status).toBe(
      400,
    );
    expect((await t.api('POST', '/api/databases/nope/validate', { sql: 'select 1' })).status).toBe(
      404,
    );
  });

  it('deletes and promotes another connection to default', async () => {
    const a = await create('A');
    const b = await create('B');
    expect(b.isDefault).toBe(false);
    const del = await t.api('DELETE', `/api/databases/${a.id}`);
    expect(del.status).toBe(200);
    const list = await t.api<DatabaseConnectionDto[]>('GET', '/api/databases');
    expect(list.json.map((c) => [c.name, c.isDefault])).toEqual([['B', true]]);
    expect(fake.invalidated).toContain(a.id);
    expect((await t.api('GET', `/api/databases/${a.id}`)).status).toBe(404);
  });

  describe('AI privacy rules', () => {
    it('requires authentication and an existing connection', async () => {
      const anon = await t.app.inject({ method: 'GET', url: '/api/databases/x/ai-rules' });
      expect(anon.statusCode).toBe(401);
      expect((await t.api('GET', '/api/databases/nope/ai-rules')).status).toBe(404);
      expect(
        (await t.api('PUT', '/api/databases/nope/ai-rules', { column: 'a', action: 'omit' }))
          .status,
      ).toBe(404);
      expect((await t.api('DELETE', '/api/databases/nope/ai-rules/x')).status).toBe(404);
    });

    it('lists, upserts (as the analyst), changes and removes a rule', async () => {
      const dto = await create();
      const url = `/api/databases/${dto.id}/ai-rules`;
      expect((await t.api<ColumnRuleDto[]>('GET', url)).json).toEqual([]);

      const saved = await t.api<ColumnRuleDto>('PUT', url, {
        schema: 'Public',
        table: 'CGM',
        column: 'Z01_Nome',
        action: 'tokenize',
        kind: 'NOME',
      });
      expect(saved.status).toBe(200);
      expect(saved.json).toMatchObject({
        connectionId: dto.id,
        schema: 'public',
        table: 'cgm',
        column: 'z01_nome',
        action: 'tokenize',
        kind: 'NOME',
        origin: 'analyst',
      });

      // same column again: replaced, not duplicated
      const changed = await t.api<ColumnRuleDto>('PUT', url, {
        schema: 'public',
        table: 'cgm',
        column: 'z01_nome',
        action: 'omit',
      });
      expect(changed.json.id).toBe(saved.json.id);
      expect(changed.json).toMatchObject({ action: 'omit', kind: null });

      // schema/table default to the wildcard (any table)
      const wildcard = await t.api<ColumnRuleDto>('PUT', url, {
        column: 'inscricao',
        action: 'reveal',
      });
      expect(wildcard.json).toMatchObject({ schema: '*', table: '*', column: 'inscricao' });

      const list = await t.api<ColumnRuleDto[]>('GET', url);
      expect(list.json.map((r) => r.column).sort()).toEqual(['inscricao', 'z01_nome']);

      expect((await t.api('PUT', url, { column: 'a', action: 'apagar' })).status).toBe(400);
      expect((await t.api('PUT', url, { action: 'omit' })).status).toBe(400);

      const del = await t.api('DELETE', `${url}/${saved.json.id}`);
      expect(del.status).toBe(200);
      expect((await t.api<ColumnRuleDto[]>('GET', url)).json.map((r) => r.column)).toEqual([
        'inscricao',
      ]);
    });

    it('rules of one connection are invisible to another and die with the connection', async () => {
      const a = await create('A');
      const b = await create('B');
      const rule = await t.api<ColumnRuleDto>('PUT', `/api/databases/${a.id}/ai-rules`, {
        column: 'cpf',
        action: 'tokenize',
      });
      expect((await t.api<ColumnRuleDto[]>('GET', `/api/databases/${b.id}/ai-rules`)).json).toEqual(
        [],
      );
      // deleting through the wrong connection removes nothing
      await t.api('DELETE', `/api/databases/${b.id}/ai-rules/${rule.json.id}`);
      expect(
        (await t.api<ColumnRuleDto[]>('GET', `/api/databases/${a.id}/ai-rules`)).json,
      ).toHaveLength(1);

      await t.api('DELETE', `/api/databases/${a.id}`);
      expect(t.db.select().from(aiColumnRules).all()).toEqual([]);
    });

    it('saving the connection never wipes its rules', async () => {
      const dto = await create();
      await t.api('PUT', `/api/databases/${dto.id}/ai-rules`, { column: 'cpf', action: 'omit' });
      const upd = await t.api('PUT', `/api/databases/${dto.id}`, {
        name: 'Renomeada',
        sampleRows: 5,
      });
      expect(upd.status).toBe(200);
      expect(
        (await t.api<ColumnRuleDto[]>('GET', `/api/databases/${dto.id}/ai-rules`)).json,
      ).toHaveLength(1);
    });
  });

  describe('data dictionary (MCP) per connection', () => {
    let mcp: DictionaryMcp;
    beforeEach(async () => {
      await t.close();
      mcp = new DictionaryMcp();
      t = await createTestApp({ pgGateway: fake, mcpGateway: mcp });
    });

    const addServer = (name: string, enabled = true) =>
      t.api<McpServerDto>('POST', '/api/mcp', {
        transport: 'http',
        name,
        url: 'http://127.0.0.1:8765/mcp',
        enabled,
      });

    it('lists only enabled MCP servers that expose field_search, and their projects', async () => {
      const dictionary = (await addServer('Mapeamento')).json;
      await addServer('Eco');
      await addServer('Mapeamento 2', false);
      const servers = await t.api<{ id: string; name: string }[]>(
        'GET',
        '/api/databases/metadata-mcp/servers',
      );
      expect(servers.json).toEqual([{ id: dictionary.id, name: 'Mapeamento' }]);

      const projects = await t.api<string[]>(
        'GET',
        `/api/databases/metadata-mcp/servers/${dictionary.id}/projects`,
      );
      expect(projects.json).toEqual(['e-cidade', 'outro']);
      expect(
        (await t.api<string[]>('GET', '/api/databases/metadata-mcp/servers/nope/projects')).json,
      ).toEqual([]);
      const anon = await t.app.inject({
        method: 'GET',
        url: '/api/databases/metadata-mcp/servers',
      });
      expect(anon.statusCode).toBe(401);
    });

    it('saves, returns and clears the dictionary config without touching the AI rules', async () => {
      const server = (await addServer('Mapeamento')).json;
      const dto = await create();
      expect(dto).toMatchObject({ metadataMcpServerId: null, metadataMcpProject: null });
      await t.api('PUT', `/api/databases/${dto.id}/ai-rules`, { column: 'cpf', action: 'omit' });

      const set = await t.api<DatabaseConnectionDto>('PUT', `/api/databases/${dto.id}`, {
        metadataMcpServerId: server.id,
        metadataMcpProject: 'e-cidade',
      });
      expect(set.json).toMatchObject({
        metadataMcpServerId: server.id,
        metadataMcpProject: 'e-cidade',
      });
      // an unrelated edit keeps it
      const renamed = await t.api<DatabaseConnectionDto>('PUT', `/api/databases/${dto.id}`, {
        name: 'Outra',
      });
      expect(renamed.json.metadataMcpServerId).toBe(server.id);
      const cleared = await t.api<DatabaseConnectionDto>('PUT', `/api/databases/${dto.id}`, {
        metadataMcpServerId: null,
        metadataMcpProject: null,
      });
      expect(cleared.json).toMatchObject({ metadataMcpServerId: null, metadataMcpProject: null });
      expect(
        (await t.api<ColumnRuleDto[]>('GET', `/api/databases/${dto.id}/ai-rules`)).json,
      ).toHaveLength(1);
    });

    it('"Executar SQL" validates names and consults the configured dictionary with identifier words only', async () => {
      const server = (await addServer('Mapeamento')).json;
      const dto = await create('e-Cidade', {
        metadataMcpServerId: server.id,
        metadataMcpProject: 'e-cidade',
      });
      const res = await t.api<QueryResultDto>('POST', `/api/databases/${dto.id}/query`, {
        sql: "select c.valor_terreno from cgm c where c.z01_nome = 'Maria da Silva'",
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ validation: true, source: 'direct', rowCount: 0 });
      expect(res.json.error).toContain('"valor_terreno" não existe em public.cgm');
      expect(res.json.error).toContain(
        'No dicionário de dados (MCP): cgm.z01_nome (Nome/Razão Social).',
      );
      expect(fake.queries).toHaveLength(0);
      expect(mcp.calls).toEqual([
        {
          server: 'Mapeamento',
          tool: 'field_search',
          args: { project: 'e-cidade', term: 'valor terreno', limit: 6 },
        },
      ]);
      expect(JSON.stringify(mcp.calls)).not.toContain('Maria');
    });
  });
});
