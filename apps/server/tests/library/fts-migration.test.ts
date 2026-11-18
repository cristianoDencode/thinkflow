import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/shared/infrastructure/db/client';
import {
  libraries,
  libraryChunks,
  libraryDocuments,
} from '../../src/shared/infrastructure/db/schema';

describe('migrations 0003/0004 (library + FTS5)', () => {
  it('index chunks through triggers, fold accents and cascade deletes', () => {
    const { db, close } = openDatabase(':memory:');
    const now = Date.now();
    db.insert(libraries).values({ id: 'l1', name: 'L', createdAt: now, updatedAt: now }).run();
    db.insert(libraryDocuments)
      .values({
        id: 'd1',
        libraryId: 'l1',
        name: 'a.md',
        mimeType: 'text/markdown',
        kind: 'markdown',
        sizeBytes: 1,
        sha256: 'h',
        storageKey: 'l1/d1.md',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(libraryChunks)
      .values({
        documentId: 'd1',
        libraryId: 'l1',
        ordinal: 0,
        text: 'O prazo de aprovação é de 5 dias',
        tokenEstimate: 8,
      })
      .run();

    const search = (q: string) =>
      db.all<{ rowid: number }>(
        sql`SELECT rowid FROM library_chunks_fts WHERE library_chunks_fts MATCH ${q}`,
      );
    expect(search('"aprovacao"')).toHaveLength(1);

    db.update(libraryChunks).set({ text: 'texto novo' }).run();
    expect(search('"aprovacao"')).toHaveLength(0);
    expect(search('"novo"')).toHaveLength(1);

    db.delete(libraryDocuments).run(); // cascade: chunks -> FTS delete trigger
    expect(search('"novo"')).toHaveLength(0);
    close();
  });
});
