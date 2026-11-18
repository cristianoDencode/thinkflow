import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ObjectDocumentFileStore,
  migrateLegacyLibraryFiles,
} from '../../src/contexts/library/infrastructure/object-document-file-store';
import { MemoryObjectStore } from '../../src/shared/infrastructure/storage/memory-object-store';
import {
  ObjectStoreUnavailableError,
  ObjectTooLargeError,
} from '../../src/shared/kernel/object-store';
import { scopeObjectStore } from '../../src/shared/kernel/scoped-object-store';

const LIB = '7f1c2d3e-0000-4000-8000-000000000001';
const DOC = '7f1c2d3e-0000-4000-8000-000000000002';
const bytes = new TextEncoder().encode('conteúdo');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-libfiles-'));
  dirs.push(dir);
  return dir;
};

function make(options: { legacyDir?: string; maxBytes?: number } = {}) {
  const inner = new MemoryObjectStore();
  const store = scopeObjectStore(inner, 'tf/', 'library');
  const files = new ObjectDocumentFileStore({
    store,
    health: () => inner.check(),
    ...options,
  });
  return { inner, store, files };
}

describe('ObjectDocumentFileStore', () => {
  it('stores originals under <prefix>library/<lib>/<doc>.<ext> with type and metadata', async () => {
    const { inner, files } = make();
    const key = await files.put(LIB, DOC, 'pdf', bytes, { contentType: 'application/pdf' });
    expect(key).toBe(`${LIB}/${DOC}.pdf`);
    const info = await inner.head(`tf/library/${key}`);
    expect(info).toMatchObject({ contentType: 'application/pdf', size: bytes.byteLength });
    expect(info!.metadata).toMatchObject({ 'library-id': LIB, 'doc-id': DOC, app: 'thinkflow' });
    expect(info!.metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([...(await files.read(key))]).toEqual([...bytes]);

    await files.delete(key);
    await expect(files.read(key)).rejects.toThrow('não encontrado');
  });

  it('deletes a whole library without touching the others', async () => {
    const { files } = make();
    const other = '7f1c2d3e-0000-4000-8000-000000000009';
    const a = await files.put(LIB, DOC, 'md', bytes);
    const b = await files.put(other, DOC, 'md', bytes);
    await files.deleteLibrary(LIB);
    await expect(files.read(a)).rejects.toThrow();
    expect(await files.read(b)).toBeTruthy();
  });

  it('rejects ids and keys that the app would never generate', async () => {
    const { files } = make();
    await expect(files.put('../x', DOC, 'pdf', bytes)).rejects.toThrow('inválido');
    await expect(files.put(LIB, 'Doc Name', 'pdf', bytes)).rejects.toThrow('inválido');
    await expect(files.read('../../etc/passwd')).rejects.toThrow('inválido');
  });

  it('refuses writes while the storage is down and enforces the size limit', async () => {
    const { inner, files } = make({ maxBytes: 4 });
    await expect(files.put(LIB, DOC, 'pdf', bytes)).rejects.toBeInstanceOf(ObjectTooLargeError);
    inner.fail('fora do ar');
    await expect(files.assertWritable()).rejects.toBeInstanceOf(ObjectStoreUnavailableError);
    inner.fail(null);
    await expect(files.assertWritable()).resolves.toBeUndefined();
  });

  it('falls back to files left on disk by older versions, and deletes them too', async () => {
    const legacyDir = tmp();
    const { files } = make({ legacyDir });
    fs.mkdirSync(path.join(legacyDir, LIB));
    const file = path.join(legacyDir, LIB, `${DOC}.txt`);
    fs.writeFileSync(file, bytes);
    expect([...(await files.read(`${LIB}/${DOC}.txt`))]).toEqual([...bytes]);
    await files.delete(`${LIB}/${DOC}.txt`);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('migrateLegacyLibraryFiles', () => {
  it('moves legacy files, verifies them, removes the local copy and is idempotent', async () => {
    const legacyDir = tmp();
    const { store, inner } = make();
    fs.mkdirSync(path.join(legacyDir, LIB));
    fs.writeFileSync(path.join(legacyDir, LIB, `${DOC}.pdf`), bytes);
    fs.writeFileSync(path.join(legacyDir, LIB, 'Nome Estranho.pdf'), bytes);

    expect(await migrateLegacyLibraryFiles(legacyDir, store, { dryRun: true })).toEqual({
      migrated: 1,
      skipped: 1,
      failed: 0,
    });
    expect(await inner.head(`tf/library/${LIB}/${DOC}.pdf`)).toBeNull();

    expect(await migrateLegacyLibraryFiles(legacyDir, store)).toEqual({
      migrated: 1,
      skipped: 1,
      failed: 0,
    });
    expect(await inner.head(`tf/library/${LIB}/${DOC}.pdf`)).toMatchObject({
      contentType: 'application/pdf',
      size: bytes.byteLength,
    });
    expect(fs.existsSync(path.join(legacyDir, LIB, `${DOC}.pdf`))).toBe(false);
    // the unexpected file is left alone (and keeps its directory)
    expect(fs.readdirSync(path.join(legacyDir, LIB))).toEqual(['Nome Estranho.pdf']);
  });

  it('keeps the local file when the storage fails, and tolerates a missing directory', async () => {
    const legacyDir = tmp();
    const { store, inner } = make();
    fs.mkdirSync(path.join(legacyDir, LIB));
    fs.writeFileSync(path.join(legacyDir, LIB, `${DOC}.md`), bytes);
    inner.fail('fora do ar');
    const errors: string[] = [];
    expect(
      await migrateLegacyLibraryFiles(legacyDir, store, { onError: (_e, key) => errors.push(key) }),
    ).toEqual({ migrated: 0, skipped: 0, failed: 1 });
    expect(errors).toEqual([`${LIB}/${DOC}.md`]);
    expect(fs.existsSync(path.join(legacyDir, LIB, `${DOC}.md`))).toBe(true);

    expect(await migrateLegacyLibraryFiles(path.join(legacyDir, 'nope'), store)).toEqual({
      migrated: 0,
      skipped: 0,
      failed: 0,
    });
  });
});
