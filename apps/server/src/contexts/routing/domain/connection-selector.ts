import type { Connection } from '../../connections/domain/connection';

/**
 * Orders the usable connections of a provider:
 * enabled and out of cooldown, lower `priority` first; equal priorities rotate
 * by least-recently-used (so several free keys share the load).
 */
export function selectConnections(
  connections: readonly Connection[],
  options: { now: number; pinnedConnectionId?: string | null; exclude?: ReadonlySet<string> },
): Connection[] {
  const { now, pinnedConnectionId, exclude } = options;
  return connections
    .filter((c) => (pinnedConnectionId ? c.id === pinnedConnectionId : true))
    .filter((c) => c.isAvailable(now) && !exclude?.has(c.id))
    .sort((a, b) => a.priority - b.priority || (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
}
