import { asc, eq } from 'drizzle-orm';
import { ctLayoutSchema } from '@thinkflow/shared';
import type { Db } from '../../../shared/infrastructure/db/client';
import { ctModels } from '../../../shared/infrastructure/db/schema';
import type { CtModel, CtModelRepository } from '../domain/ct-model';

type Row = typeof ctModels.$inferSelect;

function toModel(row: Row): CtModel {
  return {
    id: row.id,
    name: row.name,
    // validated on read: a hand-edited row cannot reach the renderers
    layout: ctLayoutSchema.parse(JSON.parse(row.layout)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SqliteCtModelRepository implements CtModelRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<CtModel[]> {
    return this.db
      .select()
      .from(ctModels)
      .orderBy(asc(ctModels.createdAt), asc(ctModels.name))
      .all()
      .map(toModel);
  }

  async find(id: string): Promise<CtModel | null> {
    const row = this.db.select().from(ctModels).where(eq(ctModels.id, id)).get();
    return row ? toModel(row) : null;
  }

  async save(model: CtModel): Promise<void> {
    const row = {
      id: model.id,
      name: model.name,
      layout: JSON.stringify(model.layout),
      createdAt: model.createdAt,
      updatedAt: model.updatedAt,
    };
    this.db
      .insert(ctModels)
      .values(row)
      .onConflictDoUpdate({ target: ctModels.id, set: row })
      .run();
  }

  async delete(id: string): Promise<void> {
    this.db.delete(ctModels).where(eq(ctModels.id, id)).run();
  }
}
