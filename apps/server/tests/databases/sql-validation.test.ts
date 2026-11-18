import { describe, expect, it } from 'vitest';
import type { PgCatalogColumn, PgCatalogTable } from '../../src/contexts/databases/domain/ports';
import { extractReferences } from '../../src/contexts/databases/domain/sql-references';
import {
  buildCatalogView,
  formatValidation,
  validateReferences,
  type DescribedIssue,
} from '../../src/contexts/databases/domain/sql-validation';

const t = (schema: string, name: string): PgCatalogTable => ({ schema, name, kind: 'table' });
const col = (name: string, type = 'text'): PgCatalogColumn => ({ name, type });

const tables = [t('public', 'cgm'), t('public', 'iptubase'), t('arrecadacao', 'arrecad')];
const columns = new Map<string, PgCatalogColumn[]>([
  ['public.cgm', [col('z01_numcgm', 'int4'), col('z01_nome', 'varchar'), col('z01_cgccpf')]],
  ['public.iptubase', [col('j01_matric', 'int4'), col('j01_numcgm', 'int4')]],
  ['arrecadacao.arrecad', [col('k00_numpre', 'int4')]],
]);
const view = buildCatalogView({ tables, searchPath: ['public', 'pg_catalog'] }, columns);

const issues = (sql: string) => validateReferences(extractReferences(sql), view);

describe('validateReferences', () => {
  it('accepts a valid query with aliases, schema, joins and CTEs', () => {
    expect(
      issues(`with x as (select z01_numcgm from cgm)
        select c.z01_nome, i.j01_matric, public.cgm.z01_cgccpf, a.k00_numpre, x.z01_numcgm
          from public.cgm c join iptubase i on i.j01_numcgm = c.z01_numcgm
          join arrecadacao.arrecad a on true join x on true`),
    ).toEqual([]);
  });

  it('flags a misspelled qualified column with the table it was looked up in', () => {
    expect(issues('select c.z01_nomee from cgm c')).toEqual([
      { kind: 'column', table: t('public', 'cgm'), column: 'z01_nomee', written: 'c.z01_nomee' },
    ]);
  });

  it('flags a column used through the table name when there is no alias, and schema.table.column', () => {
    expect(issues('select cgm.nope from cgm')).toHaveLength(1);
    expect(issues('select public.cgm.nope from public.cgm')).toHaveLength(1);
  });

  it('resolves aliases per query block: the same alias may mean two tables', () => {
    expect(
      issues(`select c.z01_nome from cgm c
        where exists (select 1 from iptubase c where c.j01_matric = 1)`),
    ).toEqual([]);
    expect(
      issues(
        `select 1 from cgm c where exists (select 1 from iptubase i where i.j01_numcgm = c.z01_nomee)`,
      ),
    ).toHaveLength(1);
  });

  it('flags missing tables, tables in the wrong schema and unknown schemas', () => {
    const found = issues('select 1 from arrecadacao.cgm a, tabela_nova n, nada.x');
    expect(found.map((i) => i.kind === 'table' && [i.schema, i.name, i.reason])).toEqual([
      ['arrecadacao', 'cgm', 'table'],
      [null, 'tabela_nova', 'table'],
      ['nada', 'x', 'schema'],
    ]);
    expect((found[0] as { elsewhere: PgCatalogTable[] }).elsewhere).toEqual([t('public', 'cgm')]);
  });

  it('does not report columns of a missing table (only the table)', () => {
    expect(issues('select z.a from tabela_nova z')).toHaveLength(1);
  });

  it('is conservative: unknown qualifiers, system columns, system schemas and pg_ views pass', () => {
    expect(
      issues(`select s.anything, c.ctid, c.xmin from cgm c, (select 1 as anything) s,
        pg_catalog.pg_class k, information_schema.tables it, pg_tables pt`),
    ).toEqual([]);
  });

  it('reports one issue per repeated mistake', () => {
    expect(issues('select c.zz, c.zz from cgm c where c.zz = 1')).toHaveLength(1);
  });
});

describe('formatValidation', () => {
  const column: DescribedIssue = {
    issue: {
      kind: 'column',
      table: t('public', 'cgm'),
      column: 'z01_nomee',
      written: 'c.z01_nomee',
    },
    notes: { suggestions: ['z01_nome', 'z01_nomecomple'], elsewhere: [], dictionary: [] },
  };
  const table: DescribedIssue = {
    issue: {
      kind: 'table',
      schema: null,
      name: 'arrecadacao',
      reason: 'table',
      elsewhere: [],
      schemas: [],
    },
    notes: {
      suggestions: [],
      elsewhere: [],
      dictionary: ['public.cgm (Cadastro Geral de Contribuinte)'],
    },
  };
  const lists = [{ table: 'public.cgm', columns: columns.get('public.cgm')! }];

  it('words the AI message with names only', () => {
    expect(formatValidation([column, table], lists, 'ai')).toBe(
      [
        'Validação da consulta (nada foi executado; esta tentativa não conta no limite de consultas):',
        '- coluna "z01_nomee" não existe em public.cgm (usada como c.z01_nomee). Parecidas: z01_nome, z01_nomecomple.',
        '- tabela "arrecadacao" não existe. No dicionário de dados (MCP): public.cgm (Cadastro Geral de Contribuinte).',
        'Colunas de public.cgm: z01_numcgm int4, z01_nome varchar, z01_cgccpf text',
        'Corrija e chame executar_consulta de novo; não repita o mesmo nome.',
      ].join('\n'),
    );
  });

  it('words the analyst message as "Você quis dizer…?"', () => {
    const text = formatValidation([column], lists, 'analyst');
    expect(text).toContain('A consulta não foi executada');
    expect(text).toContain('Você quis dizer: z01_nome, z01_nomecomple?');
    expect(text).not.toContain('Corrija e chame');
  });

  it('caps the column list and tells how many were left out', () => {
    const many = Array.from({ length: 45 }, (_, i) => col(`c${i}`));
    const text = formatValidation([], [{ table: 'public.big', columns: many }], 'ai');
    expect(text).toContain('c39 text (e mais 5)');
    expect(text).not.toContain('c40');
  });
});
