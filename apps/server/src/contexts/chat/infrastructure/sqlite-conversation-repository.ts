import { and, asc, desc, eq, gte, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { templateKindSchema, type AgentPermission, type ChatMode } from '@thinkflow/shared';
import type { Db } from '../../../shared/infrastructure/db/client';
import { conversations, messages } from '../../../shared/infrastructure/db/schema';
import type {
  Conversation,
  ConversationListItem,
  ConversationListQuery,
  PrunedConversation,
  ConversationPatch,
  ConversationRepository,
  MessageMeta,
  StoredMessage,
} from '../domain/conversation';

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly db: Db) {}

  async list(query: ConversationListQuery): Promise<ConversationListItem[]> {
    const filters: SQL[] = [];
    if (query.q) {
      const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      filters.push(
        or(
          sql`${conversations.title} LIKE ${pattern} ESCAPE '\\'`,
          sql`EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.conversationId} = conversations.id AND ${messages.content} LIKE ${pattern} ESCAPE '\\')`,
        )!,
      );
    }
    if (query.mode) filters.push(eq(conversations.mode, query.mode));
    if (query.origin === 'chat' || query.origin === 'document') {
      filters.push(eq(conversations.mode, 'chat'));
      filters.push(
        query.origin === 'chat'
          ? isNull(conversations.presetKind)
          : isNotNull(conversations.presetKind),
      );
    } else if (query.origin) {
      filters.push(eq(conversations.mode, query.origin));
    }
    if (query.databaseId) filters.push(eq(conversations.databaseId, query.databaseId));
    if (query.from !== undefined) filters.push(gte(conversations.updatedAt, query.from));
    if (query.to !== undefined) filters.push(lte(conversations.updatedAt, query.to));
    if (query.pinned !== undefined) filters.push(eq(conversations.pinned, query.pinned));

    return this.db
      .select({
        conversation: conversations,
        messageCount: sql<number>`(SELECT count(*) FROM ${messages} WHERE ${messages.conversationId} = conversations.id)`,
        preview: sql<
          string | null
        >`(SELECT substr(${messages.content}, 1, 160) FROM ${messages} WHERE ${messages.conversationId} = conversations.id ORDER BY ${messages.createdAt} DESC, rowid DESC LIMIT 1)`,
      })
      .from(conversations)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
      .limit(query.limit)
      .offset(query.offset)
      .all()
      .map((r) => ({
        ...toConversation(r.conversation),
        messageCount: Number(r.messageCount),
        preview: r.preview ?? '',
      }));
  }

  async findById(id: string): Promise<Conversation | null> {
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    return row ? toConversation(row) : null;
  }

  async save(c: Conversation): Promise<void> {
    this.db
      .insert(conversations)
      .values(toRow(c))
      .onConflictDoUpdate({
        target: conversations.id,
        set: {
          mode: c.mode,
          model: c.model,
          agentSessionId: c.agentSessionId,
          agentCwd: c.agentCwd,
          agentPermissionMode: c.agentPermissionMode,
          libraryId: c.libraryId,
          presetKind: c.preset?.kind ?? null,
          presetTemplateId: c.preset?.templateId ?? null,
          databaseId: c.databaseId,
          updatedAt: c.updatedAt,
        },
      })
      .run();
  }

  async update(id: string, patch: ConversationPatch): Promise<void> {
    const set: Partial<typeof conversations.$inferInsert> = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.pinned !== undefined) set.pinned = patch.pinned;
    if (patch.agentSessionId !== undefined) set.agentSessionId = patch.agentSessionId;
    if (patch.agentCwd !== undefined) set.agentCwd = patch.agentCwd;
    if (patch.agentPermissionMode !== undefined)
      set.agentPermissionMode = patch.agentPermissionMode;
    if (patch.libraryId !== undefined) set.libraryId = patch.libraryId;
    if (patch.databaseId !== undefined) set.databaseId = patch.databaseId;
    if (patch.preset !== undefined) {
      set.presetKind = patch.preset?.kind ?? null;
      set.presetTemplateId = patch.preset?.templateId ?? null;
    }
    if (patch.summary !== undefined) {
      set.summary = patch.summary?.text ?? null;
      set.summaryThroughMessageId = patch.summary?.throughMessageId ?? null;
      set.summaryKind = patch.summary?.kind ?? null;
      set.summaryUpdatedAt = patch.summary?.updatedAt ?? null;
    }
    if (Object.keys(set).length === 0) return;
    this.db.update(conversations).set(set).where(eq(conversations.id, id)).run();
  }

  async pruneOldest(keep: number): Promise<PrunedConversation[]> {
    // pinned conversations count toward the limit but are never removed
    const pinned =
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(conversations)
        .where(eq(conversations.pinned, true))
        .get()?.n ?? 0;
    const rows = this.db
      .select({
        id: conversations.id,
        agentSessionId: conversations.agentSessionId,
        agentCwd: conversations.agentCwd,
      })
      .from(conversations)
      .where(eq(conversations.pinned, false))
      .orderBy(desc(conversations.updatedAt))
      .limit(Number.MAX_SAFE_INTEGER)
      .offset(Math.max(keep - pinned, 0))
      .all();
    for (const r of rows) this.db.delete(conversations).where(eq(conversations.id, r.id)).run();
    return rows;
  }

  async delete(id: string): Promise<void> {
    this.db.delete(conversations).where(eq(conversations.id, id)).run();
  }

  async messages(conversationId: string): Promise<StoredMessage[]> {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .all()
      .map(toMessage);
  }

  async addMessage(m: StoredMessage): Promise<void> {
    this.db
      .insert(messages)
      .values({ ...m, meta: JSON.stringify(m.meta) })
      .run();
  }

  async findMessage(id: string): Promise<StoredMessage | null> {
    const row = this.db.select().from(messages).where(eq(messages.id, id)).get();
    return row ? toMessage(row) : null;
  }

  async updateMessageMeta(id: string, meta: MessageMeta): Promise<void> {
    this.db
      .update(messages)
      .set({ meta: JSON.stringify(meta) })
      .where(eq(messages.id, id))
      .run();
  }
}

function toConversation(row: typeof conversations.$inferSelect): Conversation {
  const {
    summary,
    summaryThroughMessageId,
    summaryKind,
    summaryUpdatedAt,
    agentPermissionMode,
    presetKind,
    presetTemplateId,
    ...rest
  } = row;
  return {
    ...rest,
    mode: row.mode as ChatMode,
    agentPermissionMode: agentPermissionMode as AgentPermission | null,
    preset: toPreset(presetKind, presetTemplateId),
    summary:
      summary === null
        ? null
        : {
            text: summary,
            throughMessageId: summaryThroughMessageId,
            kind: summaryKind === 'llm' ? 'llm' : 'extractive',
            updatedAt: summaryUpdatedAt ?? row.updatedAt,
          },
  };
}

function toPreset(kind: string | null, templateId: string | null): Conversation['preset'] {
  const parsed = templateKindSchema.safeParse(kind);
  return parsed.success && templateId ? { kind: parsed.data, templateId } : null;
}

function toRow(c: Conversation): typeof conversations.$inferInsert {
  const { summary, preset, ...rest } = c;
  return {
    ...rest,
    presetKind: preset?.kind ?? null,
    presetTemplateId: preset?.templateId ?? null,
    summary: summary?.text ?? null,
    summaryThroughMessageId: summary?.throughMessageId ?? null,
    summaryKind: summary?.kind ?? null,
    summaryUpdatedAt: summary?.updatedAt ?? null,
  };
}

function toMessage(row: typeof messages.$inferSelect): StoredMessage {
  return {
    ...row,
    role: row.role as StoredMessage['role'],
    meta: JSON.parse(row.meta) as MessageMeta,
  };
}
