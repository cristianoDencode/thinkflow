import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgConnectionParams } from '../../src/contexts/databases/domain/ports';
import { PgPoolGateway } from '../../src/contexts/databases/infrastructure/pg-gateway';

/**
 * Real-Postgres checks, only when PG_TEST_URL is set, e.g.
 *   PG_TEST_URL=postgres://tester:pw@localhost:54329/testdb pnpm --filter @thinkflow/server exec vitest run tests/databases/pg-gateway.real
 * The login may well be able to write: the point is that the gateway refuses it anyway.
 */
const url = process.env.PG_TEST_URL;

function paramsFrom(raw: string, over: Partial<PgConnectionParams> = {}): PgConnectionParams {
  const u = new URL(raw);
  return {
    id: 'real',
    version: 1,
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.slice(1),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    sslMode: 'disable',
    statementTimeoutSec: 30,
    ...over,
  };
}

describe.skipIf(!url)('PgPoolGateway (real Postgres)', () => {
  const gateway = new PgPoolGateway({ poolMax: 2, connectTimeoutMs: 5000 });
  const conn = paramsFrom(url ?? 'postgres://x:y@localhost/z');

  beforeAll(async () => {
    // prepare fixtures through a plain pool-less admin path: a throw-away gateway would be read-only,
    // so use pg directly
    const pg = (await import('pg')).default;
    const client = new pg.Client({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.user,
      password: conn.password,
    });
    await client.connect();
    try {
      await client.query('drop table if exists tf_pessoas');
      await client.query(
        `create table tf_pessoas (
           id serial primary key,
           nome text not null,
           exercicio int not null,
           vencimento date,
           valor numeric(12,2),
           criado timestamptz default now()
         )`,
      );
      await client.query(`comment on table tf_pessoas is 'Pessoas de teste'`);
      await client.query(`comment on column tf_pessoas.nome is 'Nome da pessoa'`);
      await client.query(
        `insert into tf_pessoas (nome, exercicio, vencimento, valor)
         select 'Pessoa ' || g, 2020 + (g % 5), date '2024-01-01' + g, g * 1.5 from generate_series(1, 25) g`,
      );
      await client.query('drop table if exists tf_itens');
      await client.query(
        'create table tf_itens (id serial primary key, pessoa_id int references tf_pessoas(id))',
      );
      await client.query('drop schema if exists tf_outro cascade');
      await client.query('create schema tf_outro');
      await client.query('create table tf_outro.tf_externa (id int, coluna_a text)');
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    const pg = (await import('pg')).default;
    const client = new pg.Client({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.user,
      password: conn.password,
    });
    await client.connect();
    await client.query('drop table if exists tf_itens');
    await client.query('drop table if exists tf_pessoas');
    await client.query('drop schema if exists tf_outro cascade');
    await client.end();
    await gateway.closeAll();
  });

  it('tests the connection', async () => {
    const info = await gateway.test(conn);
    expect(info.serverVersion).toMatch(/PostgreSQL/);
    expect(info.currentUser).toBe(conn.user);
    expect(typeof info.canWrite).toBe('boolean');
  });

  it('resolves the real source column of each field, surviving aliases; expressions have none', async () => {
    const res = await gateway.query(
      conn,
      'select nome as x, id, nome || id::text as junto, 1 as um, p.valor from tf_pessoas p limit 2',
      { maxRows: 5 },
    );
    const pessoas = (column: string) => ({ schema: 'public', table: 'tf_pessoas', column });
    expect(res.columns.map((c) => c.source)).toEqual([
      pessoas('nome'),
      pessoas('id'),
      null,
      null,
      pessoas('valor'),
    ]);
    // second run is served from the cache and gives the same answer
    const again = await gateway.query(conn, 'select nome as outro from tf_pessoas limit 1', {
      maxRows: 5,
    });
    expect(again.columns[0]!.source).toEqual(pessoas('nome'));
  });

  it('reads rows with JSON-safe values, column types and truncation', async () => {
    const res = await gateway.query(
      conn,
      'select id, nome, vencimento, valor, criado, 10::bigint as big, null::text as nada from tf_pessoas order by id',
      { maxRows: 10 },
    );
    expect(res.truncated).toBe(true);
    expect(res.rows).toHaveLength(10);
    expect(res.columns.map((c) => c.type)).toEqual([
      'int4',
      'text',
      'date',
      'numeric',
      'timestamptz',
      'int8',
      'text',
    ]);
    const first = res.rows[0]!;
    expect(first[0]).toBe(1);
    expect(first[2]).toBe('2024-01-02'); // dates keep Postgres text (no timezone shifting)
    expect(first[3]).toBe('1.50');
    expect(first[5]).toBe('10');
    expect(first[6]).toBeNull();
    expect(() => JSON.stringify(res.rows)).not.toThrow();

    const all = await gateway.query(conn, 'select id from tf_pessoas', { maxRows: 100 });
    expect(all.truncated).toBe(false);
    expect(all.rows).toHaveLength(25);
  });

  it('refuses writes even when the login could write (READ ONLY transaction)', async () => {
    await expect(
      gateway.query(conn, 'create temp table tf_x (a int)', { maxRows: 10 }),
    ).rejects.toThrow(/read-only/i);
    await expect(
      gateway.query(conn, "insert into tf_pessoas (nome, exercicio) values ('x', 1)", {
        maxRows: 10,
      }),
    ).rejects.toThrow(/read-only/i);
    await expect(
      gateway.query(conn, 'with d as (delete from tf_pessoas returning *) select * from d', {
        maxRows: 10,
      }),
    ).rejects.toThrow(/read-only/i);
    const count = await gateway.query(conn, 'select count(*) from tf_pessoas', { maxRows: 1 });
    expect(count.rows[0]![0]).toBe('25');
  });

  it('keeps working after an error (clients are reusable)', async () => {
    await expect(
      gateway.query(conn, 'select * from tabela_que_nao_existe', { maxRows: 5 }),
    ).rejects.toThrow(/does not exist|posição/);
    const ok = await gateway.query(conn, 'select 1 as um', { maxRows: 5 });
    expect(ok.rows).toEqual([[1]]);
  });

  it('applies statement_timeout', async () => {
    const short = paramsFrom(url!, { id: 'real-short', statementTimeoutSec: 1 });
    const started = Date.now();
    await expect(gateway.query(short, 'select pg_sleep(5)', { maxRows: 1 })).rejects.toThrow(
      /statement timeout/i,
    );
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('cancels the statement when the signal aborts', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const pending = gateway.query(conn, 'select pg_sleep(10)', { maxRows: 1, signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('lists and describes tables from the catalog', async () => {
    const tables = await gateway.listTables(conn, {
      schemas: ['public'],
      filter: 'pessoa',
      limit: 50,
    });
    const t = tables.find((x) => x.name === 'tf_pessoas');
    expect(t).toMatchObject({ schema: 'public', kind: 'table', comment: 'Pessoas de teste' });

    const byComment = await gateway.listTables(conn, {
      schemas: [],
      filter: 'Pessoas de teste',
      limit: 50,
    });
    expect(byComment.map((x) => x.name)).toContain('tf_pessoas');
    expect(
      (await gateway.listTables(conn, { schemas: [], limit: 500 })).some(
        (x) => x.schema === 'pg_catalog' || x.schema === 'information_schema',
      ),
    ).toBe(false);

    const detail = await gateway.describeTable(conn, 'tf_pessoas', { schemas: ['public'] });
    expect(detail?.columns.map((c) => c.name)).toEqual([
      'id',
      'nome',
      'exercicio',
      'vencimento',
      'valor',
      'criado',
    ]);
    expect(detail?.columns.find((c) => c.name === 'nome')).toMatchObject({
      type: 'text',
      nullable: false,
      comment: 'Nome da pessoa',
    });
    expect(detail?.primaryKey).toEqual(['id']);
    expect(detail?.indexes.length).toBeGreaterThan(0);

    const itens = await gateway.describeTable(conn, 'public.tf_itens', { schemas: [] });
    expect(itens?.foreignKeys).toEqual([
      {
        columns: ['pessoa_id'],
        references: { schema: 'public', table: 'tf_pessoas', columns: ['id'] },
      },
    ]);

    expect(await gateway.describeTable(conn, 'nao_existe', { schemas: [] })).toBeNull();
    expect(await gateway.describeTable(conn, 'tf_pessoas', { schemas: ['outro'] })).toBeNull();
  });

  it('summarizes columns (min/max only for numbers and dates)', async () => {
    const year = await gateway.columnSummary(conn, 'tf_pessoas', 'exercicio', { schemas: [] });
    expect(year).toMatchObject({ total: 25, nulls: 0, distinct: 5, min: '2020', max: '2024' });

    const date = await gateway.columnSummary(conn, 'tf_pessoas', 'vencimento', { schemas: [] });
    expect(date).toMatchObject({ min: '2024-01-02', max: '2024-01-26' });

    const text = await gateway.columnSummary(conn, 'tf_pessoas', 'nome', { schemas: [] });
    expect(text).toMatchObject({ total: 25, distinct: 25, min: null, max: null });

    expect(
      await gateway.columnSummary(conn, 'tf_pessoas', 'nao_existe', { schemas: [] }),
    ).toBeNull();
    // identifiers are validated against the catalog and quoted: no injection through names
    expect(
      await gateway.columnSummary(conn, 'tf_pessoas', 'id"; drop table tf_pessoas; --', {
        schemas: [],
      }),
    ).toBeNull();
    expect(
      (await gateway.query(conn, 'select count(*) from tf_pessoas', { maxRows: 1 })).rows[0]![0],
    ).toBe('25');
  });

  describe('name validation support', () => {
    const query = (sql: string) => gateway.query(conn, sql, { maxRows: 5, explainFirst: true });

    it('EXPLAIN catches an unqualified column that does not exist (phase validation, 42703)', async () => {
      const err = await query('select nomee from tf_pessoas limit 1').catch((e: unknown) => e);
      expect(err).toMatchObject({ code: '42703', phase: 'validation' });
      // the reported position points into the user's SQL, not into "EXPLAIN <sql>"
      expect((err as { position?: string }).position).toBe('8');
      expect((err as Error).message).toContain('"nomee"');
      expect((err as Error).message).toMatch(/posição 8/);
    });

    it('marks missing relations (42P01), ambiguous columns (42702) and unknown functions (42883)', async () => {
      await expect(query('select 1 from tf_nao_existe')).rejects.toMatchObject({
        code: '42P01',
        phase: 'validation',
      });
      await expect(
        query('select id from tf_pessoas a join tf_itens b on b.pessoa_id = a.id'),
      ).rejects.toMatchObject({ code: '42702', phase: 'validation' });
      await expect(query('select funcao_que_nao_existe(1)')).rejects.toMatchObject({
        code: '42883',
        phase: 'validation',
      });
    });

    it('other EXPLAIN errors are not marked as validation', async () => {
      const err = await query('select from from').catch((e: unknown) => e);
      expect(err).toMatchObject({ code: '42601' });
      expect((err as { phase?: string }).phase).toBeUndefined();
    });

    it('runs a valid statement normally and skips the extra EXPLAIN when the SQL is one already', async () => {
      const res = await query('select count(*) as n from tf_pessoas');
      expect(res.rows[0]![0]).toBe('25');
      const plan = await query('explain select id from tf_pessoas');
      expect(plan.rows.length).toBeGreaterThan(0);
    });

    it('catalogSnapshot lists tables of the allowed schemas only and reports the search path', async () => {
      const all = await gateway.catalogSnapshot(conn, { schemas: [], refresh: true });
      const names = all.tables.map((t) => `${t.schema}.${t.name}`);
      expect(names).toEqual(expect.arrayContaining(['public.tf_pessoas', 'tf_outro.tf_externa']));
      expect(names.some((n) => n.startsWith('pg_catalog.'))).toBe(false);
      expect(all.searchPath).toContain('public');
      expect(all.tables.find((t) => t.name === 'tf_pessoas')?.kind).toBe('table');

      const onlyPublic = await gateway.catalogSnapshot(conn, { schemas: ['public'] });
      const publicNames = onlyPublic.tables.map((t) => `${t.schema}.${t.name}`);
      expect(publicNames).toContain('public.tf_pessoas');
      expect(publicNames).not.toContain('tf_outro.tf_externa');
    });

    it('columnsOf loads columns on demand with type names, caches them and refreshes on request', async () => {
      const wanted = [
        { schema: 'public', name: 'tf_pessoas' },
        { schema: 'tf_outro', name: 'tf_externa' },
        { schema: 'public', name: 'tf_nao_existe' },
      ];
      const first = await gateway.columnsOf(conn, wanted, { refresh: true });
      expect(first.get('public.tf_pessoas')).toEqual([
        { name: 'id', type: 'int4' },
        { name: 'nome', type: 'text' },
        { name: 'exercicio', type: 'int4' },
        { name: 'vencimento', type: 'date' },
        { name: 'valor', type: 'numeric' },
        { name: 'criado', type: 'timestamptz' },
      ]);
      expect(first.get('tf_outro.tf_externa')?.map((c) => c.name)).toEqual(['id', 'coluna_a']);
      expect(first.has('public.tf_nao_existe')).toBe(false);

      const pg = (await import('pg')).default;
      const admin = new pg.Client({
        host: conn.host,
        port: conn.port,
        database: conn.database,
        user: conn.user,
        password: conn.password,
      });
      await admin.connect();
      try {
        await admin.query('alter table tf_outro.tf_externa add column coluna_b int');
      } finally {
        await admin.end();
      }
      const cached = await gateway.columnsOf(conn, [{ schema: 'tf_outro', name: 'tf_externa' }]);
      expect(cached.get('tf_outro.tf_externa')).toHaveLength(2); // served from the cache
      const fresh = await gateway.columnsOf(conn, [{ schema: 'tf_outro', name: 'tf_externa' }], {
        refresh: true,
      });
      expect(fresh.get('tf_outro.tf_externa')?.map((c) => c.name)).toEqual([
        'id',
        'coluna_a',
        'coluna_b',
      ]);

      // invalidate (a connection edit) drops both caches
      await gateway.invalidate(conn.id);
      const after = await gateway.columnsOf(conn, [{ schema: 'tf_outro', name: 'tf_externa' }]);
      expect(after.get('tf_outro.tf_externa')).toHaveLength(3);
    });
  });

  it('reports a clear error for a wrong password and an unreachable host', async () => {
    await expect(
      gateway.test(paramsFrom(url!, { id: 'bad-pw', password: 'errada' })),
    ).rejects.toMatchObject({ code: expect.stringMatching(/28P01|28000/) });
    await expect(
      gateway.test(paramsFrom(url!, { id: 'bad-host', host: '127.0.0.1', port: 1 })),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
