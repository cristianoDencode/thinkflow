import type {
  ObjectInfo,
  ObjectPutOptions,
  ObjectReadOptions,
  ObjectStore,
  ObjectStoreHealth,
  ObjectStream,
  StorageDriver,
} from './object-store';

/**
 * Storage policy: every module that keeps user files (uploads, generated documents, images,
 * exports) writes them through the ObjectStore, inside its own namespace:
 * `<STORAGE_PREFIX><namespace>/<app-generated ids>/<file>` (never the user's file name).
 * Secrets, caches, scratch files and queryable metadata stay out of the bucket (SQLite / disk).
 * Add the namespace here before using it, so two modules can never share keys.
 */
export const OBJECT_NAMESPACES = [
  'reports',
  'library',
  'tests',
  'documents',
  'images',
  'prototypes',
] as const;
export type ObjectNamespace = (typeof OBJECT_NAMESPACES)[number];

/** STORAGE_PREFIX: empty or `segment/` repeated (validated again by config and the adapters). */
const PREFIX_PATTERN = /^([a-z0-9][a-z0-9._-]*\/)*$/;

/**
 * Restricts `store` to the keys under `<prefix><namespace>/`: callers use relative keys and never
 * see (or reach) the keys of another namespace. `list` returns relative keys.
 */
export function scopeObjectStore(
  store: ObjectStore,
  prefix: string,
  namespace: ObjectNamespace,
): ObjectStore {
  if (!(OBJECT_NAMESPACES as readonly string[]).includes(namespace)) {
    throw new Error(`Namespace de armazenamento desconhecido: ${JSON.stringify(namespace)}`);
  }
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error(`STORAGE_PREFIX inválido: ${JSON.stringify(prefix)}`);
  }
  return new ScopedObjectStore(store, `${prefix}${namespace}/`);
}

class ScopedObjectStore implements ObjectStore {
  constructor(
    private readonly inner: ObjectStore,
    private readonly root: string,
  ) {}

  get driver(): StorageDriver {
    return this.inner.driver;
  }

  get location(): string {
    return this.inner.location;
  }

  private full(key: string): string {
    // an absolute-looking or empty key would escape or hit the namespace root itself
    if (key === '' || key.startsWith('/')) {
      throw new Error(`Chave de objeto inválida: ${JSON.stringify(key)}`);
    }
    return this.root + key;
  }

  private relative(info: ObjectInfo): ObjectInfo {
    return { ...info, key: info.key.slice(this.root.length) };
  }

  // async everywhere: a bad key surfaces as a rejected promise, like in the adapters
  async put(key: string, body: Uint8Array, options: ObjectPutOptions): Promise<void> {
    return this.inner.put(this.full(key), body, options);
  }

  async getBytes(key: string, options?: ObjectReadOptions): Promise<Uint8Array | null> {
    return this.inner.getBytes(this.full(key), options);
  }

  async getStream(key: string, options?: ObjectReadOptions): Promise<ObjectStream | null> {
    const stream = await this.inner.getStream(this.full(key), options);
    // keep the adapter's object (its body/abort may live on a prototype); only rewrite the key
    if (stream) stream.info = this.relative(stream.info);
    return stream;
  }

  async head(key: string, options?: { signal?: AbortSignal }): Promise<ObjectInfo | null> {
    const info = await this.inner.head(this.full(key), options);
    return info && this.relative(info);
  }

  async delete(key: string): Promise<void> {
    return this.inner.delete(this.full(key));
  }

  async deletePrefix(prefix: string): Promise<number> {
    // '' or '/' would wipe the whole namespace
    if (!prefix.endsWith('/') || prefix === '/' || prefix.startsWith('/')) {
      throw new Error(`Prefixo de objeto inválido: ${JSON.stringify(prefix)}`);
    }
    return this.inner.deletePrefix(this.root + prefix);
  }

  async *list(prefix: string, options?: { signal?: AbortSignal }): AsyncIterable<ObjectInfo> {
    if (prefix.startsWith('/')) throw new Error(`Prefixo inválido: ${JSON.stringify(prefix)}`);
    for await (const info of this.inner.list(this.root + prefix, options)) {
      yield this.relative(info);
    }
  }

  check(): Promise<ObjectStoreHealth> {
    return this.inner.check();
  }

  /** The scope does not own the underlying store: closing it is the composition root's job. */
  close(): void {}
}
