import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ObjectStoreUnavailableError,
  type ObjectStore,
  type ObjectStoreHealth,
} from '../../../shared/kernel/object-store';
import type { DocumentFileStore, DocumentFilePutOptions } from '../domain/ports';

/** App-generated ids only (uuid, lowercase): never the user's file name. */
const SAFE_SEGMENT = /^[a-z0-9_-]{1,100}$/;
const SAFE_EXT = /^[a-z0-9]{1,8}$/;
const STORAGE_KEY = /^([a-z0-9_-]{1,100})\/([a-z0-9_-]{1,100})\.([a-z0-9]{1,8})$/;

/** Extensions written by `extensionForKind` (legacy files carry no media type). */
const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

export interface ObjectDocumentFileStoreOptions {
  /** Already scoped to the `library/` namespace (`scopeObjectStore`). */
  store: ObjectStore;
  /** Pre-object-store uploads (`<dir>/<libraryId>/<docId>.<ext>`): read as a fallback until migrated. */
  legacyDir?: string;
  /** Cached storage health (StorageMonitor); uploads are refused while it is down. */
  health?: () => Promise<Pick<ObjectStoreHealth, 'available' | 'reason'>>;
  /** Per-file limit passed to the store (the library's own limit). */
  maxBytes?: number;
}

/** Original library uploads in the ObjectStore: `library/<libraryId>/<docId>.<ext>`. */
export class ObjectDocumentFileStore implements DocumentFileStore {
  private readonly legacyRoot: string | null;

  constructor(private readonly options: ObjectDocumentFileStoreOptions) {
    this.legacyRoot = options.legacyDir ? path.resolve(options.legacyDir) : null;
  }

  async assertWritable(): Promise<void> {
    const health = await this.options.health?.();
    if (health && !health.available) {
      throw new ObjectStoreUnavailableError(health.reason ?? 'sem resposta');
    }
  }

  async put(
    libraryId: string,
    docId: string,
    ext: string,
    bytes: Uint8Array,
    opts: DocumentFilePutOptions = {},
  ): Promise<string> {
    if (!SAFE_SEGMENT.test(libraryId) || !SAFE_SEGMENT.test(docId) || !SAFE_EXT.test(ext))
      throw new Error('Identificador de arquivo inválido');
    const key = `${libraryId}/${docId}.${ext}`;
    await this.options.store.put(key, bytes, {
      contentType: opts.contentType ?? 'application/octet-stream',
      metadata: {
        'library-id': libraryId,
        'doc-id': docId,
        sha256: opts.sha256 ?? createHash('sha256').update(bytes).digest('hex'),
        app: 'thinkflow',
      },
      ...(this.options.maxBytes ? { maxBytes: this.options.maxBytes } : {}),
    });
    return key;
  }

  async read(storageKey: string): Promise<Uint8Array> {
    assertStorageKey(storageKey);
    const bytes = await this.options.store.getBytes(storageKey, {
      ...(this.options.maxBytes ? { maxBytes: this.options.maxBytes } : {}),
    });
    if (bytes) return bytes;
    const legacy = await this.readLegacy(storageKey);
    if (legacy) return legacy;
    throw new Error('Arquivo original do documento não encontrado no armazenamento');
  }

  async delete(storageKey: string): Promise<void> {
    assertStorageKey(storageKey);
    await this.options.store.delete(storageKey);
    if (this.legacyRoot) await fs.rm(legacyPath(this.legacyRoot, storageKey), { force: true });
  }

  async deleteLibrary(libraryId: string): Promise<void> {
    if (!SAFE_SEGMENT.test(libraryId)) return;
    await this.options.store.deletePrefix(`${libraryId}/`);
    if (this.legacyRoot) {
      await fs.rm(path.join(this.legacyRoot, libraryId), { recursive: true, force: true });
    }
  }

  private async readLegacy(storageKey: string): Promise<Uint8Array | null> {
    if (!this.legacyRoot) return null;
    try {
      return await fs.readFile(legacyPath(this.legacyRoot, storageKey));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

function assertStorageKey(storageKey: string): void {
  if (!STORAGE_KEY.test(storageKey)) throw new Error('Caminho de arquivo inválido');
}

function legacyPath(root: string, storageKey: string): string {
  const resolved = path.resolve(root, storageKey);
  if (!resolved.startsWith(root + path.sep)) throw new Error('Caminho de arquivo inválido');
  return resolved;
}

export interface LegacyMigrationResult {
  migrated: number;
  skipped: number;
  failed: number;
}

/**
 * Moves `<legacyDir>/<libraryId>/<docId>.<ext>` into `store` (scoped to `library/`), keeping the
 * same relative key, so the documents' `storageKey` in SQLite stays valid. The local file is
 * removed only after `head` confirms the size. Idempotent; never throws (failures are counted).
 */
export async function migrateLegacyLibraryFiles(
  legacyDir: string,
  store: ObjectStore,
  options: {
    dryRun?: boolean;
    onError?: (err: unknown, key: string) => void;
  } = {},
): Promise<LegacyMigrationResult> {
  const root = path.resolve(legacyDir);
  const result: LegacyMigrationResult = { migrated: 0, skipped: 0, failed: 0 };
  let libraries: string[];
  try {
    libraries = await fs.readdir(root);
  } catch {
    return result; // nothing left from older versions
  }
  for (const libraryId of libraries) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(root, libraryId));
    } catch {
      continue; // a stray file at the root
    }
    for (const name of names) {
      const key = `${libraryId}/${name}`;
      if (!STORAGE_KEY.test(key)) {
        result.skipped += 1;
        continue;
      }
      const file = path.join(root, libraryId, name);
      try {
        if (options.dryRun) {
          result.migrated += 1;
          continue;
        }
        const bytes = await fs.readFile(file);
        const existing = await store.head(key);
        if (!existing || existing.size !== bytes.byteLength) {
          const ext = name.slice(name.lastIndexOf('.') + 1);
          await store.put(key, bytes, {
            contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
            metadata: {
              'library-id': libraryId,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              app: 'thinkflow',
            },
          });
          const stored = await store.head(key);
          if (!stored || stored.size !== bytes.byteLength) {
            throw new Error('o objeto gravado não confere com o arquivo local');
          }
        }
        await fs.rm(file, { force: true });
        result.migrated += 1;
      } catch (err) {
        result.failed += 1;
        options.onError?.(err, key);
      }
    }
    if (!options.dryRun) await fs.rmdir(path.join(root, libraryId)).catch(() => undefined);
  }
  return result;
}
