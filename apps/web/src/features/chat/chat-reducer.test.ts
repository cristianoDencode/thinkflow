import { describe, expect, it } from 'vitest';
import { applyStreamEvent, fromDto } from './chat-reducer';
import { INITIAL_STEPS, type UiMessage } from './types';

const base: UiMessage = {
  id: 'tmp',
  role: 'assistant',
  content: '',
  toolCalls: [],
  steps: { ...INITIAL_STEPS },
  streaming: true,
};

describe('applyStreamEvent: analyst review', () => {
  const review = { reviewId: 'r1', databaseId: 'db', sql: 'select 1', columns: [] };

  it('opens a review card and closes it with the reason', () => {
    let m = applyStreamEvent(base, { type: 'ai_review', review });
    m = applyStreamEvent(m, { type: 'ai_review', review }); // replayed frame: no duplicate
    expect(m.reviews).toEqual([{ review }]);
    m = applyStreamEvent(m, { type: 'ai_review_closed', reviewId: 'r1', reason: 'timeout' });
    expect(m.reviews).toEqual([{ review, closed: 'timeout' }]);
    // an unknown id changes nothing
    expect(
      applyStreamEvent(m, { type: 'ai_review_closed', reviewId: 'zz', reason: 'aborted' }).reviews,
    ).toEqual([{ review, closed: 'timeout' }]);
  });
});

describe('applyStreamEvent', () => {
  it('accumulates text, steps and tool calls, then finalizes', () => {
    let m = base;
    m = applyStreamEvent(m, { type: 'step', step: 'analyze', status: 'done' });
    m = applyStreamEvent(m, {
      type: 'tool_call',
      id: 't1',
      name: 'mcp__fs__read',
      input: { p: 1 },
    });
    m = applyStreamEvent(m, {
      type: 'tool_result',
      id: 't1',
      name: 'mcp__fs__read',
      output: 'ok',
      isError: false,
    });
    m = applyStreamEvent(m, { type: 'delta', text: 'Olá' });
    m = applyStreamEvent(m, { type: 'delta', text: ' mundo' });
    m = applyStreamEvent(m, {
      type: 'done',
      messageId: 'real-id',
      providerId: 'groq',
      model: 'llama',
    });
    expect(m.content).toBe('Olá mundo');
    expect(m.steps?.analyze).toBe('done');
    expect(m.toolCalls).toEqual([
      { id: 't1', name: 'mcp__fs__read', input: { p: 1 }, output: 'ok', isError: false },
    ]);
    expect(m).toMatchObject({ id: 'real-id', streaming: false, providerId: 'groq' });
  });

  it('stores how much history was sent to the model', () => {
    const m = applyStreamEvent(base, {
      type: 'context',
      keptMessages: 6,
      omittedMessages: 10,
      summarized: true,
      estimatedTokens: 3200,
      budgetTokens: 16000,
    });
    expect(m.context).toEqual({
      keptMessages: 6,
      omittedMessages: 10,
      summarized: true,
      estimatedTokens: 3200,
      budgetTokens: 16000,
    });
    expect(m.streaming).toBe(true);
  });

  it('collects query results of the turn (replacing one with the same id)', () => {
    const result = {
      id: 'q1',
      sql: 'select 1',
      columns: [{ name: 'a', type: 'int4' }],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
      durationMs: 3,
      source: 'ai' as const,
      purpose: 'teste',
      error: null,
    };
    let m = applyStreamEvent(base, { type: 'query_result', result });
    m = applyStreamEvent(m, { type: 'query_result', result: { ...result, id: 'q2' } });
    m = applyStreamEvent(m, { type: 'query_result', result: { ...result, rowCount: 5 } });
    expect(m.queryResults?.map((r) => [r.id, r.rowCount])).toEqual([
      ['q2', 1],
      ['q1', 5],
    ]);
  });

  it('records errors', () => {
    expect(applyStreamEvent(base, { type: 'error', message: 'falhou' }).error).toBe('falhou');
  });
});

describe('fromDto', () => {
  it('maps stored failures to an error state', () => {
    const m = fromDto({
      id: 'x',
      role: 'assistant',
      content: '⚠️ Sem conexão',
      createdAt: 0,
      meta: {},
    });
    expect(m.error).toBe('Sem conexão');
    expect(m.content).toBe('');
    expect(m.steps?.search).toBe('skipped');
  });
});

describe('fromDto (data mode)', () => {
  const meta = {
    id: 'q1',
    sql: 'select 1',
    columns: [{ name: 'a', type: 'int4' }],
    rowCount: 1,
    truncated: false,
    durationMs: 3,
    purpose: null,
    error: null,
  };

  it('keeps stored query results without rows and flags typed queries as direct', () => {
    const direct = fromDto({
      id: 'a',
      role: 'assistant',
      content: '',
      createdAt: 0,
      meta: { queryResults: [{ ...meta, source: 'direct' }] },
    });
    expect(direct.direct).toBe(true);
    expect(direct.queryResults?.[0]?.rows).toBeUndefined();

    const ai = fromDto({
      id: 'b',
      role: 'assistant',
      content: 'Achei 1 linha.',
      createdAt: 0,
      meta: { queryResults: [{ ...meta, source: 'ai' }] },
    });
    expect(ai.direct).toBeUndefined();
    expect(ai.queryResults).toHaveLength(1);
  });
});

describe('applyStreamEvent: SQL validation (data mode)', () => {
  const blocks = [{ index: 0, status: 'ok' as const, issues: [], reason: null }];

  it('stores the per-block verdict', () => {
    const m = applyStreamEvent(base, { type: 'sql_validation', blocks });
    expect(m.sqlValidation).toEqual(blocks);
  });

  it('cuts the draft the model is rewriting, keeping what came before it', () => {
    let m = applyStreamEvent(base, { type: 'delta', text: 'Vou olhar as tabelas. ' });
    m = applyStreamEvent(m, { type: 'delta', text: 'Rascunho com SQL errado.' });
    const keep = 'Vou olhar as tabelas. '.length;
    m = applyStreamEvent(m, { type: 'answer_rewrite', keepChars: keep });
    expect(m.content).toBe('Vou olhar as tabelas. ');
    expect(m.sqlValidation).toEqual([]);
    m = applyStreamEvent(m, { type: 'delta', text: 'Versão corrigida.' });
    expect(m.content).toBe('Vou olhar as tabelas. Versão corrigida.');
  });

  it('restores the stored verdict of a reloaded message', () => {
    const m = fromDto({
      id: 'a',
      role: 'assistant',
      content: '```sql\nselect 1\n```',
      createdAt: 0,
      meta: { sqlValidation: blocks },
    });
    expect(m.sqlValidation).toEqual(blocks);
  });
});
