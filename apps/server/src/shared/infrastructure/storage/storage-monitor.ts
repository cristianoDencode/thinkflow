import { systemClock, type Clock } from '../../kernel/clock';
import type { ObjectStore, ObjectStoreHealth } from '../../kernel/object-store';
import type { StorageLogger } from './s3-object-store';

export interface StorageHealthSnapshot extends ObjectStoreHealth {
  /** Epoch ms of the check. */
  checkedAt: number;
}

/** Caches `ObjectStore.check()` (15 s by default) so status polling never hammers the server. */
export class StorageMonitor {
  private cached: StorageHealthSnapshot | null = null;
  private inflight: Promise<StorageHealthSnapshot> | null = null;
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly logger: StorageLogger | undefined;

  constructor(
    private readonly store: ObjectStore,
    options: { ttlMs?: number; clock?: Clock; logger?: StorageLogger } = {},
  ) {
    this.ttlMs = options.ttlMs ?? 15_000;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger;
  }

  /** Last known snapshot without any I/O (null before the first check). */
  last(): StorageHealthSnapshot | null {
    return this.cached;
  }

  /** Cached result while fresh; otherwise a new check. */
  async status(): Promise<StorageHealthSnapshot> {
    if (this.cached && this.clock.now() - this.cached.checkedAt < this.ttlMs) return this.cached;
    return this.refresh();
  }

  /** Forces a new check (concurrent calls share it). */
  refresh(): Promise<StorageHealthSnapshot> {
    this.inflight ??= this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async run(): Promise<StorageHealthSnapshot> {
    let health: ObjectStoreHealth;
    try {
      health = await this.store.check();
    } catch {
      // the port promises not to throw; stay defensive
      health = { available: false, reason: 'falha ao verificar o armazenamento', latencyMs: null };
    }
    const previous = this.cached;
    const snapshot = { ...health, checkedAt: this.clock.now() };
    this.cached = snapshot;
    if (!snapshot.available && previous?.available !== false) {
      this.logger?.warn({ reason: snapshot.reason }, 'armazenamento de documentos indisponível');
    }
    return snapshot;
  }
}
