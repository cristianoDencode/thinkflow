import type { ObjectStore } from '../../kernel/object-store';
import { contentTypeFromKey } from './object-keys';

export interface CopyObjectsResult {
  copied: number;
  /** Already in the target with the same size. */
  skipped: number;
  failed: number;
}

export interface CopyObjectsOptions {
  /** Only keys starting with this (STORAGE_PREFIX); '' copies everything. */
  prefix?: string;
  dryRun?: boolean;
  onObject?: (key: string, outcome: 'copied' | 'skipped' | 'failed', err?: unknown) => void;
}

/**
 * Copies every object of `source` into `target` with the same key (e.g. local disk → MinIO when
 * switching STORAGE_DRIVER). Idempotent: objects already present with the same size are skipped.
 * Never deletes from the source. Failures are counted, never thrown.
 */
export async function copyObjects(
  source: ObjectStore,
  target: ObjectStore,
  options: CopyObjectsOptions = {},
): Promise<CopyObjectsResult> {
  const result: CopyObjectsResult = { copied: 0, skipped: 0, failed: 0 };
  const report = (key: string, outcome: keyof CopyObjectsResult, err?: unknown) => {
    result[outcome] += 1;
    options.onObject?.(key, outcome, err);
  };
  for await (const info of source.list(options.prefix ?? '')) {
    try {
      const existing = await target.head(info.key);
      if (existing && existing.size === info.size) {
        report(info.key, 'skipped');
        continue;
      }
      if (!options.dryRun) {
        // the source already accepted it: never refuse on the store-wide size limit here
        const bytes = await source.getBytes(info.key, { maxBytes: Number.MAX_SAFE_INTEGER });
        if (!bytes) throw new Error('o objeto sumiu da origem durante a cópia');
        const full = await source.head(info.key);
        await target.put(info.key, bytes, {
          contentType:
            full?.contentType ?? contentTypeFromKey(info.key) ?? 'application/octet-stream',
          maxBytes: Number.MAX_SAFE_INTEGER,
          ...(full && Object.keys(full.metadata).length ? { metadata: full.metadata } : {}),
        });
        const stored = await target.head(info.key);
        if (!stored || stored.size !== bytes.byteLength) {
          throw new Error('o objeto gravado não confere com a origem');
        }
      }
      report(info.key, 'copied');
    } catch (err) {
      report(info.key, 'failed', err);
    }
  }
  return result;
}
