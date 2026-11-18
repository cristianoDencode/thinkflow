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
} from './object-keys';

interface Entry {
  bytes: Uint8Array;
  contentType: string;
  metadata: Record<string, string>;
  lastModified: number;
}

export interface MemoryObjectStoreOptions {
  maxObjectBytes?: number;
  /** Time source for `lastModified` (tests drive the janitor with a fake clock). */
  now?: () => number;
}

/** In-memory ObjectStore for tests. `fail(reason)` simulates an outage. */
export class MemoryObjectStore implements ObjectStore {
  readonly driver = 'memory' as const;
  readonly location = 'memory://';
  private readonly entries = new Map<string, Entry>();
  private readonly maxObjectBytes: number;
  private readonly now: () => number;
  private failure: string | null = null;

  constructor(options: MemoryObjectStoreOptions = {}) {
    this.maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    this.now = options.now ?? (() => Date.now());
  }

  /** Makes every operation fail as an outage (`null` restores the store). */
  fail(reason: string | null = 'falha simulada'): void {
    this.failure = reason;
  }

  /** Test helpers (not part of the port). */
  has(key: string): boolean {
    return this.entries.has(key);
  }
  keys(prefix = ''): string[] {
    return [...this.entries.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  /** Sets `lastModified` of an existing object (janitor grace period tests). */
  touch(key: string, lastModified: number): void {
    const entry = this.entries.get(key);
    if (entry) entry.lastModified = lastModified;
  }
  /** Removes an object bypassing `fail()`. */
  drop(key: string): void {
    this.entries.delete(key);
  }

  private guard(): void {
    if (this.failure !== null) throw new ObjectStoreUnavailableError(this.failure);
  }

  private infoOf(key: string, entry: Entry): ObjectInfo {
    return {
      key,
      size: entry.bytes.byteLength,
      contentType: entry.contentType,
      lastModified: entry.lastModified,
      metadata: { ...entry.metadata },
    };
  }

  async put(key: string, body: Uint8Array, options: ObjectPutOptions): Promise<void> {
    assertObjectKey(key);
    assertAsciiMetadata(options.metadata);
    this.guard();
    const limit = options.maxBytes ?? this.maxObjectBytes;
    if (body.byteLength > limit) throw new ObjectTooLargeError(limit);
    this.entries.set(key, {
      bytes: new Uint8Array(body),
      contentType: options.contentType,
      metadata: { ...options.metadata },
      lastModified: this.now(),
    });
  }

  private fetch(key: string, options?: ObjectReadOptions): Entry | null {
    assertObjectKey(key);
    this.guard();
    const entry = this.entries.get(key);
    if (!entry) return null;
    const limit = options?.maxBytes ?? this.maxObjectBytes;
    if (entry.bytes.byteLength > limit) throw new ObjectTooLargeError(limit);
    return entry;
  }

  async getBytes(key: string, options?: ObjectReadOptions): Promise<Uint8Array | null> {
    const entry = this.fetch(key, options);
    return entry ? new Uint8Array(entry.bytes) : null;
  }

  async getStream(key: string, options?: ObjectReadOptions): Promise<ObjectStream | null> {
    const entry = this.fetch(key, options);
    if (!entry) return null;
    const copy = new Uint8Array(entry.bytes);
    let aborted = false;
    return {
      info: this.infoOf(key, entry),
      body: (async function* () {
        if (!aborted && copy.byteLength > 0) yield copy;
      })(),
      abort: () => {
        aborted = true;
      },
    };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertObjectKey(key);
    this.guard();
    const entry = this.entries.get(key);
    return entry ? this.infoOf(key, entry) : null;
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    this.guard();
    this.entries.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    assertObjectPrefix(prefix, { requireSlash: true });
    this.guard();
    let count = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        count++;
      }
    }
    return count;
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    assertObjectPrefix(prefix);
    this.guard();
    for (const key of this.keys(prefix)) {
      const entry = this.entries.get(key);
      if (entry) yield this.infoOf(key, entry);
    }
  }

  async check(): Promise<ObjectStoreHealth> {
    return this.failure === null
      ? { available: true, reason: null, latencyMs: 0 }
      : { available: false, reason: this.failure, latencyMs: null };
  }
}
