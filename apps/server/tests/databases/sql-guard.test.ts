import { describe, expect, it } from 'vitest';
import { checkReadOnlySql } from '../../src/contexts/databases/domain/sql-guard';

const ok = (sql: string) => {
  const r = checkReadOnlySql(sql);
  expect(r, sql).toMatchObject({ ok: true });
  return r as { ok: true; sql: string };
};
const rejected = (sql: string) => {
  const r = checkReadOnlySql(sql);
  expect(r.ok, sql).toBe(false);
  return (r as { ok: false; reason: string }).reason;
};

describe('checkReadOnlySql — accepts', () => {
  it.each([
    'SELECT 1',
    'select * from contribuintes limit 10',
    'WITH a AS (SELECT 1 AS x) SELECT * FROM a',
    'VALUES (1), (2)',
    'TABLE contribuintes',
    'EXPLAIN SELECT * FROM t',
    '(select 1) union (select 2)',
    'select updated_at, created, set_id, comment_text from t',
    "select 'delete from x; drop table y' as texto",
    "select 'it''s; insert into x' as t",
    String.raw`select e'a\'b; drop table x' as t`,
    'select $$delete from x; drop table y$$ as t',
    'select $fn$ insert into x $fn$ as t',
    'select "delete" from "update"',
    'select t.comment, t.start from t',
    'select $1::int, $2::text',
    'select 1 -- drop table x',
    'select /* insert into x; */ 1 /* nested /* delete */ still */',
    'select count(*) from t where x > 1e10',
  ])('%s', (sql) => {
    ok(sql);
  });

  it('strips one trailing semicolon and trailing comments', () => {
    expect(ok('select 1;').sql).toBe('select 1');
    expect(ok('select 1 ;  ').sql).toBe('select 1');
    expect(ok('select 1; -- fim').sql).toBe('select 1');
    expect(ok('  select 1  ').sql).toBe('select 1');
  });
});

describe('checkReadOnlySql — rejects', () => {
  it.each([
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
    'WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM u',
    'select 1; select 2',
    'select 1; drop table t',
    'select 1;;',
    'SELECT * FROM t FOR UPDATE',
    'SELECT * FROM t FOR SHARE',
    'SELECT * FROM t FOR NO KEY UPDATE',
    'SELECT * FROM t FOR KEY SHARE',
    'SELECT * INTO novo FROM t',
    'select pg_terminate_backend(1)',
    'select pg_catalog.pg_cancel_backend(1)',
    "select nextval('s')",
    "select setval('s', 1)",
    "select set_config('a', 'b', false)",
    "select pg_read_file('/etc/passwd')",
    'select pg_sleep(10)',
    "select lo_import('/x')",
    "select dblink('x', 'y')",
    'select pg_advisory_lock(1)',
    'select "pg_sleep"(1)',
    'EXPLAIN ANALYZE select 1',
    'EXPLAIN (ANALYZE) select 1',
    'EXPLAIN (ANALYZE true, BUFFERS) select 1',
    '/* x */ DELETE FROM t',
    'set role x',
    'SET statement_timeout = 0',
    'drop table t',
    'truncate t',
    'create table t (a int)',
    'alter table t add b int',
    'grant all on t to x',
    'copy t to stdout',
    'call proc()',
    'do $$ begin end $$',
    'begin',
    'commit',
    'vacuum',
    'analyze t',
    'lock table t',
    'prepare p as select 1',
    'execute p',
    'listen canal',
    "comment on table t is 'x'",
    'select 1 where x in (select 2); delete from t',
    '',
    '   ',
    '-- só comentário',
    '/* nada */',
    "select 'aberta",
    'select /* aberto',
    'select $$ aberto',
    'select "aberto',
    ';',
  ])('%s', (sql) => {
    expect(rejected(sql).length).toBeGreaterThan(0);
  });

  it('explains why in pt-BR', () => {
    expect(rejected('delete from t')).toMatch(/DELETE/);
    expect(rejected('select 1; select 2')).toMatch(/uma instrução/);
    expect(rejected('')).toMatch(/vazia/);
  });

  it('rejects SQL over the size limit', () => {
    expect(rejected(`select '${'a'.repeat(100_001)}'`)).toMatch(/caracteres/);
  });
});
