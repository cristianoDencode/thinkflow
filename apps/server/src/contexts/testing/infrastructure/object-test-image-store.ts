import {
  ObjectStoreUnavailableError,
  type ObjectStore,
  type ObjectStoreHealth,
  type ObjectStream,
} from '../../../shared/kernel/object-store';
import type { TestImageStore } from '../domain/ports';

/** Session images in the ObjectStore, already scoped to the `tests/` namespace. */
export class ObjectTestImageStore implements TestImageStore {
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

  stream(key: string): Promise<ObjectStream | null> {
    return this.store.getStream(key);
  }

  get(key: string): Promise<Uint8Array | null> {
    return this.store.getBytes(key);
  }

  delete(key: string): Promise<void> {
    return this.store.delete(key);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.store.deletePrefix(`${sessionId}/`);
  }
}
