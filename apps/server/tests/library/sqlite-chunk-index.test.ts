import { afterAll, describe, expect, it } from 'vitest';
import { SqliteChunkIndex } from '../../src/contexts/library/infrastructure/sqlite-chunk-index';
import { SqliteLibraryRepository } from '../../src/contexts/library/infrastructure/sqlite-library-repository';
import { buildFtsQuery } from '../../src/contexts/library/domain/retrieval';
import type { ChunkDraft, LibraryDocument } from '../../src/contexts/library/domain/library';
import { openDatabase } from '../../src/shared/infrastructure/db/client';

const handle = openDatabase(':memory:');
afterAll(() => handle.close());

const repo = new SqliteLibraryRepository(handle.db);
const index = new SqliteChunkIndex(handle.db);

function doc(id: string, libraryId: string): LibraryDocument {
  return {
    id,
    libraryId,
    name: `${id}.md`,
    mimeType: 'text/markdown',
    kind: 'markdown',
    sizeBytes: 10,
    sha256: `hash-${id}`,
    status: 'ready',
    error: null,
    extraction: 'text',
    pageCount: null,
    charCount: 10,
    chunkCount: 1,
    storageKey: `${libraryId}/${id}.md`,
    remoteSourceId: null,
    remoteStatus: null,
    remoteError: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const chunk = (ordinal: number, text: string): ChunkDraft => ({
  ordinal,
  text,
  tokenEstimate: Math.ceil(text.length / 4),
  pageFrom: ordinal + 1,
  pageTo: ordinal + 1,
  heading: null,
});

async function seed(): Promise<void> {
  for (const id of ['l1', 'l2'])
    await repo.save({
      id,
      name: id,
      description: '',
      engine: 'local',
      remoteNotebookId: null,
      createdAt: 1,
      updatedAt: 1,
    });
  await repo.saveDocument(doc('d1', 'l1'));
  await repo.saveDocument(doc('d2', 'l2'));
  await index.replace('d1', 'l1', [
    chunk(0, 'O prazo de aprovação é de cinco dias úteis.'),
    chunk(1, 'Reembolsos dependem de nota fiscal.'),
  ]);
  await index.replace('d2', 'l2', [chunk(0, 'A aprovação em outra biblioteca.')]);
}

describe('SqliteChunkIndex', () => {
  it('matches ignoring accents, case and stemming, and isolates libraries', async () => {
    await seed();
    const q = buildFtsQuery('Aprovacoes')!;
    const hits = await index.search('l1', q.query, 10);
    expect(hits.map((h) => h.documentId)).toEqual(['d1']);
    expect(hits[0]!.text).toContain('aprovação');
    expect(hits[0]!.pageFrom).toBe(1);
    expect((await index.search('l2', q.query, 10)).map((h) => h.documentId)).toEqual(['d2']);
  });

  it('replace is idempotent and removes stale chunks', async () => {
    await index.replace('d1', 'l1', [chunk(0, 'Texto totalmente novo sobre férias.')]);
    await index.replace('d1', 'l1', [chunk(0, 'Texto totalmente novo sobre férias.')]);
    expect(await index.documentChunks('d1')).toHaveLength(1);
    expect(await index.search('l1', buildFtsQuery('aprovação')!.query, 10)).toEqual([]);
    expect(await index.search('l1', buildFtsQuery('ferias')!.query, 10)).toHaveLength(1);
  });

  it('removes documents from the FTS index on cascade delete', async () => {
    await repo.deleteDocument('d2');
    expect(await index.search('l2', buildFtsQuery('aprovação')!.query, 10)).toEqual([]);
    expect(await index.documentChunks('d2')).toEqual([]);
  });

  it('returns [] for a malformed MATCH expression and fetches neighbors in order', async () => {
    expect(await index.search('l1', '"unterminated', 5)).toEqual([]);
    expect(await index.search('l1', 'AND OR (', 5)).toEqual([]);
    await index.replace('d1', 'l1', [chunk(0, 'um'), chunk(1, 'dois'), chunk(2, 'tres')]);
    expect((await index.neighbors('d1', [2, 0])).map((c) => c.ordinal)).toEqual([0, 2]);
    expect(await index.neighbors('d1', [])).toEqual([]);
  });
});
