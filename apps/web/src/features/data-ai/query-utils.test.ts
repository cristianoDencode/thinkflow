import { describe, expect, it } from 'vitest';
import { compareCells, looksLikeSql, sortedIndexes, toCsv, toTsv } from './query-utils';

const columns = [
  { name: 'nome', type: 'text' },
  { name: 'valor', type: 'numeric' },
];

describe('toCsv', () => {
  it('starts with a BOM, quotes commas, quotes and line breaks, and leaves null empty', () => {
    const csv = toCsv(columns, [
      ['Ana, "a"', '1.5'],
      ['linha\nquebrada', null],
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('nome,valor\r\n"Ana, ""a""",1.5\r\n"linha\nquebrada",\r\n');
  });

  it('serializes objects as JSON', () => {
    expect(toCsv([{ name: 'j', type: 'jsonb' }], [[{ a: 1 }]])).toContain('"{""a"":1}"');
  });
});

describe('toTsv', () => {
  it('flattens tabs and line breaks inside cells', () => {
    expect(toTsv(columns, [['a\tb\nc', 2]])).toBe('nome\tvalor\r\na b c\t2\r\n');
  });
});

describe('sorting', () => {
  it('orders numeric columns by value, not text', () => {
    const rows = [
      ['a', '10'],
      ['b', '9'],
      ['c', '100'],
      ['d', null],
    ];
    expect(sortedIndexes(rows, 1, 'numeric', 'asc')).toEqual([1, 0, 2, 3]);
    // nulls stay last when descending
    expect(sortedIndexes(rows, 1, 'numeric', 'desc')).toEqual([2, 0, 1, 3]);
  });

  it('orders text naturally and keeps ties stable', () => {
    const rows = [['item 10'], ['item 2'], ['Item 2']];
    expect(sortedIndexes(rows, 0, 'text', 'asc')).toEqual([1, 2, 0]);
  });

  it('compares nulls last', () => {
    expect(compareCells(null, 'a', false)).toBe(1);
    expect(compareCells('a', null, false)).toBe(-1);
  });
});

describe('looksLikeSql', () => {
  it.each(['select 1', '  SELECT * from t', 'with x as (select 1) select * from x', '(select 1)'])(
    'detects %s',
    (text) => expect(looksLikeSql(text)).toBe(true),
  );
  it.each(['Quais tabelas guardam o IPTU?', 'selecione os débitos', ''])('ignores %s', (text) =>
    expect(looksLikeSql(text)).toBe(false),
  );
});
