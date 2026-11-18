import type { QueryColumnDto } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import { classifyColumns } from '../../src/contexts/privacy/application/classify-columns';
import { needsReview, settle } from '../../src/contexts/privacy/domain/classification';
import { MemoryColumnRuleRepository } from '../databases/memory-rules';

const col = (name: string, type: string, source?: string | null): QueryColumnDto => ({
  name,
  type,
  source: source === null ? null : { schema: 'public', table: 'cgm', column: source ?? name },
});

async function classify(
  columns: QueryColumnDto[],
  rules = new MemoryColumnRuleRepository(),
  rows: unknown[][] = [],
) {
  return classifyColumns({ connectionId: 'c1', columns, rules, rows });
}

describe('classifyColumns', () => {
  it('numeric, date and boolean columns without a sensitive name are revealed (auto)', async () => {
    const out = await classify([
      col('exercicio', 'int4'),
      col('valor', 'numeric'),
      col('vencimento', 'date'),
      col('ativo', 'bool'),
    ]);
    for (const c of out) expect(c).toMatchObject({ action: 'reveal', origin: 'auto' });
  });

  it('a sensitive source name is tokenized with the kind the name suggests', async () => {
    const out = await classify([
      col('z01_nome', 'varchar'),
      col('z01_email', 'varchar'),
      col('z01_cgccpf', 'int8'),
      col('cnpj', 'varchar'),
      col('telefone', 'varchar'),
    ]);
    expect(out.map((c) => [c.action, c.kind, c.origin])).toEqual([
      ['tokenize', 'NOME', 'auto'],
      ['tokenize', 'EMAIL', 'auto'],
      ['tokenize', 'VALOR', 'auto'], // cpf or cnpj: the digest refines it per value
      ['tokenize', 'CNPJ', 'auto'],
      ['tokenize', 'TELEFONE', 'auto'],
    ]);
  });

  it('judges the SOURCE column, never the alias', async () => {
    const [aliased, innocent] = await classify([
      col('x', 'text', 'z01_nome'),
      col('z01_nome', 'text', 'situacao'),
    ]);
    expect(aliased).toMatchObject({ action: 'tokenize', kind: 'NOME' });
    expect(aliased!.ref).toEqual({ schema: 'public', table: 'cgm', column: 'z01_nome' });
    // an alias that looks personal does not make an innocent text column "sensitive"
    expect(innocent).toMatchObject({ action: 'unclassified', origin: 'default' });
  });

  it('text, json and other types without a rule are unclassified', async () => {
    const out = await classify([
      col('situacao', 'text'),
      col('dados', 'jsonb'),
      col('chave', 'uuid'),
      col('tags', '_text'),
      col('estado', 'oid:99999'),
    ]);
    for (const c of out) {
      expect(c.action).toBe('unclassified');
      expect(needsReview(c)).toBe(true);
      expect(settle(c)).toMatchObject({ action: 'tokenize' });
    }
  });

  it('analyst rule beats auto rule beats name beats type, with wildcard precedence', async () => {
    const rules = new MemoryColumnRuleRepository();
    const rule = (over: Record<string, unknown>) =>
      rules.upsert({
        connectionId: 'c1',
        schema: '*',
        table: '*',
        column: 'z01_nome',
        action: 'reveal',
        kind: null,
        origin: 'analyst',
        ...over,
      });
    await rule({}); // (*, *): legacy "never mask" list
    expect((await classify([col('n', 'text', 'z01_nome')], rules))[0]).toMatchObject({
      action: 'reveal',
      origin: 'analyst',
    });
    await rule({ table: 'cgm', action: 'omit' }); // (*, table) is more specific
    expect((await classify([col('n', 'text', 'z01_nome')], rules))[0]).toMatchObject({
      action: 'omit',
    });
    await rule({
      schema: 'public',
      table: 'cgm',
      action: 'tokenize',
      kind: 'NOME',
      origin: 'auto',
    });
    expect((await classify([col('n', 'text', 'z01_nome')], rules))[0]).toMatchObject({
      action: 'tokenize',
      kind: 'NOME',
      origin: 'auto',
    });
    // another table is untouched by the table-specific rules
    const other: QueryColumnDto = {
      name: 'n',
      type: 'text',
      source: { schema: 'public', table: 'outra', column: 'z01_nome' },
    };
    expect((await classify([other], rules))[0]).toMatchObject({ action: 'reveal' });
  });

  it('a rule can release a sensitive name and reveal a text column', async () => {
    const rules = new MemoryColumnRuleRepository();
    for (const column of ['cpf', 'situacao'])
      await rules.upsert({
        connectionId: 'c1',
        schema: 'public',
        table: 'cgm',
        column,
        action: 'reveal',
        kind: null,
        origin: 'analyst',
      });
    const out = await classify([col('cpf', 'varchar'), col('situacao', 'text')], rules);
    expect(out.map((c) => c.action)).toEqual(['reveal', 'reveal']);
    expect(out.some(needsReview)).toBe(false);
  });

  it('expressions: numbers/dates are revealed, anything else is tokenized and reviewable', async () => {
    const [count, label, when] = await classify([
      col('total', 'int8', null),
      col('rotulo', 'text', null),
      col('dia', 'date', null),
    ]);
    expect(count).toMatchObject({ action: 'reveal', origin: 'default', expression: true });
    expect(when).toMatchObject({ action: 'reveal', origin: 'default' });
    expect(label).toMatchObject({ action: 'tokenize', origin: 'default', expression: true });
    expect(needsReview(count!)).toBe(false);
    expect(needsReview(label!)).toBe(true);
  });

  it('a numeric column full of valid CPFs/CNPJs is tokenized whatever its name', async () => {
    const [cpf, cnpj, ids] = await classify(
      [col('codigo', 'int8'), col('outro', 'numeric'), col('seq', 'int8')],
      new MemoryColumnRuleRepository(),
      [
        [52998224725, '11222333000181', 1],
        ['1114447773', '11222333000181', 2], // CPF 01114447773 lost its leading zero? not valid -> ignored
        [11144477735, null, 3],
      ],
    );
    expect(cpf).toMatchObject({ action: 'tokenize', kind: 'CPF', origin: 'auto' });
    expect(cnpj).toMatchObject({ action: 'tokenize', kind: 'CNPJ' });
    expect(ids).toMatchObject({ action: 'reveal' });
  });

  it('an unknown source (field absent) falls back to the column name', async () => {
    const out = await classify([
      { name: 'z01_nome', type: 'text' },
      { name: 'exercicio', type: 'int4' },
      { name: 'obs', type: 'text' },
    ]);
    expect(out.map((c) => c.action)).toEqual(['tokenize', 'reveal', 'unclassified']);
    expect(out[0]!.expression).toBe(false);
  });
});
