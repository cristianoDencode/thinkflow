import type { AiReviewDto, DatabaseConnectionInput, QueryResultDto } from '@thinkflow/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/contexts/databases/application/database-service';
import type { ReviewDecision } from '../../src/contexts/databases/application/data-toolset';
import { InMemoryVault, type Vault } from '../../src/contexts/privacy/domain/vault';
import { FakeClock } from '../../src/shared/kernel/clock';
import { FakePgGateway } from './fake-pg-gateway';
import { MemoryColumnRuleRepository } from './memory-rules';
import { MemoryDatabaseRepository } from './memory-repo';

let fake: FakePgGateway;
let service: DatabaseService;
let n = 0;
let rules: MemoryColumnRuleRepository;

const input: DatabaseConnectionInput = {
  name: 'e-Cidade',
  host: 'db.local',
  database: 'ecidade',
  user: 'leitor',
  password: 'segredo',
};

interface SetupOptions {
  vault?: Vault;
  review?: (review: AiReviewDto) => ReviewDecision[];
}

async function setup(extra: Partial<DatabaseConnectionInput> = {}, opts: SetupOptions = {}) {
  const created = await service.create({ ...input, ...extra });
  const results: QueryResultDto[] = [];
  const reviews: AiReviewDto[] = [];
  const tools = await service.chatTools(created.id, {
    maxOutputChars: 6000,
    onResult: (r) => results.push(r),
    ...(opts.vault ? { vault: opts.vault } : {}),
    ...(opts.review
      ? {
          requestReview: async (review: AiReviewDto) => {
            reviews.push(review);
            return opts.review!(review);
          },
        }
      : {}),
  });
  if (!tools) throw new Error('tools expected');
  return { created, results, reviews, tools };
}

const cgm = (column: string) => ({ schema: 'public', table: 'cgm', column });

beforeEach(() => {
  fake = new FakePgGateway();
  n = 0;
  rules = new MemoryColumnRuleRepository();
  service = new DatabaseService({
    repo: new MemoryDatabaseRepository(),
    gateway: fake,
    clock: new FakeClock(),
    ids: { next: () => `id-${++n}` },
    rules,
  });
});

describe('data toolset', () => {
  it('exposes the four tools and a pt-BR system note', async () => {
    const { tools } = await setup();
    expect(tools.tools.map((t) => t.name)).toEqual([
      'listar_tabelas',
      'descrever_tabela',
      'resumo_coluna',
      'executar_consulta',
    ]);
    expect(tools.databaseName).toBe('e-Cidade');
    expect(tools.systemNote).toContain('SOMENTE LEITURA');
    expect(tools.systemNote).toContain('só enxerga a estrutura');
  });

  it('note describes the masked sample when allowed', async () => {
    const { tools } = await setup({ aiAccess: 'masked', sampleRows: 7 });
    expect(tools.systemNote).toContain('até 7 linhas');
  });

  it('returns null for an unknown connection', async () => {
    expect(
      await service.chatTools('nope', { maxOutputChars: 1000, onResult: () => {} }),
    ).toBeNull();
  });

  it('executar_consulta reports full rows to the screen and returns only a digest', async () => {
    const { tools, results } = await setup();
    const out = await tools.call('executar_consulta', {
      sql: 'select * from contribuintes limit 3;',
      objetivo: 'Listar contribuintes',
    });
    expect(out.isError).toBe(false);
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]!.sql).toBe('select * from contribuintes limit 3');
    expect(fake.queries[0]!.maxRows).toBe(1000);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source: 'ai',
      purpose: 'Listar contribuintes',
      rowCount: 3,
      error: null,
      truncated: false,
    });
    expect(results[0]!.rows[0]).toEqual([1, 'Maria da Silva', '10123456760', '150.00']);

    // schema-only connection: the model gets no row value at all
    expect(out.text).not.toContain('Maria');
    expect(out.text).not.toContain('10123456760');
    expect(out.text).toContain('só estrutura');
  });

  it('masked connections give the model a tokenized sample', async () => {
    const { tools } = await setup({ aiAccess: 'masked', sampleRows: 2 });
    const out = await tools.call('executar_consulta', { sql: 'select 1', objetivo: 'x' });
    expect(out.text).toContain('2 de 3 linhas');
    expect(out.text).toMatch(/\| \[NOME_1\] \| \[CPF_1\] \| 150\.00/);
    expect(out.text).not.toContain('10123456760');
    expect(out.text).not.toContain('Maria');
    expect(out.text).not.toContain('Ana Lima');
  });

  it('classifies by the source column even when the query aliases it', async () => {
    const { tools } = await setup({ aiAccess: 'masked' });
    fake.respond = () => ({
      columns: [{ name: 'x', type: 'text', source: cgm('z01_nome') }],
      rows: [['Maria da Silva'], ['João Souza']],
      truncated: false,
      durationMs: 1,
    });
    const out = await tools.call('executar_consulta', {
      sql: 'select z01_nome as x from cgm',
      objetivo: 'x',
    });
    expect(out.text).not.toContain('Maria');
    expect(out.text).not.toContain('Souza');
    expect(out.text).toMatch(/\[NOME_1\]/);
  });

  it('uses the same token for the same value in later queries of the conversation', async () => {
    const vault = new InMemoryVault();
    const { tools } = await setup({ aiAccess: 'masked' }, { vault });
    fake.respond = () => ({
      columns: [{ name: 'doc', type: 'varchar', source: cgm('z01_cgccpf') }],
      rows: [['52998224725']],
      truncated: false,
      durationMs: 1,
    });
    const a = await tools.call('executar_consulta', { sql: 'select 1', objetivo: 'x' });
    const b = await tools.call('executar_consulta', { sql: 'select 2', objetivo: 'x' });
    expect(a.text).toContain('doc\n[CPF_1]');
    expect(b.text).toContain('doc\n[CPF_1]');
    expect(vault.valueOf('[CPF_1]')).toBe('52998224725');
  });

  it('restores tokens written by the AI in the SQL, but never echoes the value back', async () => {
    const vault = new InMemoryVault();
    const token = vault.tokenFor('CPF', '52998224725');
    const { tools, results } = await setup({ aiAccess: 'masked' }, { vault });
    const out = await tools.call('executar_consulta', {
      sql: `select * from cgm where z01_cgccpf = '${token}'`,
      objetivo: 'x',
    });
    expect(fake.queries[0]!.sql).toBe("select * from cgm where z01_cgccpf = '52998224725'");
    expect(results[0]!.sql).toContain('52998224725'); // the analyst's screen shows the real SQL
    expect(out.text).not.toContain('52998224725');
  });

  it('errors for the AI carry no quoted values; the analyst keeps the full message', async () => {
    const { tools, results } = await setup();
    fake.respond = () => {
      throw new Error('invalid input syntax for type integer: "JOAO DA SILVA"');
    };
    const out = await tools.call('executar_consulta', { sql: 'select 1', objetivo: 'x' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('invalid input syntax for type integer');
    expect(out.text).not.toContain('JOAO');
    expect(results[0]!.error).toContain('JOAO DA SILVA');
  });

  describe('analyst review of unclassified columns', () => {
    const statusResult = () => ({
      columns: [
        { name: 'id', type: 'int4', source: cgm('id') },
        { name: 'situacao', type: 'text', source: cgm('situacao') },
        { name: 'expr', type: 'text', source: null },
      ],
      rows: [
        [1, 'aberto', 'abc'],
        [2, 'pago', 'def'],
      ],
      truncated: false,
      durationMs: 1,
    });

    it('asks only about unclassified columns and expressions, with real sample values', async () => {
      const { tools, reviews } = await setup(
        { aiAccess: 'masked' },
        { review: () => [{ index: 1, action: 'reveal', remember: false }] },
      );
      fake.respond = statusResult;
      const out = await tools.call('executar_consulta', { sql: 'select 1', objetivo: 'x' });
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ databaseId: expect.any(String), sql: 'select 1' });
      expect(reviews[0]!.reviewId).toBeTruthy();
      expect(reviews[0]!.columns).toEqual([
        {
          index: 1,
          name: 'situacao',
          type: 'text',
          source: cgm('situacao'),
          proposed: 'tokenize',
          kind: null,
          sample: ['aberto', 'pago'],
        },
        {
          index: 2,
          name: 'expr',
          type: 'text',
          source: null,
          proposed: 'tokenize',
          kind: null,
          sample: ['abc', 'def'],
        },
      ]);
      // released column shows, the expression (missing decision) is tokenized
      expect(out.text).toContain('aberto');
      expect(out.text).not.toContain('abc');
      expect(rules.rules).toHaveLength(0);
    });

    it('remember saves an analyst rule, the next query needs no review; expressions are never saved', async () => {
      let asked = 0;
      const { tools } = await setup(
        { aiAccess: 'masked' },
        {
          review: () => {
            asked += 1;
            return [
              { index: 1, action: 'reveal', remember: true },
              { index: 2, action: 'reveal', remember: true },
            ];
          },
        },
      );
      fake.respond = statusResult;
      const first = await tools.call('executar_consulta', { sql: 'select 1', objetivo: 'x' });
      expect(first.text).toContain('abc');
      expect(rules.rules).toHaveLength(1);
      expect(rules.rules[0]).toMatchObject({
        schema: 'public',
        table: 'cgm',
        column: 'situacao',
        action: 'reveal',
        origin: 'analyst',
      });
      const second = await tools.call('executar_consulta', { sql: 'select 2', objetivo: 'x' });
      expect(asked).toBe(2); // the expression still asks; situacao no longer does
      expect(second.text).toContain('aberto');
    });

    it('omit removes the column from what the AI reads', async () => {
      const { tools } = await setup(
        { aiAccess: 'masked' },
        {
          review: () => [
            { index: 1, action: 'omit', remember: true },
            { index: 2, action: 'tokenize', remember: false },
          ],
        },
      );
      fake.respond = statusResult;
      const out = await tools.call('executar_consulta', { sql: 'select 1', objetivo: 'x' });
      expect(out.text).not.toContain('aberto');
      expect(out.text).not.toContain('situacao');
      expect(rules.rules[0]).toMatchObject({ column: 'situacao', action: 'omit' });
    });

    it('without a gate (or on structure-only connections) nothing unclassified is revealed', async () => {
      const masked = await setup({ aiAccess: 'masked' });
      fake.respond = statusResult;
      const out = await masked.tools.call('executar_consulta', { sql: 'select 1', objetivo: 'x' });
      expect(out.text).not.toContain('aberto');
      expect(out.text).not.toContain('abc');
      expect(out.text).toMatch(/\[VALOR_\d+\]/);

      let asked = 0;
      const schema = await setup(
        { name: 'outra', aiAccess: 'schema' },
        {
          review: () => {
            asked += 1;
            return [];
          },
        },
      );
      const quiet = await schema.tools.call('executar_consulta', {
        sql: 'select 1',
        objetivo: 'x',
      });
      expect(asked).toBe(0);
      expect(quiet.text).not.toContain('aberto');
    });

    it('an aborted review aborts the tool call', async () => {
      const controller = new AbortController();
      const { tools } = await setup(
        { aiAccess: 'masked' },
        {
          review: () => {
            controller.abort();
            return [];
          },
        },
      );
      fake.respond = statusResult;
      await expect(
        tools.call('executar_consulta', { sql: 'select 1', objetivo: 'x' }, controller.signal),
      ).rejects.toThrow();
    });
  });

  it('a guard rejection never reaches the database', async () => {
    const { tools, results } = await setup();
    for (const sql of [
      'delete from contribuintes',
      'select 1; drop table x',
      'select pg_sleep(5)',
    ]) {
      const out = await tools.call('executar_consulta', { sql, objetivo: 'x' });
      expect(out.isError).toBe(true);
      expect(out.text).toContain('Consulta recusada');
      expect(out.text).toContain('Só consultas de leitura');
    }
    expect(fake.queries).toHaveLength(0);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.error && r.rows.length === 0)).toBe(true);
  });

  it('Postgres errors come back as tool errors the model can act on', async () => {
    const { tools, results } = await setup();
    fake.respond = () => {
      throw new Error('syntax error at or near "frm" (posição 10)');
    };
    const out = await tools.call('executar_consulta', { sql: 'select 1 frm t', objetivo: 'x' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('syntax error at or near "…"');
    expect(out.text).toContain('(posição 10)');
    expect(out.text).not.toContain('frm');
    expect(results[0]!.error).toContain('syntax error');
  });

  it('limits executar_consulta to 6 per turn and all calls to 12', async () => {
    const { tools } = await setup();
    for (let i = 0; i < 6; i += 1) {
      const out = await tools.call('executar_consulta', { sql: 'select 1', objetivo: 'x' });
      expect(out.isError).toBe(false);
      expect(out.text).not.toContain('Limite');
    }
    const seventh = await tools.call('executar_consulta', { sql: 'select 1', objetivo: 'x' });
    expect(seventh.text).toContain('Limite de consultas');
    expect(fake.queries).toHaveLength(6);

    // 7 calls so far; 5 more reach the global cap of 12
    for (let i = 0; i < 5; i += 1) {
      const out = await tools.call('listar_tabelas', {});
      expect(out.text).not.toContain('Limite');
    }
    const over = await tools.call('listar_tabelas', {});
    expect(over.text).toContain('Limite de consultas');
  });

  it('caps every output at maxOutputChars', async () => {
    const created = await service.create(input);
    const tools = (await service.chatTools(created.id, {
      maxOutputChars: 120,
      onResult: () => {},
    }))!;
    const out = await tools.call('descrever_tabela', { tabela: 'contribuintes' });
    expect(out.text.length).toBeLessThanOrEqual(120);
  });

  it('listar_tabelas, descrever_tabela and resumo_coluna format the catalog', async () => {
    const { tools } = await setup();
    const list = await tools.call('listar_tabelas', { filtro: 'contrib' });
    expect(list.text).toContain(
      'public.contribuintes (table, ~3 linhas) — Cadastro de contribuintes',
    );

    const desc = await tools.call('descrever_tabela', { tabela: 'public.contribuintes' });
    expect(desc.text).toContain('- id int4 NOT NULL');
    expect(desc.text).toContain('- cpf varchar (sensível)');
    expect(desc.text).toContain('- nome text NOT NULL (sensível)');
    expect(desc.text).toContain('PK: id');

    const missing = await tools.call('descrever_tabela', { tabela: 'nao_existe' });
    expect(missing.isError).toBe(true);

    const year = await tools.call('resumo_coluna', {
      tabela: 'contribuintes',
      coluna: 'exercicio',
    });
    // structure-only connection: counts only, no range
    expect(year.text).toContain('distintos: 3');
    expect(year.text).not.toContain('mínimo');
    const cpf = await tools.call('resumo_coluna', { tabela: 'contribuintes', coluna: 'cpf' });
    expect(cpf.text).toContain('sensível');
    expect(cpf.text).not.toContain('mínimo');
  });

  it('resumo_coluna gives min/max only for revealed columns of connections with samples', async () => {
    const { tools } = await setup({ aiAccess: 'masked' });
    const year = await tools.call('resumo_coluna', {
      tabela: 'contribuintes',
      coluna: 'exercicio',
    });
    expect(year.text).toContain('mínimo: 2021; máximo: 2025');
    const date = await tools.call('resumo_coluna', {
      tabela: 'contribuintes',
      coluna: 'vencimento',
    });
    expect(date.text).toContain('mínimo: 2021-01-10; máximo: 2025-12-20');
    // a rule from the analyst wins over the type
    await rules.upsert({
      connectionId: 'id-1',
      schema: 'public',
      table: 'contribuintes',
      column: 'exercicio',
      action: 'omit',
      kind: null,
      origin: 'analyst',
    });
    const hidden = await tools.call('resumo_coluna', {
      tabela: 'contribuintes',
      coluna: 'exercicio',
    });
    expect(hidden.text).not.toContain('mínimo');
    const desc = await tools.call('descrever_tabela', { tabela: 'contribuintes' });
    expect(desc.text).toContain('- exercicio int4 NOT NULL (omitida da IA)');
  });

  it('comments go through the firewall and index predicates lose their literals', async () => {
    fake.tables[0]!.comment = 'Contribuinte principal: Maria da Silva, CPF 529.982.247-25';
    fake.tables[0]!.columns[1]!.comment = 'Contato: ana.souza@dominio.com.br';
    fake.tables[0]!.indexes = [
      {
        name: 'idx_parcial',
        definition:
          "CREATE INDEX idx_parcial ON public.contribuintes USING btree (nome) WHERE ((situacao)::text = 'JOAO DA SILVA'::text AND exercicio > 2021)",
      },
    ];
    const vault = new InMemoryVault();
    const { tools } = await setup({}, { vault });
    const list = await tools.call('listar_tabelas', {});
    const desc = await tools.call('descrever_tabela', { tabela: 'contribuintes' });
    for (const text of [list.text, desc.text]) {
      expect(text).not.toContain('Maria da Silva');
      expect(text).not.toContain('529.982.247-25');
      expect(text).not.toContain('ana.souza');
    }
    expect(desc.text).toContain('[EMAIL_1]');
    expect(desc.text).toContain('idx_parcial');
    expect(desc.text).not.toContain('JOAO');
    expect(desc.text).toContain('= ?::text AND exercicio > ?');
  });

  it('rejects unknown tools and missing arguments', async () => {
    const { tools } = await setup();
    expect((await tools.call('apagar_tudo', {})).isError).toBe(true);
    expect((await tools.call('executar_consulta', {})).isError).toBe(true);
    expect((await tools.call('descrever_tabela', {})).isError).toBe(true);
    expect(fake.queries).toHaveLength(0);
  });
});
