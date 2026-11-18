import { describe, expect, it } from 'vitest';
import { extractReferences } from '../../src/contexts/databases/domain/sql-references';

const tables = (sql: string) =>
  extractReferences(sql).tables.map((t) => ({
    schema: t.schema,
    name: t.name,
    alias: t.alias,
    cte: t.cte,
  }));
const cols = (sql: string) => extractReferences(sql).columns.map((c) => c.parts.join('.'));

describe('extractReferences: tables', () => {
  it('reads FROM with and without alias, AS and schema', () => {
    expect(tables('select 1 from cgm')).toEqual([
      { schema: null, name: 'cgm', alias: null, cte: false },
    ]);
    expect(tables('select 1 from public.cgm c where c.id = 1')).toEqual([
      { schema: 'public', name: 'cgm', alias: 'c', cte: false },
    ]);
    expect(tables('select 1 from cgm as c')[0]).toMatchObject({ name: 'cgm', alias: 'c' });
  });

  it('reads quoted identifiers exactly and lower-cases the unquoted ones', () => {
    expect(tables('select 1 from "Public"."Cgm" x, CGM')).toEqual([
      { schema: 'Public', name: 'Cgm', alias: 'x', cte: false },
      { schema: null, name: 'cgm', alias: null, cte: false },
    ]);
  });

  it('reads JOINs of every kind and a comma list', () => {
    const sql = `select 1 from cgm c
      left join cgmfisico f on f.z04_numcgm = c.z01_numcgm
      inner join public.cgmjuridico j using (z08_numcgm), iptubase i
      cross join lateral (select 1) s
      where c.id = 1 order by 1`;
    expect(tables(sql).map((t) => `${t.schema ?? ''}.${t.name}/${t.alias}`)).toEqual([
      '.cgm/c',
      '.cgmfisico/f',
      'public.cgmjuridico/j',
      '.iptubase/i',
    ]);
  });

  it('ignores CTE names, subquery aliases and function calls in FROM', () => {
    const sql = `with a as (select 1 from cgm), b (x) as materialized (select 2 from iptubase)
      select * from a join b on true
        join (select z01_numcgm from cgm2) sub on true
        join generate_series(1, 3) g on true`;
    const refs = extractReferences(sql);
    expect(refs.cteNames).toEqual(['a', 'b']);
    const real = refs.tables.filter((t) => !t.cte).map((t) => t.name);
    expect(real).toEqual(['cgm', 'iptubase', 'cgm2']);
    expect(refs.tables.filter((t) => t.cte).map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('does not take FROM inside EXTRACT/SUBSTRING/TRIM or IS DISTINCT FROM for a table', () => {
    const sql = `select extract(year from dt), substring(nome from 2 for 3), trim(both 'x' from nome),
      a is distinct from b from cgm where 1 = 1`;
    expect(tables(sql).map((t) => t.name)).toEqual(['cgm']);
  });

  it('reads a parenthesized join and subqueries in WHERE / the select list', () => {
    const sql = `select (select max(x) from tb_a) m from (cgm c join cgmfisico f on true)
      where c.id in (select id from tb_b where tb_b.k = c.id)`;
    expect(tables(sql).map((t) => t.name)).toEqual(['tb_a', 'cgm', 'cgmfisico', 'tb_b']);
  });

  it('does not treat commas of other clauses or arrays as new tables', () => {
    const sql = `select a, b from cgm where x in (1, 2) and y = any(array[1, 2]) group by a, b order by a, b`;
    expect(tables(sql).map((t) => t.name)).toEqual(['cgm']);
  });

  it('returns nothing for text it cannot tokenize', () => {
    expect(extractReferences("select 'aberto from cgm")).toMatchObject({ tables: [], columns: [] });
  });
});

describe('extractReferences: columns', () => {
  it('reads alias.column and schema.table.column, but not alias.* or function calls', () => {
    const sql = `select c.z01_nome, public.cgm.z01_numcgm, c.*, pg_catalog.lower(c.z01_nome), x::public.mytype
      from public.cgm c where c.z01_nomee like 'a.b.c' and 1.5 > c.valor`;
    expect(cols(sql)).toEqual([
      'c.z01_nome',
      'public.cgm.z01_numcgm',
      'c.z01_nome',
      'c.z01_nomee',
      'c.valor',
    ]);
  });

  it('keeps the query block of each reference (correlated subqueries see outer aliases)', () => {
    const refs = extractReferences(
      'select 1 from cgm c where exists (select 1 from iptubase i where i.j01_numcgm = c.z01_numcgm)',
    );
    expect(refs.scopes).toHaveLength(2);
    expect(refs.columns.map((c) => [c.parts.join('.'), c.scope])).toEqual([
      ['i.j01_numcgm', 1],
      ['c.z01_numcgm', 1],
    ]);
    expect(refs.scopes[1]).toEqual({ id: 1, parent: 0 });
  });

  it('never reads the contents of string literals or comments', () => {
    const sql = `select 1 from cgm -- from fake_table
      where nome = 'x from other_table, y.z' /* from nope.t */`;
    const refs = extractReferences(sql);
    expect(refs.tables.map((t) => t.name)).toEqual(['cgm']);
    expect(refs.columns).toEqual([]);
  });
});
