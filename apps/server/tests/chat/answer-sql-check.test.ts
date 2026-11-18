import type { SqlValidationDto } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import {
  checkAnswerSql,
  MAX_CHECKED_SQL_BLOCKS,
} from '../../src/contexts/chat/application/answer-sql-check';

const fence = (sql: string) => `\`\`\`sql\n${sql}\n\`\`\``;
const ok: SqlValidationDto = { status: 'ok', issues: [], reason: null };

function stub(respond: (sql: string) => { validation: SqlValidationDto; aiText: string | null }) {
  const seen: string[] = [];
  return {
    seen,
    data: {
      async validateSql(sql: string) {
        seen.push(sql);
        return respond(sql);
      },
    },
  };
}

describe('checkAnswerSql', () => {
  it('does nothing without SQL blocks or without a validator', async () => {
    const s = stub(() => ({ validation: ok, aiText: null }));
    expect(await checkAnswerSql(s.data, 'Sem SQL aqui.')).toEqual({ blocks: [], correction: null });
    expect(await checkAnswerSql({}, fence('select 1'))).toEqual({ blocks: [], correction: null });
    expect(s.seen).toEqual([]);
  });

  it('numbers the blocks and asks for a rewrite only for missing names', async () => {
    const s = stub((sql) =>
      sql.includes('ruim')
        ? {
            validation: {
              status: 'invalid',
              issues: [
                { message: 'coluna "ruim" não existe em public.cgm.', suggestions: ['bom'] },
              ],
              reason: null,
            },
            aiText: '- coluna "ruim" não existe em public.cgm. Parecidas: bom.',
          }
        : sql.includes('delete')
          ? {
              validation: {
                status: 'invalid',
                issues: [{ message: 'Consulta recusada.', suggestions: [] }],
                reason: null,
              },
              aiText: null,
            }
          : { validation: ok, aiText: null },
    );
    const text = [fence('select 1'), fence('select ruim from cgm'), fence('delete from cgm')].join(
      '\n\n',
    );
    const out = await checkAnswerSql(s.data, text);
    expect(out.blocks.map((b) => [b.index, b.status])).toEqual([
      [0, 'ok'],
      [1, 'invalid'],
      [2, 'invalid'],
    ]);
    expect(out.correction).toContain('Bloco SQL 2:');
    expect(out.correction).toContain('Parecidas: bom.');
    expect(out.correction).not.toContain('Bloco SQL 3');
  });

  it('checks only the first blocks and survives a validator that throws', async () => {
    const many = Array.from({ length: MAX_CHECKED_SQL_BLOCKS + 2 }, (_, i) =>
      fence(`select ${i}`),
    ).join('\n');
    const s = stub(() => ({ validation: ok, aiText: null }));
    const out = await checkAnswerSql(s.data, many);
    expect(s.seen).toHaveLength(MAX_CHECKED_SQL_BLOCKS);
    expect(out.blocks).toHaveLength(MAX_CHECKED_SQL_BLOCKS + 2);
    expect(out.blocks.at(-1)).toMatchObject({ status: 'unchecked' });

    const broken = {
      async validateSql(): Promise<never> {
        throw new Error('boom');
      },
    };
    const soft = await checkAnswerSql(broken, fence('select 1'));
    expect(soft.blocks).toEqual([
      { index: 0, status: 'unchecked', issues: [], reason: 'Não foi possível conferir este SQL.' },
    ]);
    expect(soft.correction).toBeNull();
  });

  it('rethrows when the turn was aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const broken = {
      async validateSql(): Promise<never> {
        throw new Error('aborted');
      },
    };
    await expect(checkAnswerSql(broken, fence('select 1'), controller.signal)).rejects.toThrow(
      'aborted',
    );
  });
});
