import {
  ObjectStoreUnavailableError,
  type ObjectStore,
  type ObjectStoreHealth,
} from '../../../shared/kernel/object-store';
import type { PrototypeFileStore } from '../domain/ports';

/** Prototype versions in the ObjectStore, already scoped to the `prototypes/` namespace. */
export class ObjectPrototypeStore implements PrototypeFileStore {
  constructor(
    private readonly store: ObjectStore,
    private readonly health?: () => Promise<Pick<ObjectStoreHealth, 'available' | 'reason'>>,
  ) {}

  async assertWritable(): Promise<void> {
    const health = await this.health?.();
    if (health && !health.available) {
      throw new ObjectStoreUnavailableError(health.reason ?? 'sem resposta');
    }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    options: { maxBytes?: number } = {},
  ): Promise<void> {
    await this.store.put(key, bytes, {
      contentType,
      metadata: { app: 'thinkflow' },
      ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    });
  }

  get(key: string): Promise<Uint8Array | null> {
    return this.store.getBytes(key);
  }

  async has(key: string): Promise<boolean> {
    return (await this.store.head(key)) !== null;
  }

  delete(key: string): Promise<void> {
    return this.store.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.store.deletePrefix(prefix);
  }
}
