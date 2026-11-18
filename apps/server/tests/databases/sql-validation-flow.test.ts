import type { DatabaseConnectionInput, QueryResultDto } from '@thinkflow/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/contexts/databases/application/database-service';
import {
  DATA_TOOL_MAX_QUERIES_PER_TURN,
  DATA_TOOL_MAX_VALIDATIONS_PER_TURN,
} from '../../src/contexts/databases/application/data-toolset';
import { InMemoryVault } from '../../src/contexts/privacy/domain/vault';
import { FakeClock } from '../../src/shared/kernel/clock';
import { FakeMetadataLookup } from './fake-metadata-lookup';
import { FakePgGateway } from './fake-pg-gateway';
import { MemoryColumnRuleRepository } from './memory-rules';
import { MemoryDatabaseRepository } from './memory-repo';

let fake: FakePgGateway;
let dictionary: FakeMetadataLookup;
let service: DatabaseService;
let n = 0;

const input: DatabaseConnectionInput = {
  name: 'e-Cidade',
  host: 'db.local',
  database: 'ecidade',
  user: 'leitor',
  password: 'segredo',
};

async function setup(extra: Partial<DatabaseConnectionInput> = {}) {
  const created = await service.create({ ...input, ...extra });
  const results: QueryResultDto[] = [];
  const vault = new InMemoryVault();
  const tools = await service.chatTools(created.id, {
    maxOutputChars: 6000,
    onResult: (r) => results.push(r),
    vault,
  });
  if (!tools) throw new Error('tools expected');
  return { created, results, tools, vault };
}

const withDictionary: Partial<DatabaseConnectionInput> = {
  metadataMcpServerId: 'mcp-1',
  metadataMcpProject: 'e-cidade',
};

const run = (tools: Awaited<ReturnType<typeof setup>>['tools'], sql: string) =>
  tools.call('executar_consulta', { sql, objetivo: 'teste' });

beforeEach(() => {
  fake = new FakePgGateway();
  dictionary = new FakeMetadataLookup();
  n = 0;
  service = new DatabaseService({
    repo: new MemoryDatabaseRepository(),
    gateway: fake,
    clock: new FakeClock(),
    ids: { next: () => `id-${++n}` },
    rules: new MemoryColumnRuleRepository(),
    metadata: dictionary,
  });
});

describe('executar_consulta: name validation before running', () => {
  it('lets a valid query through with a single EXPLAIN-first execution', async () => {
    const { tools } = await setup();
    const out = await run(tools, 'select c.z01_nome from cgm c where c.z01_numcgm = 1');
    expect(out.isError).toBe(false);
    expect(fake.queries).toHaveLength(1);
    expect(fake.explained).toHaveLength(1);
    expect(fake.snapshotCalls).toBe(1);
  });

  it('(a) a misspelled qualified column gets a precise diagnosis, nothing runs and the budget is intact', async () => {
    const { tools, results } = await setup();
    const out = await run(tools, 'select c.z01_nomee from public.cgm c limit 5');
    expect(out.isError).toBe(true);
    expect(out.text).toBe(
      [
        'Validação da consulta (nada foi executado; esta tentativa não conta no limite de consultas):',
        '- coluna "z01_nomee" não existe em public.cgm (usada como c.z01_nomee). Parecidas: z01_nome, z01_nomecomple.',
        'Colunas de public.cgm: id int4, z01_numcgm int4, z01_nome varchar, z01_nomecomple varchar, z01_cgccpf varchar, situacao text',
        'Corrija e chame executar_consulta de novo; não repita o mesmo nome.',
      ].join('\n'),
    );
    expect(fake.queries).toHaveLength(0);
    expect(fake.explained).toHaveLength(0);
    // the analyst still sees the attempt, as a name check
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ validation: true, source: 'ai' });

    // the per-turn budget of queries is untouched: all 6 valid ones still run
    for (let i = 0; i < 3; i += 1) await run(tools, 'select cgm.zzz from cgm');
    for (let i = 0; i < DATA_TOOL_MAX_QUERIES_PER_TURN; i += 1) {
      const ok = await run(tools, `select ${i} as n from cgm limit 1`);
      expect(ok.isError).toBe(false);
    }
    expect(fake.queries).toHaveLength(DATA_TOOL_MAX_QUERIES_PER_TURN);
  });

  it('reports several mistakes at once and a table that lives in another schema', async () => {
    fake.tables.push({ ...fake.tables[1]!, schema: 'protocolo', name: 'cgmcpf' });
    const { tools } = await setup();
    const out = await run(
      tools,
      'select a.nada, b.z01_nomee from cgm a join iptubase b on true join cgmcpf d on true',
    );
    expect(out.text).toContain('- tabela "iptubase" não existe.');
    expect(out.text).toContain(
      '- tabela "cgmcpf" não existe. Existe em outro schema: protocolo.cgmcpf.',
    );
    expect(out.text).toContain('- coluna "nada" não existe em public.cgm (usada como a.nada).');
    expect(fake.queries).toHaveLength(0);
  });

  it('(b) an unqualified wrong column is caught by EXPLAIN, with suggestions and without counting', async () => {
    const { tools, results } = await setup();
    fake.explainCheck = () => {
      throw Object.assign(
        new Error(
          'column "z01_nomee" does not exist (posição 8) Dica: Perhaps you meant to reference the column "c.z01_nome".',
        ),
        { code: '42703', phase: 'validation' },
      );
    };
    const out = await run(tools, 'select z01_nomee from cgm c');
    expect(out.isError).toBe(true);
    expect(out.text).toBe(
      [
        'Validação da consulta (nada foi executado; esta tentativa não conta no limite de consultas):',
        '- column "z01_nomee" does not exist (posição 8) Dica: Perhaps you meant to reference the column "c.z01_nome".',
        'Parecidas: z01_nome (em cgm), z01_nomecomple (em cgm).',
        'Colunas de public.cgm: id int4, z01_numcgm int4, z01_nome varchar, z01_nomecomple varchar, z01_cgccpf varchar, situacao text',
        'Corrija e chame executar_consulta de novo; não repita o mesmo nome.',
      ].join('\n'),
    );
    expect(fake.queries).toHaveLength(0);
    expect(results[0]).toMatchObject({ validation: true });
    for (let i = 0; i < DATA_TOOL_MAX_QUERIES_PER_TURN; i += 1) {
      fake.explainCheck = () => undefined;
      expect((await run(tools, `select ${i} from cgm`)).isError).toBe(false);
    }
  });

  it('keeps the identifier hint of EXPLAIN name errors but masks quoted values of other errors', async () => {
    const { tools } = await setup();
    fake.explainCheck = () => {
      throw Object.assign(
        new Error('column "xx" does not exist Dica: Perhaps you meant "cgm.z01_nome".'),
        {
          code: '42703',
          phase: 'validation',
        },
      );
    };
    const named = await run(tools, 'select xx from cgm');
    expect(named.text).toContain('Perhaps you meant "cgm.z01_nome"');
    fake.explainCheck = () => undefined;
    fake.respond = () => {
      throw Object.assign(new Error('invalid input syntax for type integer: "JOAO DA SILVA"'), {
        code: '22P02',
      });
    };
    const other = await run(tools, 'select 1 from cgm');
    expect(other.text).not.toContain('JOAO');
  });

  it('(c) an invented table with no similar name asks the dictionary and shows only what exists', async () => {
    dictionary.tables = [
      { schema: 'protocolo', table: 'cgm', description: 'Cadastro Geral de Contribuinte' },
      { schema: 'caixa', table: 'tabela_que_nao_existe_aqui', description: 'Fantasma' },
    ];
    const { tools } = await setup(withDictionary);
    const out = await run(tools, 'select * from contribuinte_municipal limit 1');
    expect(out.text).toContain('- tabela "contribuinte_municipal" não existe.');
    expect(out.text).toContain(
      'No dicionário de dados (MCP): cgm (Cadastro Geral de Contribuinte).',
    );
    expect(out.text).not.toContain('Fantasma');
    expect(dictionary.tableTerms).toEqual(['contribuinte_municipal']);
    expect(dictionary.targets[0]).toEqual({ serverId: 'mcp-1', project: 'e-cidade' });
    expect(fake.queries).toHaveLength(0);
  });

  it('a column invented by the AI is resolved by the dictionary label, filtered to real columns', async () => {
    dictionary.fields = [
      {
        schema: 'protocolo',
        table: 'cgm',
        column: 'z01_nome',
        label: 'Nome/Razão Social',
        tableLabel: null,
      },
      {
        schema: 'issqn',
        table: 'issplan',
        column: 'q20_nomecontri',
        label: 'Nome',
        tableLabel: null,
      },
      {
        schema: 'protocolo',
        table: 'cgm',
        column: 'coluna_fantasma',
        label: 'Fantasma',
        tableLabel: null,
      },
    ];
    const { tools } = await setup(withDictionary);
    const out = await run(tools, 'select c.valor_terreno from cgm c');
    expect(out.text).toContain('No dicionário de dados (MCP): cgm.z01_nome (Nome/Razão Social).');
    expect(out.text).not.toContain('issplan');
    expect(out.text).not.toContain('Fantasma');
    expect(dictionary.fieldTerms).toEqual(['valor_terreno']);
  });

  it('does not consult the dictionary when the catalog already has a good suggestion', async () => {
    const { tools } = await setup(withDictionary);
    await run(tools, 'select c.z01_nomee from cgm c');
    expect(dictionary.fieldTerms).toEqual([]);
    expect(dictionary.tableTerms).toEqual([]);
  });

  it('without a configured dictionary, or with the MCP down, only the catalog speaks', async () => {
    const plain = await setup();
    const noMcp = await run(plain.tools, 'select * from contribuinte_municipal');
    expect(noMcp.text).not.toContain('dicionário');
    expect(dictionary.tableTerms).toEqual([]);

    dictionary.down = true;
    const down = await setup({ ...withDictionary, name: 'Outra' });
    const out = await run(down.tools, 'select * from contribuinte_municipal');
    expect(out.isError).toBe(true);
    expect(out.text).toContain('- tabela "contribuinte_municipal" não existe.');
    expect(out.text).not.toContain('dicionário');
  });

  it('never puts values from SQL literals in the message or in the dictionary term', async () => {
    dictionary.fields = [];
    const { tools } = await setup(withDictionary);
    const out = await run(
      tools,
      "select c.valor_terreno from cgm c where c.z01_nome = 'Maria da Silva' and c.z01_cgccpf = '52998224725'",
    );
    expect(out.isError).toBe(true);
    expect(out.text).not.toContain('Maria');
    expect(out.text).not.toContain('52998224725');
    expect(dictionary.fieldTerms.join(' ')).not.toMatch(/Maria|52998224725/);
  });

  it('a value restored into a quoted identifier never reaches the message (names are checked on the AI text)', async () => {
    const { tools, vault } = await setup();
    const token = vault.tokenFor('CPF', '52998224725');
    const out = await run(tools, `select c."${token}" from cgm c`);
    expect(out.text).not.toContain('52998224725');
    expect(out.text).toContain(token);
  });

  it('tells the AI to stop after too many failed name checks, but still runs valid queries', async () => {
    const { tools } = await setup();
    let last = '';
    for (let i = 0; i <= DATA_TOOL_MAX_VALIDATIONS_PER_TURN; i += 1)
      last = (await run(tools, `select c.erro${i} from cgm c`)).text;
    expect(last).toContain('Limite de validações de nomes');
    expect(fake.queries).toHaveLength(0);
    // 5 validations + 0 queries = 5 calls; the call limit (12) still has room for a valid one
    expect((await run(tools, 'select 1 from cgm')).isError).toBe(false);
  });

  it('confirms a finding against a fresh catalog before reporting it (stale cache)', async () => {
    const { tools } = await setup();
    await run(tools, 'select c.z01_nomee from cgm c');
    expect(fake.snapshotCalls).toBe(2); // cached pass + confirmation pass
  });
});

describe('Executar SQL (analyst): same validation, "Você quis dizer…?"', () => {
  it('shows suggestions in the result and executes nothing', async () => {
    const created = await service.create(input);
    const result = await service.runDirect(created.id, 'select c.z01_nomee from cgm c');
    expect(result.validation).toBe(true);
    expect(result.source).toBe('direct');
    expect(result.error).toContain('A consulta não foi executada');
    expect(result.error).toContain('Você quis dizer: z01_nome, z01_nomecomple?');
    expect(result.error).not.toContain('Corrija e chame');
    expect(fake.queries).toHaveLength(0);
  });

  it('is not limited by the schemas the AI may explore', async () => {
    fake.tables.push({ ...fake.tables[1]!, schema: 'outro', name: 'tabela_x' });
    const created = await service.create({ ...input, schemas: ['public'] });
    const ok = await service.runDirect(created.id, 'select * from outro.tabela_x');
    expect(ok.error).toBeNull();
    const { tools } = await setup({ name: 'restrita', schemas: ['public'] });
    const ai = await run(tools, 'select * from outro.tabela_x');
    expect(ai.isError).toBe(true);
    expect(ai.text).toContain('schema "outro" não existe ou não está liberado');
  });

  it('keeps the full Postgres text for a name error found by EXPLAIN', async () => {
    const created = await service.create(input);
    fake.explainCheck = () => {
      throw Object.assign(
        new Error('column "z01_nomee" does not exist Dica: Perhaps you meant "cgm.z01_nome".'),
        {
          code: '42703',
          phase: 'validation',
        },
      );
    };
    const result = await service.runDirect(created.id, 'select z01_nomee from cgm');
    expect(result.validation).toBe(true);
    expect(result.error).toContain('Perhaps you meant "cgm.z01_nome"');
    expect(result.error).toContain('Você quis dizer');
  });
});
