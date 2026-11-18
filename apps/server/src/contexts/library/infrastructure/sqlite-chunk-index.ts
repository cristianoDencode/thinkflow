import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../../shared/infrastructure/db/client';
import { libraryChunks } from '../../../shared/infrastructure/db/schema';
import type { ChunkDraft, ChunkRow } from '../domain/library';
import type { ChunkIndex } from '../domain/ports';
import type { RawHit } from '../domain/retrieval';

const INSERT_BATCH = 200;

type ChunkDbRow = typeof libraryChunks.$inferSelect;

const toChunkRow = (r: ChunkDbRow): ChunkRow => ({
  id: r.id,
  documentId: r.documentId,
  libraryId: r.libraryId,
  ordinal: r.ordinal,
  text: r.text,
  tokenEstimate: r.tokenEstimate,
  pageFrom: r.pageFrom,
  pageTo: r.pageTo,
  heading: r.heading,
});

interface SearchRow {
  id: number;
  document_id: string;
  ordinal: number;
  text: string;
  heading: string | null;
  page_from: number | null;
  page_to: number | null;
  score: number;
}

/**
 * Chunk storage plus FTS5 search. The `library_chunks_fts` table (migration 0004) is kept in
 * sync by triggers, so plain inserts/deletes on `library_chunks` are all that is needed here.
 */
export class SqliteChunkIndex implements ChunkIndex {
  constructor(private readonly db: Db) {}

  async replace(documentId: string, libraryId: string, chunks: ChunkDraft[]): Promise<void> {
    this.db.transaction((tx) => {
      tx.delete(libraryChunks).where(eq(libraryChunks.documentId, documentId)).run();
      for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
        tx.insert(libraryChunks)
          .values(chunks.slice(i, i + INSERT_BATCH).map((c) => ({ ...c, documentId, libraryId })))
          .run();
      }
    });
  }

  async search(libraryId: string, ftsQuery: string, limit: number): Promise<RawHit[]> {
    let rows: SearchRow[];
    try {
      rows = this.db.all<SearchRow>(sql`
        SELECT c.id AS id, c.document_id AS document_id, c.ordinal AS ordinal, c.text AS text,
               c.heading AS heading, c.page_from AS page_from, c.page_to AS page_to,
               bm25(library_chunks_fts, 1.0, 0.4) AS score
        FROM library_chunks_fts
        JOIN library_chunks c ON c.id = library_chunks_fts.rowid
        WHERE library_chunks_fts MATCH ${ftsQuery} AND c.library_id = ${libraryId}
        ORDER BY score
        LIMIT ${limit}`);
    } catch (err) {
      if (
        err instanceof Error &&
        /fts5|syntax error|malformed match|unterminated string|no such column|unknown special query/i.test(
          err.message,
        )
      )
        return [];
      throw err;
    }
    return rows.map((r) => ({
      chunkId: r.id,
      documentId: r.document_id,
      ordinal: r.ordinal,
      text: r.text,
      heading: r.heading,
      pageFrom: r.page_from,
      pageTo: r.page_to,
      score: r.score,
    }));
  }

  async neighbors(documentId: string, ordinals: number[]): Promise<ChunkRow[]> {
    if (ordinals.length === 0) return [];
    return this.db
      .select()
      .from(libraryChunks)
      .where(
        and(eq(libraryChunks.documentId, documentId), inArray(libraryChunks.ordinal, ordinals)),
      )
      .orderBy(asc(libraryChunks.ordinal))
      .all()
      .map(toChunkRow);
  }

  async documentChunks(documentId: string): Promise<ChunkRow[]> {
    return this.db
      .select()
      .from(libraryChunks)
      .where(eq(libraryChunks.documentId, documentId))
      .orderBy(asc(libraryChunks.ordinal))
      .all()
      .map(toChunkRow);
  }
}
