import type { ObjectStore, ObjectStream } from '../../../shared/kernel/object-store';
import {
  artifactKey,
  parseArtifactKey,
  reportPrefix,
  sha256Hex,
  versionPrefix,
} from '../domain/artifact-keys';
import type {
  ReportArtifactKind,
  ReportArtifactMeta,
  ReportArtifactRef,
  ReportArtifactStore,
} from '../domain/render-ports';

const CONTENT_TYPES: Record<ReportArtifactKind, string> = {
  html: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
};

/** `ReportArtifactStore` on top of the generic `ObjectStore` (keys: `<prefix>reports/<id>/<v>/report.<ext>`). */
export class ObjectReportArtifactStore implements ReportArtifactStore {
  constructor(
    private readonly store: ObjectStore,
    /** STORAGE_PREFIX: '' or `segment/…/`. The S3 adapter itself does not apply it. */
    private readonly prefix: string = '',
  ) {}

  key(ref: ReportArtifactRef): string {
    return artifactKey(this.prefix, ref);
  }

  async put(
    ref: ReportArtifactRef,
    bytes: Uint8Array,
    meta: ReportArtifactMeta,
    signal?: AbortSignal,
  ): Promise<void> {
    // metadata is ASCII-only and never carries the title (it can be sensitive and is not ASCII)
    const metadata: Record<string, string> = {
      'report-id': ref.reportId,
      kind: meta.kind,
      artifact: ref.artifact,
      sha256: sha256Hex(bytes),
      app: 'thinkflow',
    };
    if (meta.templateId && /^[a-zA-Z0-9._-]{1,128}$/.test(meta.templateId))
      metadata['template-id'] = meta.templateId;
    await this.store.put(this.key(ref), bytes, {
      contentType: CONTENT_TYPES[ref.artifact],
      metadata,
      ...(signal ? { signal } : {}),
    });
  }

  read(ref: ReportArtifactRef): Promise<Uint8Array | null> {
    return this.store.getBytes(this.key(ref));
  }

  stream(ref: ReportArtifactRef): Promise<ObjectStream | null> {
    return this.store.getStream(this.key(ref));
  }

  async head(ref: ReportArtifactRef, signal?: AbortSignal): Promise<{ size: number } | null> {
    const info = await this.store.head(this.key(ref), signal ? { signal } : undefined);
    return info ? { size: info.size } : null;
  }

  async exists(ref: ReportArtifactRef): Promise<boolean> {
    return (await this.store.head(this.key(ref))) !== null;
  }

  async deleteReport(reportId: string): Promise<void> {
    await this.store.deletePrefix(reportPrefix(this.prefix, reportId));
  }

  async deleteVersion(reportId: string, version: string): Promise<void> {
    await this.store.deletePrefix(versionPrefix(this.prefix, reportId, version));
  }

  async deleteOtherVersions(reportId: string, keep: string): Promise<void> {
    const keepPrefix = versionPrefix(this.prefix, reportId, keep);
    const stale: string[] = [];
    for await (const info of this.store.list(reportPrefix(this.prefix, reportId))) {
      if (!info.key.startsWith(keepPrefix)) stale.push(info.key);
    }
    for (const key of stale) await this.store.delete(key);
  }

  async *inventory(): AsyncIterable<{ reportId: string; version: string; lastModified: number }> {
    let current: { reportId: string; version: string; lastModified: number } | null = null;
    for await (const info of this.store.list(`${this.prefix}reports/`)) {
      const ref = parseArtifactKey(this.prefix, info.key);
      if (!ref) continue;
      if (current && current.reportId === ref.reportId && current.version === ref.version) {
        current.lastModified = Math.max(current.lastModified, info.lastModified);
        continue;
      }
      if (current) yield current;
      current = { reportId: ref.reportId, version: ref.version, lastModified: info.lastModified };
    }
    if (current) yield current;
  }
}
