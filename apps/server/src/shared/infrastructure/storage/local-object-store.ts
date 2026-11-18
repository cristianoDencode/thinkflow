import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ObjectStoreUnavailableError,
  ObjectTooLargeError,
  type ObjectInfo,
  type ObjectPutOptions,
  type ObjectReadOptions,
  type ObjectStore,
  type ObjectStoreHealth,
  type ObjectStream,
} from '../../kernel/object-store';
import {
  DEFAULT_MAX_OBJECT_BYTES,
  assertAsciiMetadata,
  assertObjectKey,
  assertObjectPrefix,
  contentTypeFromKey,
} from './object-keys';

const TMP_DIR = '.tmp';

export interface LocalObjectStoreOptions {
  maxObjectBytes?: number;
}

/** Filesystem ObjectStore: `<root>/<key>`. Default driver; needs no configuration. */
export class LocalObjectStore implements ObjectStore {
  readonly driver = 'local' as const;
  readonly location: string;
  private readonly root: string;
  private readonly maxObjectBytes: number;

  constructor(rootDir: string, options: LocalObjectStoreOptions = {}) {
    this.root = path.resolve(rootDir);
    this.location = this.root;
    this.maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  /** Resolves the key inside the root; throws if it would escape it (defense in depth). */
  private pathOf(key: string): string {
    assertObjectKey(key);
    const full = path.resolve(this.root, ...key.split('/'));
    if (!full.startsWith(this.root + path.sep)) {
      throw new Error(`Chave de objeto fora da raiz: ${JSON.stringify(key)}`);
    }
    return full;
  }

  private unavailable(err: unknown): ObjectStoreUnavailableError {
    const code = (err as NodeJS.ErrnoException)?.code;
    const reason =
      code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
        ? `sem permissão de escrita em ${this.root}`
        : code === 'ENOSPC'
          ? `sem espaço em disco em ${this.root}`
          : `falha ao acessar o disco em ${this.root}${code ? ` (${code})` : ''}`;
    return new ObjectStoreUnavailableError(reason);
  }

  async put(key: string, body: Uint8Array, options: ObjectPutOptions): Promise<void> {
    const target = this.pathOf(key);
    assertAsciiMetadata(options.metadata);
    const limit = options.maxBytes ?? this.maxObjectBytes;
    if (body.byteLength > limit) throw new ObjectTooLargeError(limit);
    options.signal?.throwIfAborted();
    const tmpDir = path.join(this.root, TMP_DIR);
    const tmp = path.join(tmpDir, `${process.pid}-${randomBytes(6).toString('hex')}`);
    try {
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOTDIR' || code === 'EISDIR' || code === 'EEXIST') {
        throw new Error(`Conflito de chave no armazenamento local: ${JSON.stringify(key)}`, {
          cause: err,
        });
      }
      throw this.unavailable(err);
    }
  }

  private statFile(full: string): fs.Stats | null {
    try {
      const stat = fs.statSync(full);
      return stat.isFile() ? stat : null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw this.unavailable(err);
    }
  }

  private infoOf(key: string, stat: fs.Stats): ObjectInfo {
    return {
      key,
      size: stat.size,
      contentType: contentTypeFromKey(key),
      lastModified: Math.floor(stat.mtimeMs),
      metadata: {},
    };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const stat = this.statFile(this.pathOf(key));
    return stat ? this.infoOf(key, stat) : null;
  }

  async getBytes(key: string, options?: ObjectReadOptions): Promise<Uint8Array | null> {
    const full = this.pathOf(key);
    const stat = this.statFile(full);
    if (!stat) return null;
    const limit = options?.maxBytes ?? this.maxObjectBytes;
    if (stat.size > limit) throw new ObjectTooLargeError(limit);
    try {
      return new Uint8Array(fs.readFileSync(full));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw this.unavailable(err);
    }
  }

  async getStream(key: string, options?: ObjectReadOptions): Promise<ObjectStream | null> {
    const full = this.pathOf(key);
    const stat = this.statFile(full);
    if (!stat) return null;
    const limit = options?.maxBytes ?? this.maxObjectBytes;
    if (stat.size > limit) throw new ObjectTooLargeError(limit);
    const stream = fs.createReadStream(full);
    // errors reach the consumer through the body; this keeps an unconsumed, aborted stream quiet
    stream.on('error', () => undefined);
    const unavailable = (err: unknown) => this.unavailable(err);
    const body = (async function* (): AsyncGenerator<Uint8Array> {
      try {
        for await (const chunk of stream) yield chunk as Uint8Array;
      } catch (err) {
        throw unavailable(err);
      } finally {
        stream.destroy();
      }
    })();
    return {
      info: this.infoOf(key, stat),
      body,
      abort: () => stream.destroy(),
    };
  }

  async delete(key: string): Promise<void> {
    const full = this.pathOf(key);
    try {
      fs.rmSync(full, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOTDIR') throw this.unavailable(err);
      return;
    }
    this.pruneEmptyDirs(path.dirname(full));
  }

  private pruneEmptyDirs(dir: string): void {
    let current = dir;
    while (current.startsWith(this.root + path.sep)) {
      try {
        fs.rmdirSync(current); // fails (ignored) when not empty
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    assertObjectPrefix(prefix, { requireSlash: true });
    let count = 0;
    for await (const _ of this.list(prefix)) count++;
    const dir = this.pathOf(prefix.slice(0, -1));
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      throw this.unavailable(err);
    }
    this.pruneEmptyDirs(path.dirname(dir));
    return count;
  }

  private walk(dir: string, relative: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw this.unavailable(err);
    }
    for (const entry of entries) {
      // keys never start with "." so root-level dot entries (.tmp, .probe) are not objects
      if (relative === '' && entry.name.startsWith('.')) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) this.walk(path.join(dir, entry.name), rel, out);
      else if (entry.isFile()) out.push(rel);
    }
  }

  async *list(prefix: string, options?: { signal?: AbortSignal }): AsyncIterable<ObjectInfo> {
    assertObjectPrefix(prefix);
    const slash = prefix.lastIndexOf('/');
    const dirPart = slash >= 0 ? prefix.slice(0, slash) : '';
    const startDir = dirPart ? this.pathOf(dirPart) : this.root;
    const keys: string[] = [];
    this.walk(startDir, dirPart, keys);
    keys.sort();
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      options?.signal?.throwIfAborted();
      const stat = this.statFile(this.pathOf(key));
      if (stat) yield this.infoOf(key, stat);
    }
  }

  async check(): Promise<ObjectStoreHealth> {
    const started = Date.now();
    const probe = path.join(this.root, '.probe');
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const token = randomBytes(8);
      fs.writeFileSync(probe, token, { mode: 0o600 });
      const same = Buffer.compare(fs.readFileSync(probe), token) === 0;
      fs.rmSync(probe, { force: true });
      if (!same) throw new Error('probe mismatch');
      return { available: true, reason: null, latencyMs: Date.now() - started };
    } catch (err) {
      return { available: false, reason: this.unavailable(err).reason, latencyMs: null };
    }
  }
}
