import { describe, expect, it } from 'vitest';
import { extractSqlBlocks } from './sql-blocks';

describe('extractSqlBlocks', () => {
  it('finds ```sql, ```postgresql and unlabeled SELECT/WITH blocks, in order', () => {
    const text = [
      'Primeiro:',
      '```sql',
      'SELECT 1',
      '```',
      'Segundo:',
      '```postgresql',
      'select * from cgm',
      '```',
      'Terceiro:',
      '```',
      '-- comentário',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      '```',
    ].join('\n');
    const blocks = extractSqlBlocks(text);
    expect(blocks.map((b) => [b.index, b.sql, b.lang])).toEqual([
      [0, 'SELECT 1', 'sql'],
      [1, 'select * from cgm', 'postgresql'],
      [2, '-- comentário\nWITH x AS (SELECT 1) SELECT * FROM x', ''],
    ]);
    expect(text.slice(blocks[1]!.start, blocks[1]!.start + 13)).toBe('```postgresql');
  });

  it('ignores other languages, unlabeled blocks that are not queries and comment-only blocks', () => {
    const text = [
      '```json',
      '{"select": 1}',
      '```',
      '```',
      'npm run build',
      '```',
      '```sql',
      '-- só um comentário',
      '```',
      '```mermaid',
      'select',
      '```',
    ].join('\n');
    expect(extractSqlBlocks(text)).toEqual([]);
  });

  it('keeps labeled blocks that are not read-only (the validation refuses them)', () => {
    expect(extractSqlBlocks('```sql\nDELETE FROM x\n```').map((b) => b.sql)).toEqual([
      'DELETE FROM x',
    ]);
  });

  it('handles longer fences, tildes, CRLF and an unclosed fence', () => {
    expect(extractSqlBlocks('````sql\nselect 1;\n```\nselect 2\n````').map((b) => b.sql)).toEqual([
      'select 1;\n```\nselect 2',
    ]);
    expect(extractSqlBlocks('~~~sql\r\nselect 1\r\n~~~').map((b) => b.sql)).toEqual(['select 1']);
    expect(extractSqlBlocks('Veja:\n```sql\nselect 1').map((b) => b.sql)).toEqual(['select 1']);
  });

  it('does not treat inline triple backticks as a fence', () => {
    expect(extractSqlBlocks('use ```select 1``` assim\n```sql\nselect 2\n```')).toHaveLength(1);
  });
});
