import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { prototypeSourceSchema, type PrototypeKind, type PrototypeSentTo } from '@thinkflow/shared';
import type { Db } from '../../../shared/infrastructure/db/client';
import {
  prototypeBlocks,
  prototypes,
  prototypeVersions,
  testSessions,
} from '../../../shared/infrastructure/db/schema';
import type { PrototypeRepository } from '../domain/ports';
import type { Prototype, PrototypeBlock, PrototypeVersion } from '../domain/prototype';

type Row = {
  p: typeof prototypes.$inferSelect;
  sessionName: string | null;
  versionCount: number;
};

function parseSource(raw: string): Prototype['source'] {
  try {
    return prototypeSourceSchema.parse(JSON.parse(raw));
  } catch {
    return prototypeSourceSchema.parse({});
  }
}

function parseSentTo(raw: string): PrototypeSentTo[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PrototypeSentTo =>
        !!e &&
        typeof e.sessionId === 'string' &&
        typeof e.stepId === 'string' &&
        typeof e.at === 'number',
    );
  } catch {
    return [];
  }
}

const toPrototype = ({ p, sessionName, versionCount }: Row): Prototype => ({
  id: p.id,
  name: p.name,
  kind: p.kind === 'template' ? 'template' : 'prototype',
  sessionId: p.sessionId,
  sessionName,
  stepId: p.stepId,
  source: parseSource(p.source),
  width: p.width,
  height: p.height,
  scrubbed: p.scrubbed,
  currentVersionId: p.currentVersionId,
  versionCount,
  thumbnailKey: p.thumbnailKey,
  renderedVersionId: p.renderedVersionId,
  renderedAt: p.renderedAt,
  renderedScale: p.renderedScale,
  sentTo: parseSentTo(p.sentTo),
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

const toVersion = (row: typeof prototypeVersions.$inferSelect): PrototypeVersion => ({
  id: row.id,
  prototypeId: row.prototypeId,
  seq: row.seq,
  note: row.note,
  width: row.width,
  height: row.height,
  bytes: row.bytes,
  createdAt: row.createdAt,
});

export class SqlitePrototypeRepository implements PrototypeRepository {
  constructor(private readonly db: Db) {}

  /** Prototype + the name of its session + how many versions it keeps. */
  private select() {
    return this.db
      .select({
        p: prototypes,
        sessionName: testSessions.name,
        versionCount: sql<number>`(select count(*) from ${prototypeVersions} where ${prototypeVersions.prototypeId} = ${prototypes.id})`,
      })
      .from(prototypes)
      .leftJoin(testSessions, eq(testSessions.id, prototypes.sessionId));
  }

  async count(): Promise<number> {
    const [row] = this.db
      .select({ n: sql<number>`count(*)` })
      .from(prototypes)
      .all();
    return row?.n ?? 0;
  }

  async list(filter: { sessionId?: string; kind?: PrototypeKind } = {}): Promise<Prototype[]> {
    const conditions: SQL[] = [];
    if (filter.sessionId) conditions.push(eq(prototypes.sessionId, filter.sessionId));
    if (filter.kind) conditions.push(eq(prototypes.kind, filter.kind));
    const query = this.select();
    const rows = (conditions.length ? query.where(and(...conditions)) : query)
      .orderBy(desc(prototypes.createdAt), desc(prototypes.id))
      .all();
    return rows.map(toPrototype);
  }

  async find(id: string): Promise<Prototype | null> {
    const row = this.select().where(eq(prototypes.id, id)).get();
    return row ? toPrototype(row) : null;
  }

  async insert(prototype: Prototype, firstVersion: PrototypeVersion): Promise<void> {
    this.db.transaction((tx) => {
      tx.insert(prototypes)
        .values({
          id: prototype.id,
          name: prototype.name,
          kind: prototype.kind,
          sessionId: prototype.sessionId,
          stepId: prototype.stepId,
          source: JSON.stringify(prototype.source),
          width: prototype.width,
          height: prototype.height,
          scrubbed: prototype.scrubbed,
          currentVersionId: prototype.currentVersionId,
          thumbnailKey: prototype.thumbnailKey,
          renderedVersionId: prototype.renderedVersionId,
          renderedAt: prototype.renderedAt,
          renderedScale: prototype.renderedScale,
          sentTo: JSON.stringify(prototype.sentTo),
          createdAt: prototype.createdAt,
          updatedAt: prototype.updatedAt,
        })
        .run();
      tx.insert(prototypeVersions).values(firstVersion).run();
    });
  }

  async addVersion(
    prototypeId: string,
    version: PrototypeVersion,
    patch: Partial<Pick<Prototype, 'name' | 'sessionId' | 'stepId'>>,
    maxVersions: number,
  ): Promise<{ dropped: string[] }> {
    return this.db.transaction((tx) => {
      tx.insert(prototypeVersions).values(version).run();
      tx.update(prototypes)
        .set({
          ...patch,
          currentVersionId: version.id,
          width: version.width,
          height: version.height,
          updatedAt: version.createdAt,
        })
        .where(eq(prototypes.id, prototypeId))
        .run();
      const all = tx
        .select({ id: prototypeVersions.id })
        .from(prototypeVersions)
        .where(eq(prototypeVersions.prototypeId, prototypeId))
        .orderBy(asc(prototypeVersions.seq))
        .all();
      const excess = all.length - maxVersions;
      if (excess <= 0) return { dropped: [] };
      // the current version is the newest, so the oldest ones are never it
      const dropped = all
        .filter((v) => v.id !== version.id)
        .slice(0, excess)
        .map((v) => v.id);
      tx.delete(prototypeVersions).where(inArray(prototypeVersions.id, dropped)).run();
      return { dropped };
    });
  }

  async replaceVersion(
    prototypeId: string,
    versionId: string,
    version: Pick<PrototypeVersion, 'width' | 'height' | 'bytes' | 'createdAt'>,
    patch: Partial<Pick<Prototype, 'name' | 'sessionId' | 'stepId'>>,
  ): Promise<void> {
    this.db.transaction((tx) => {
      tx.update(prototypeVersions)
        .set({
          width: version.width,
          height: version.height,
          bytes: version.bytes,
          createdAt: version.createdAt,
        })
        .where(
          and(eq(prototypeVersions.id, versionId), eq(prototypeVersions.prototypeId, prototypeId)),
        )
        .run();
      tx.update(prototypes)
        .set({
          ...patch,
          width: version.width,
          height: version.height,
          updatedAt: version.createdAt,
          // the PNG on disk shows the previous content of this version
          renderedVersionId: null,
        })
        .where(eq(prototypes.id, prototypeId))
        .run();
    });
  }

  async update(
    id: string,
    patch: Partial<Pick<Prototype, 'name' | 'sessionId' | 'stepId' | 'thumbnailKey'>>,
    at: number,
  ): Promise<void> {
    this.db
      .update(prototypes)
      .set({ ...patch, updatedAt: at })
      .where(eq(prototypes.id, id))
      .run();
  }

  async setRender(
    id: string,
    render: {
      thumbnailKey: string;
      renderedVersionId: string;
      renderedAt: number;
      renderedScale: number;
    },
  ): Promise<void> {
    this.db.update(prototypes).set(render).where(eq(prototypes.id, id)).run();
  }

  async setSentTo(id: string, sentTo: PrototypeSentTo[]): Promise<void> {
    this.db
      .update(prototypes)
      .set({ sentTo: JSON.stringify(sentTo) })
      .where(eq(prototypes.id, id))
      .run();
  }

  async versions(prototypeId: string): Promise<PrototypeVersion[]> {
    return this.db
      .select()
      .from(prototypeVersions)
      .where(eq(prototypeVersions.prototypeId, prototypeId))
      .orderBy(desc(prototypeVersions.seq))
      .all()
      .map(toVersion);
  }

  async findVersion(prototypeId: string, versionId: string): Promise<PrototypeVersion | null> {
    const row = this.db
      .select()
      .from(prototypeVersions)
      .where(
        and(eq(prototypeVersions.prototypeId, prototypeId), eq(prototypeVersions.id, versionId)),
      )
      .get();
    return row ? toVersion(row) : null;
  }

  async delete(id: string): Promise<void> {
    this.db.delete(prototypes).where(eq(prototypes.id, id)).run();
  }

  async blocks(): Promise<PrototypeBlock[]> {
    return this.db
      .select()
      .from(prototypeBlocks)
      .orderBy(asc(prototypeBlocks.category), desc(prototypeBlocks.createdAt))
      .all();
  }

  async countBlocks(): Promise<number> {
    const [row] = this.db
      .select({ n: sql<number>`count(*)` })
      .from(prototypeBlocks)
      .all();
    return row?.n ?? 0;
  }

  async findBlock(id: string): Promise<PrototypeBlock | null> {
    return this.db.select().from(prototypeBlocks).where(eq(prototypeBlocks.id, id)).get() ?? null;
  }

  async insertBlock(block: PrototypeBlock): Promise<void> {
    this.db.insert(prototypeBlocks).values(block).run();
  }

  async updateBlock(
    id: string,
    patch: Partial<Pick<PrototypeBlock, 'name' | 'category'>>,
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    this.db.update(prototypeBlocks).set(patch).where(eq(prototypeBlocks.id, id)).run();
  }

  async deleteBlock(id: string): Promise<void> {
    this.db.delete(prototypeBlocks).where(eq(prototypeBlocks.id, id)).run();
  }
}

/** Test sessions as seen by the prototypes (only to validate a link). */
export class SqliteSessionLookup {
  constructor(private readonly db: Db) {}

  async exists(sessionId: string): Promise<boolean> {
    return !!this.db
      .select({ id: testSessions.id })
      .from(testSessions)
      .where(eq(testSessions.id, sessionId))
      .get();
  }
}
