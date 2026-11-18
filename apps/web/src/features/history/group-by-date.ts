import type { ConversationDto } from '@thinkflow/shared';

export interface ConversationGroup {
  key: string;
  label: string;
  items: ConversationDto[];
}

const DAY = 86_400_000;
const monthFormat = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Groups (already sorted) conversations: Fixadas, Hoje, Ontem, 7/30 dias, then by month. */
export function groupByDate(items: ConversationDto[], now = Date.now()): ConversationGroup[] {
  const today = startOfDay(now);
  const groups: ConversationGroup[] = [];
  const bucket = (key: string, label: string): ConversationDto[] => {
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, label, items: [] };
      groups.push(group);
    }
    return group.items;
  };

  for (const c of items) {
    if (c.pinned) {
      bucket('pinned', 'Fixadas').push(c);
      continue;
    }
    const day = startOfDay(c.updatedAt);
    if (day >= today) bucket('today', 'Hoje').push(c);
    else if (day >= today - DAY) bucket('yesterday', 'Ontem').push(c);
    else if (day >= today - 7 * DAY) bucket('week', 'Últimos 7 dias').push(c);
    else if (day >= today - 30 * DAY) bucket('month', 'Últimos 30 dias').push(c);
    else {
      const d = new Date(c.updatedAt);
      bucket(`m-${d.getFullYear()}-${d.getMonth()}`, capitalize(monthFormat.format(d))).push(c);
    }
  }
  return groups;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
