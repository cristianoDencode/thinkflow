import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../../shared/infrastructure/db/client';
import { libraries, libraryDocuments } from '../../../shared/infrastructure/db/schema';
import type {
  DocumentStatus,
  Library,
  LibraryDocument,
  LibraryStats,
  RemoteStatus,
} from '../domain/library';
import type { LibraryRepository } from '../domain/ports';

type LibraryRow = typeof libraries.$inferSelect;
type DocumentRow = typeof libraryDocuments.$inferSelect;

const toLibrary = (r: LibraryRow): Library => ({
  id: r.id,
  name: r.name,
  description: r.description,
  engine: r.engine === 'notebooklm' ? 'notebooklm' : 'local',
  remoteNotebookId: r.remoteNotebookId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toDocument = (r: DocumentRow): LibraryDocument => ({
  ...r,
  kind: r.kind as LibraryDocument['kind'],
  status: r.status as LibraryDocument['status'],
  extraction: r.extraction as LibraryDocument['extraction'],
  remoteStatus: r.remoteStatus as LibraryDocument['remoteStatus'],
});

export class SqliteLibraryRepository implements LibraryRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<Library[]> {
    return this.db.select().from(libraries).orderBy(asc(libraries.createdAt)).all().map(toLibrary);
  }

  async findById(id: string): Promise<Library | null> {
    const row = this.db.select().from(libraries).where(eq(libraries.id, id)).get();
    return row ? toLibrary(row) : null;
  }

  async findByName(name: string): Promise<Library | null> {
    const row = this.db.select().from(libraries).where(eq(libraries.name, name)).get();
    return row ? toLibrary(row) : null;
  }

  async save(library: Library): Promise<void> {
    this.db
      .insert(libraries)
      .values(library)
      .onConflictDoUpdate({ target: libraries.id, set: library })
      .run();
  }

  async delete(id: string): Promise<void> {
    this.db.delete(libraries).where(eq(libraries.id, id)).run();
  }

  async documents(libraryId: string): Promise<LibraryDocument[]> {
    return this.db
      .select()
      .from(libraryDocuments)
      .where(eq(libraryDocuments.libraryId, libraryId))
      .orderBy(asc(libraryDocuments.createdAt), asc(libraryDocuments.id))
      .all()
      .map(toDocument);
  }

  async findDocument(id: string): Promise<LibraryDocument | null> {
    const row = this.db.select().from(libraryDocuments).where(eq(libraryDocuments.id, id)).get();
    return row ? toDocument(row) : null;
  }

  async findByHash(libraryId: string, sha256: string): Promise<LibraryDocument | null> {
    const row = this.db
      .select()
      .from(libraryDocuments)
      .where(and(eq(libraryDocuments.libraryId, libraryId), eq(libraryDocuments.sha256, sha256)))
      .get();
    return row ? toDocument(row) : null;
  }

  async saveDocument(doc: LibraryDocument): Promise<void> {
    this.db
      .insert(libraryDocuments)
      .values(doc)
      .onConflictDoUpdate({ target: libraryDocuments.id, set: doc })
      .run();
  }

  async updateDocument(id: string, patch: Partial<LibraryDocument>): Promise<void> {
    const { id: _ignored, ...fields } = patch;
    if (Object.keys(fields).length === 0) return;
    this.db.update(libraryDocuments).set(fields).where(eq(libraryDocuments.id, id)).run();
  }

  async deleteDocument(id: string): Promise<void> {
    this.db.delete(libraryDocuments).where(eq(libraryDocuments.id, id)).run();
  }

  async documentsWithStatus(status: DocumentStatus): Promise<LibraryDocument[]> {
    return this.db
      .select()
      .from(libraryDocuments)
      .where(eq(libraryDocuments.status, status))
      .orderBy(asc(libraryDocuments.createdAt), asc(libraryDocuments.id))
      .all()
      .map(toDocument);
  }

  async documentsWithRemoteStatus(status: RemoteStatus): Promise<LibraryDocument[]> {
    return this.db
      .select()
      .from(libraryDocuments)
      .where(eq(libraryDocuments.remoteStatus, status))
      .orderBy(asc(libraryDocuments.createdAt), asc(libraryDocuments.id))
      .all()
      .map(toDocument);
  }

  async stats(libraryId: string): Promise<LibraryStats> {
    const rows = this.db
      .select({
        status: libraryDocuments.status,
        count: sql<number>`count(*)`,
        chars: sql<number>`coalesce(sum(${libraryDocuments.charCount}), 0)`,
      })
      .from(libraryDocuments)
      .where(eq(libraryDocuments.libraryId, libraryId))
      .groupBy(libraryDocuments.status)
      .all();
    const stats: LibraryStats = {
      documentCount: 0,
      readyCount: 0,
      processingCount: 0,
      errorCount: 0,
      totalChars: 0,
    };
    for (const r of rows) {
      stats.documentCount += r.count;
      stats.totalChars += r.chars;
      if (r.status === 'ready') stats.readyCount = r.count;
      else if (r.status === 'processing') stats.processingCount = r.count;
      else if (r.status === 'error') stats.errorCount = r.count;
    }
    return stats;
  }
}
