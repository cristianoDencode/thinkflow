import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { Conversation } from '../../src/contexts/chat/domain/conversation';
import { SqliteConversationRepository } from '../../src/contexts/chat/infrastructure/sqlite-conversation-repository';
import { openDatabase, type DbHandle } from '../../src/shared/infrastructure/db/client';

let handle: DbHandle;
afterEach(() => handle?.close());

const base = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  title: 'Conversa',
  mode: 'chat',
  model: 'm',
  agentSessionId: null,
  createdAt: 1,
  updatedAt: 1,
  pinned: false,
  parentConversationId: null,
  forkedFromMessageId: null,
  summary: null,
  agentCwd: null,
  agentPermissionMode: null,
  libraryId: null,
  preset: null,
  databaseId: null,
  ...over,
});

describe('conversation preset columns', () => {
  it('persists, updates and clears the preset', async () => {
    handle = openDatabase(':memory:');
    const repo = new SqliteConversationRepository(handle.db);

    await repo.save(base({ preset: { kind: 'report', templateId: 't1' } }));
    expect((await repo.findById('c1'))?.preset).toEqual({ kind: 'report', templateId: 't1' });
    expect((await repo.list({ limit: 10, offset: 0 }))[0]?.preset).toEqual({
      kind: 'report',
      templateId: 't1',
    });

    await repo.update('c1', { preset: { kind: 'prd', templateId: 't2' } });
    expect((await repo.findById('c1'))?.preset).toEqual({ kind: 'prd', templateId: 't2' });

    // save() upserts the preset too ("undefined keeps" is decided by the service)
    await repo.save(base({ preset: null, updatedAt: 2 }));
    expect((await repo.findById('c1'))?.preset).toBeNull();

    await repo.update('c1', { preset: { kind: 'summary', templateId: 't3' } });
    await repo.update('c1', { title: 'Outro' });
    expect((await repo.findById('c1'))?.preset).toEqual({ kind: 'summary', templateId: 't3' });
    await repo.update('c1', { preset: null });
    expect((await repo.findById('c1'))?.preset).toBeNull();
  });

  it('ignores a preset whose kind is unknown', async () => {
    handle = openDatabase(':memory:');
    const repo = new SqliteConversationRepository(handle.db);
    await repo.save(base());
    handle.db.run(sql`UPDATE conversations SET preset_kind = 'x', preset_template_id = 't'`);
    expect((await repo.findById('c1'))?.preset).toBeNull();
  });
});
