/**
 * Stable 32-bit FNV-1a hash (8 hex chars) of a diagram's trimmed source. Used as a cache key for
 * rendered diagrams and persisted repairs; invariant to leading/trailing whitespace.
 */
export function hashDiagram(code: string): string {
  const text = code.trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
