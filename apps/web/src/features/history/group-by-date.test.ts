import type { ConversationDto } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import { groupByDate } from './group-by-date';

const NOW = new Date(2026, 10, 11, 15, 0).getTime();
const at = (daysAgo: number, hour = 10) => new Date(2026, 10, 11 - daysAgo, hour, 0).getTime();

function conv(id: string, updatedAt: number, pinned = false): ConversationDto {
  return {
    id,
    title: id,
    mode: 'chat',
    model: 'm',
    createdAt: updatedAt,
    updatedAt,
    pinned,
    parentConversationId: null,
    forkedFromMessageId: null,
    messageCount: 2,
    preview: '',
    hasSummary: false,
    libraryId: null,
    preset: null,
    databaseId: null,
  };
}

describe('groupByDate', () => {
  it('splits into pinned, today, yesterday, week, month and named months', () => {
    const groups = groupByDate(
      [
        conv('fix', at(40), true),
        conv('hoje', at(0)),
        conv('ontem', at(1, 23)),
        conv('semana', at(5)),
        conv('mes', at(20)),
        conv('antigo', new Date(2026, 5, 10).getTime()),
      ],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual([
      'Fixadas',
      'Hoje',
      'Ontem',
      'Últimos 7 dias',
      'Últimos 30 dias',
      'Junho de 2026',
    ]);
    expect(groups[0]!.items.map((c) => c.id)).toEqual(['fix']);
  });

  it('returns nothing for an empty list and keeps order inside a group', () => {
    expect(groupByDate([], NOW)).toEqual([]);
    const [g] = groupByDate([conv('a', at(0, 12)), conv('b', at(0, 9))], NOW);
    expect(g!.items.map((c) => c.id)).toEqual(['a', 'b']);
  });
});
