import { describe, expect, it, vi } from 'vitest';
import {
  IngestionQueue,
  type IngestionQueueDeps,
} from '../../src/contexts/library/application/ingestion-queue';
import { ExtractionError, type LibraryDocument } from '../../src/contexts/library/domain/library';
import type {
  ChunkIndex,
  DocumentFileStore,
  LibraryRepository,
  TextExtractor,
} from '../../src/contexts/library/domain/ports';
import { FakeClock } from '../../src/shared/kernel/clock';

function makeDoc(id: string, overrides: Partial<LibraryDocument> = {}): LibraryDocument {
  return {
    id,
    libraryId: 'lib',
    name: `${id}.txt`,
    mimeType: 'text/plain',
    kind: 'text',
    sizeBytes: 10,
    sha256: id,
    status: 'processing',
    error: null,
    extraction: null,
    pageCount: null,
    charCount: 0,
    chunkCount: 0,
    storageKey: `lib/${id}.txt`,
    remoteSourceId: null,
    remoteStatus: null,
    remoteError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function setup(
  extract: TextExtractor['extract'],
  docs: LibraryDocument[],
  libraryChars = 0,
  engines?: IngestionQueueDeps['engines'],
) {
  const store = new Map(docs.map((d) => [d.id, d]));
  const replaced: Record<string, number> = {};
  const repo = {
    findDocument: async (id: string) => store.get(id) ?? null,
    updateDocument: async (id: string, patch: Partial<LibraryDocument>) => {
      const cur = store.get(id);
      if (cur) store.set(id, { ...cur, ...patch });
    },
    documentsWithStatus: async (status: string) =>
      [...store.values()].filter((d) => d.status === status),
    documentsWithRemoteStatus: async (status: string) =>
      [...store.values()].filter((d) => d.remoteStatus === status),
    findById: async (id: string) => ({ id, engine: 'notebooklm' }),
    stats: async () => ({
      documentCount: store.size,
      readyCount: 0,
      processingCount: 0,
      errorCount: 0,
      totalChars: libraryChars,
    }),
  } as unknown as LibraryRepository;
  const index = {
    replace: async (id: string, _lib: string, chunks: unknown[]) => {
      replaced[id] = chunks.length;
    },
  } as unknown as ChunkIndex;
  const files = { read: async () => new Uint8Array([1]) } as unknown as DocumentFileStore;
  const errors: unknown[] = [];
  const queue = new IngestionQueue({
    repo,
    index,
    files,
    extractor: { extract },
    clock: new FakeClock(5),
    ...(engines ? { engines } : {}),
    onError: (e) => errors.push(e),
  });
  return { queue, store, replaced, errors };
}

const textOf =
  (text: string): TextExtractor['extract'] =>
  async () => ({
    sections: [{ text }],
    method: 'text',
    pageCount: null,
    warnings: [],
  });

describe('IngestionQueue', () => {
  it('moves a document from processing to ready with its stats', async () => {
    const { queue, store, replaced } = setup(textOf('Olá mundo.\n\nSegundo parágrafo.'), [
      makeDoc('a'),
    ]);
    queue.enqueue('a');
    await queue.whenIdle();
    const doc = store.get('a')!;
    expect(doc).toMatchObject({ status: 'ready', error: null, extraction: 'text', chunkCount: 1 });
    expect(doc.charCount).toBeGreaterThan(10);
    expect(replaced.a).toBe(1);
  });

  it('stores a friendly message when extraction fails and clears stale chunks', async () => {
    const { queue, store, replaced } = setup(async () => {
      throw new ExtractionError('PDF protegido por senha');
    }, [makeDoc('a')]);
    queue.enqueue('a');
    await queue.whenIdle();
    expect(store.get('a')).toMatchObject({ status: 'error', error: 'PDF protegido por senha' });
    expect(replaced.a).toBe(0);
  });

  it('hides unexpected failures behind a generic message and reports them', async () => {
    const { queue, store, errors } = setup(async () => {
      throw new Error('boom: internal detail');
    }, [makeDoc('a')]);
    queue.enqueue('a');
    await queue.whenIdle();
    expect(store.get('a')!.error).toBe('Falha ao processar o documento');
    expect(errors).toHaveLength(1);
  });

  it('rejects empty text (images get their own message)', async () => {
    const { queue, store } = setup(textOf('   \n\n  '), [
      makeDoc('a'),
      makeDoc('b', { kind: 'image', storageKey: 'lib/b.png' }),
    ]);
    queue.enqueue('a');
    queue.enqueue('b');
    await queue.whenIdle();
    expect(store.get('a')!.error).toMatch(/Nenhum texto encontrado/);
    expect(store.get('b')!.error).toBe('Nenhum texto reconhecido na imagem');
  });

  it('rejects text over the document limit and over the library limit', async () => {
    const huge = setup(textOf('x'.repeat(1_500_001)), [makeDoc('a')]);
    huge.queue.enqueue('a');
    await huge.queue.whenIdle();
    expect(huge.store.get('a')!.error).toMatch(/1,5 mi caracteres/);

    const full = setup(textOf('um texto qualquer'), [makeDoc('a')], 60_000_000);
    full.queue.enqueue('a');
    await full.queue.whenIdle();
    expect(full.store.get('a')!.error).toMatch(/60 mi caracteres/);
  });

  it('processes one document at a time, in order', async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const { queue } = setup(
      async (input) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        order.push(input.name);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return { sections: [{ text: 'conteúdo' }], method: 'text', pageCount: null, warnings: [] };
      },
      [makeDoc('a'), makeDoc('b'), makeDoc('c')],
    );
    for (const id of ['a', 'b', 'c', 'b']) queue.enqueue(id);
    await queue.whenIdle();
    expect(order).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(maxRunning).toBe(1);
  });

  it('resumePending re-enqueues documents left in processing', async () => {
    const { queue, store } = setup(textOf('retomado'), [
      makeDoc('a'),
      makeDoc('b', { status: 'ready' }),
    ]);
    await queue.resumePending();
    await queue.whenIdle();
    expect(store.get('a')!.status).toBe('ready');
    expect(store.get('b')!.chunkCount).toBe(0); // untouched
  });

  describe('remote lane', () => {
    const remoteEngine = (
      onIndexed: (doc: LibraryDocument) => Promise<void>,
    ): NonNullable<IngestionQueueDeps['engines']> => ({
      local: { kind: 'local', search: async () => ({ text: '', isError: false, citations: [] }) },
      notebooklm: {
        kind: 'notebooklm',
        search: async () => ({ text: '', isError: false, citations: [] }),
        onDocumentIndexed: async (_lib, doc) => onIndexed(doc),
      },
    });

    it('syncs after local indexing without blocking the next local document', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const synced: string[] = [];
      const { queue, store } = setup(
        textOf('conteúdo'),
        [makeDoc('a', { remoteStatus: 'pending' }), makeDoc('b', { remoteStatus: 'pending' })],
        0,
        remoteEngine(async (doc) => {
          if (doc.id === 'a') await gate; // a slow NotebookLM upload
          synced.push(doc.id);
        }),
      );
      queue.enqueue('a');
      queue.enqueue('b');
      await vi.waitFor(() => {
        expect(store.get('a')!.status).toBe('ready');
        expect(store.get('b')!.status).toBe('ready'); // local lane kept going
      });
      expect(synced).toEqual([]);
      release();
      await queue.whenIdle();
      expect(synced).toEqual(['a', 'b']); // one remote job at a time, in order
    });

    it('also hands over documents whose local extraction failed', async () => {
      const synced: string[] = [];
      const { queue, store } = setup(
        async () => {
          throw new ExtractionError('PDF protegido por senha');
        },
        [makeDoc('a', { remoteStatus: 'pending' })],
        0,
        remoteEngine(async (doc) => void synced.push(doc.id)),
      );
      queue.enqueue('a');
      await queue.whenIdle();
      expect(store.get('a')!.status).toBe('error');
      expect(synced).toEqual(['a']);
    });

    it('does not resync documents that are already synced (reindex)', async () => {
      const synced: string[] = [];
      const { queue } = setup(
        textOf('conteúdo'),
        [makeDoc('a', { remoteStatus: 'synced', remoteSourceId: 's' })],
        0,
        remoteEngine(async (doc) => void synced.push(doc.id)),
      );
      queue.enqueue('a');
      await queue.whenIdle();
      expect(synced).toEqual([]);
    });

    it('records a generic remote error when the engine hook throws', async () => {
      const { queue, store, errors } = setup(
        textOf('conteúdo'),
        [makeDoc('a', { remoteStatus: 'pending' })],
        0,
        remoteEngine(async () => {
          throw new Error('boom');
        }),
      );
      queue.enqueue('a');
      await queue.whenIdle();
      expect(store.get('a')).toMatchObject({ status: 'ready', remoteStatus: 'error' });
      expect(errors).toHaveLength(1);
    });

    it('resumePending re-enqueues interrupted syncs', async () => {
      const synced: string[] = [];
      const { queue } = setup(
        textOf('x'),
        [
          makeDoc('a', { status: 'ready', remoteStatus: 'syncing' }),
          makeDoc('b', { status: 'ready', remoteStatus: 'pending' }),
          makeDoc('c', { status: 'ready', remoteStatus: 'synced' }),
          makeDoc('d', { status: 'ready', remoteStatus: 'error' }),
        ],
        0,
        remoteEngine(async (doc) => void synced.push(doc.id)),
      );
      await queue.resumePending();
      await queue.whenIdle();
      expect(synced.sort()).toEqual(['a', 'b']);
    });
  });
});
