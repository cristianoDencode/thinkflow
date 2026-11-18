import { describe, expect, it } from 'vitest';
import {
  MIN_CONTEXT_BUDGET,
  OMITTED_MARK,
  SUMMARY_MAX_CHARS,
  SUMMARY_PREFIX,
  buildCarryOver,
  buildContextWindow,
  buildSummaryRequest,
  chunkForSummary,
  extractiveSummary,
  groupTurns,
  renderHistoryMessages,
  resolveContextBudget,
} from '../../src/contexts/chat/domain/context-window';
import type {
  ConversationSummary,
  StoredMessage,
} from '../../src/contexts/chat/domain/conversation';

let seq = 0;
function msg(
  role: 'user' | 'assistant',
  content: string,
  meta: StoredMessage['meta'] = {},
): StoredMessage {
  seq++;
  return { id: `m${seq}`, conversationId: 'c', role, content, meta, createdAt: seq };
}

/** n turns of user+assistant, each message `size` chars. */
function conversation(n: number, size = 400): StoredMessage[] {
  seq = 0;
  const out: StoredMessage[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(
      msg('user', `U${i} ${'x'.repeat(size)}`),
      msg('assistant', `A${i} ${'y'.repeat(size)}`),
    );
  }
  return out;
}

const tokensOf = (w: { messages: unknown[] }) => Math.ceil(JSON.stringify(w.messages).length / 4);
const summaryOf = (through: string | null, text = 'resumo antigo'): ConversationSummary => ({
  text,
  throughMessageId: through,
  kind: 'llm',
  updatedAt: 1,
});

describe('resolveContextBudget', () => {
  it('uses the configured value without a learned limit', () => {
    expect(resolveContextBudget({ configured: 16_000 })).toBe(16_000);
  });
  it('lets a smaller learned limit win (85%) and never goes below the minimum', () => {
    expect(resolveContextBudget({ configured: 16_000, learnedLimit: 8_000 })).toBe(6_800);
    expect(resolveContextBudget({ configured: 16_000, learnedLimit: 100_000 })).toBe(16_000);
    expect(resolveContextBudget({ configured: 16_000, learnedLimit: 500 })).toBe(
      MIN_CONTEXT_BUDGET,
    );
  });
});

describe('groupTurns', () => {
  it('starts a turn at each user message; leading assistant messages form their own', () => {
    seq = 0;
    const a0 = msg('assistant', 'trazida');
    const u1 = msg('user', 'a');
    const a1 = msg('assistant', 'b');
    const u2 = msg('user', 'c');
    expect(groupTurns([a0, u1, a1, u2])).toEqual([[a0], [u1, a1], [u2]]);
  });
});

describe('buildContextWindow', () => {
  const base = { summary: null, fixedTokens: 100, recentTurns: 3 };

  it('sends everything and asks for no summary when it fits', () => {
    const history = conversation(3);
    const w = buildContextWindow({ ...base, history, budget: 16_000 });
    expect(w.messages).toHaveLength(6);
    expect(w.messages.every((m) => m.role !== 'tool' && m.role !== 'system')).toBe(true);
    expect(w.toSummarize).toEqual([]);
    expect(w.omittedCount).toBe(0);
    expect(w.keptMessageIds).toHaveLength(6);
    expect(w.truncated).toBe(false);
  });

  it('compacts on overflow: keeps <=60% of the allowance, <=recentTurns, >=1 turn, exact gap', () => {
    const history = conversation(12); // ~12 * 220 tokens
    const budget = 1_800;
    const w = buildContextWindow({ ...base, history, budget });
    const allowance = budget - base.fixedTokens;
    expect(tokensOf(w)).toBeLessThanOrEqual(allowance * 0.6);
    expect(w.keptMessageIds.length / 2).toBeLessThanOrEqual(base.recentTurns);
    expect(w.keptMessageIds.length).toBeGreaterThanOrEqual(2);
    // kept = newest suffix; gap = everything before it
    const firstKept = history.findIndex((m) => m.id === w.keptMessageIds[0]);
    expect(history.slice(firstKept).map((m) => m.id)).toEqual(w.keptMessageIds);
    expect(w.toSummarize.map((m) => m.id)).toEqual(history.slice(0, firstKept).map((m) => m.id));
    expect(w.omittedCount).toBe(firstKept);
    expect(w.estimatedTokens).toBeLessThanOrEqual(budget);
  });

  it('puts an existing summary first and only summarizes what is new', () => {
    const history = conversation(10);
    const through = history[3]!.id; // first 2 turns summarized already
    const w = buildContextWindow({
      ...base,
      history,
      summary: summaryOf(through),
      budget: 1_800,
    });
    expect(w.messages[0]).toEqual({
      role: 'system',
      content: `${SUMMARY_PREFIX}resumo antigo`,
    });
    expect(w.toSummarize[0]!.id).toBe(history[4]!.id);
    expect(w.toSummarize.at(-1)!.id).toBe(
      history[history.length - w.keptMessageIds.length - 1]!.id,
    );
  });

  it('reuses the summary without compacting while the tail is small (hysteresis)', () => {
    const history = conversation(8);
    const w = buildContextWindow({
      ...base,
      history,
      summary: summaryOf(history[7]!.id), // 4 turns summarized, 4 left (<= 2 * recentTurns)
      budget: 16_000,
    });
    expect(w.toSummarize).toEqual([]);
    expect(w.messages).toHaveLength(1 + 8);
    expect(w.omittedCount).toBe(8);
  });

  it('compacts when the tail exceeds 2x recentTurns even if it fits the budget', () => {
    const history = conversation(8, 20);
    const w = buildContextWindow({ ...base, history, budget: 100_000 });
    expect(history.length / 2).toBeGreaterThan(base.recentTurns * 2 - 1);
    expect(w.toSummarize.length).toBeGreaterThan(0);
    expect(w.keptMessageIds.length / 2).toBeLessThanOrEqual(base.recentTurns);
  });

  it('ignores a summary pointing at an unknown message', () => {
    const history = conversation(2);
    const w = buildContextWindow({ ...base, history, summary: summaryOf('gone'), budget: 16_000 });
    expect(w.keptMessageIds).toHaveLength(4);
    expect(w.messages[0]!.role).toBe('system');
  });

  it('shortens an oversized last turn and flags it truncated', () => {
    seq = 0;
    const history = [
      msg('user', 'primeira'),
      msg('assistant', 'ok'),
      msg('user', 'z'.repeat(60_000)),
      msg('assistant', 'w'.repeat(30_000)),
    ];
    const w = buildContextWindow({ ...base, history, budget: 2_000 });
    expect(w.truncated).toBe(true);
    expect(w.keptMessageIds).toEqual([history[2]!.id, history[3]!.id]);
    expect(w.toSummarize.map((m) => m.id)).toEqual([history[0]!.id, history[1]!.id]);
    expect(tokensOf(w)).toBeLessThan(5_000);
  });

  it('cuts the middle of a huge user message but keeps head and tail', () => {
    seq = 0;
    const content = `INICIO ${'a'.repeat(30_000)} FIM`;
    const w = buildContextWindow({
      ...base,
      history: [msg('user', content), msg('assistant', 'visto')],
      budget: 100_000,
    });
    const text = String(w.messages[0]!.content);
    expect(text.startsWith('INICIO')).toBe(true);
    expect(text.endsWith('FIM')).toBe(true);
    expect(text).toContain(OMITTED_MARK);
    expect(text.length).toBeLessThan(11_000);
  });
});

describe('renderHistoryMessages', () => {
  it('flattens tool calls into assistant text, never role=tool', () => {
    seq = 0;
    const turn = [
      msg('user', 'consulte'),
      msg('assistant', 'Feito.', {
        toolCalls: [
          { id: 't1', name: 'db__query', input: { sql: 'select 1' }, output: 'o'.repeat(5_000) },
        ],
      }),
    ];
    const last = renderHistoryMessages(turn, { isLastTurn: true });
    const older = renderHistoryMessages(turn, { isLastTurn: false });
    for (const out of [last, older]) {
      expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(out.some((m) => m.tool_calls || m.role === 'tool')).toBe(false);
      expect(String(out[1]!.content)).toContain('`db__query`');
      expect(String(out[1]!.content)).toContain('Feito.');
    }
    expect(String(last[1]!.content).length).toBeGreaterThan(String(older[1]!.content).length);
    expect(String(last[1]!.content).length).toBeLessThan(2_200);
  });

  it('skips failed answers except in the last turn', () => {
    seq = 0;
    const turn = [msg('user', 'oi'), msg('assistant', '⚠️ falhou')];
    expect(renderHistoryMessages(turn, { isLastTurn: false })).toHaveLength(1);
    expect(renderHistoryMessages(turn, { isLastTurn: true })).toHaveLength(2);
  });

  it('includes attachment excerpts (capped) and marks images', () => {
    seq = 0;
    const turn = [
      msg('user', 'analise', {
        attachments: [
          { name: 'dados.csv', mimeType: 'text/csv', excerpt: 'LINHA'.repeat(2_000) },
          { name: 'foto.png', mimeType: 'image/png' },
        ],
      }),
    ];
    const text = String(renderHistoryMessages(turn, { isLastTurn: true })[0]!.content);
    expect(text).toContain('Arquivo anexado: dados.csv');
    expect(text).toContain('[imagem anexada: foto.png]');
    expect(text.length).toBeLessThan(4_400);
  });
});

describe('summaries', () => {
  it('buildSummaryRequest carries the previous summary and compacts messages', () => {
    seq = 0;
    const [system, user] = buildSummaryRequest('antes', [
      msg('user', 'q'.repeat(5_000)),
      msg('assistant', 'r', {
        toolCalls: [{ id: '1', name: 'f', input: {}, output: 'o'.repeat(900) }],
      }),
    ]);
    expect(system!.role).toBe('system');
    const body = String(user!.content);
    expect(body).toContain('Resumo atual:\nantes');
    expect(body).toContain('[Usuário]');
    expect(body).toContain('[Assistente]');
    expect(body.length).toBeLessThan(3_500);
  });

  it('extractiveSummary appends bullets and drops the oldest ones beyond the cap', () => {
    seq = 0;
    const many = Array.from({ length: 80 }, (_, i) =>
      msg(i % 2 ? 'assistant' : 'user', `mensagem ${i} ${'.'.repeat(150)}`),
    );
    const text = extractiveSummary('- Usuário: bem antigo', many);
    expect(text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(text).toContain('mensagem 79');
    expect(text).not.toContain('bem antigo');
    expect(extractiveSummary('prévio', [msg('user', 'novo')])).toBe('prévio\n- Usuário: novo');
  });

  it('chunkForSummary keeps chunks under the limit and skips the oldest beyond 4 chunks', () => {
    seq = 0;
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg(i % 2 ? 'assistant' : 'user', `${i} ${'c'.repeat(1_900)}`),
    );
    const { skipped, chunks } = chunkForSummary(messages, 2_000);
    expect(chunks.length).toBeLessThanOrEqual(4);
    expect(skipped.length + chunks.flat().length).toBe(40);
    expect(chunks.flat().at(-1)).toBe(messages.at(-1));
    const small = chunkForSummary(messages.slice(0, 4), 6_000);
    expect(small.skipped).toEqual([]);
    expect(small.chunks).toHaveLength(1);
  });

  it('buildCarryOver wraps summary and recent exchanges within the limit', () => {
    const history = conversation(6, 600);
    const out = buildCarryOver('o resumo', groupTurns(history), 500);
    expect(out.startsWith('<contexto_anterior>')).toBe(true);
    expect(out.endsWith('</contexto_anterior>')).toBe(true);
    expect(out).toContain('Resumo: o resumo');
    expect(out).toContain('A6');
    expect(out).not.toContain('U1 ');
    expect(out.length).toBeLessThanOrEqual(500 * 4);
    expect(buildCarryOver(null, [], 500)).toBe('');
  });
});
