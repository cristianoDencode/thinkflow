import { createHash } from 'node:crypto';
import type { ReportArtifactKind, ReportArtifactRef } from './render-ports';

const EXTENSIONS: Record<ReportArtifactKind, string> = { html: 'html', pdf: 'pdf', md: 'md' };
const VERSION_PATTERN = /^[0-9a-f]{16}$/;

/** Version segment of the object keys: the first 16 hex characters of sha256(html). */
export function artifactVersion(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 16);
}

/** Full sha256 (hex) of some bytes, stored as object metadata. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `<prefix>reports/<reportId>/` — every version of a report lives below it. */
export function reportPrefix(prefix: string, reportId: string): string {
  return `${prefix}reports/${reportId}/`;
}

export function versionPrefix(prefix: string, reportId: string, version: string): string {
  return `${reportPrefix(prefix, reportId)}${version}/`;
}

/** `<prefix>reports/<reportId>/<version>/report.<ext>` */
export function artifactKey(prefix: string, ref: ReportArtifactRef): string {
  return `${versionPrefix(prefix, ref.reportId, ref.version)}report.${EXTENSIONS[ref.artifact]}`;
}

/** Inverse of `artifactKey`; `null` for any key that does not follow the scheme. */
export function parseArtifactKey(prefix: string, key: string): ReportArtifactRef | null {
  if (!key.startsWith(`${prefix}reports/`)) return null;
  const parts = key.slice(prefix.length + 'reports/'.length).split('/');
  if (parts.length !== 3) return null;
  const [reportId, version, file] = parts as [string, string, string];
  if (!reportId || !VERSION_PATTERN.test(version)) return null;
  const artifact = (Object.keys(EXTENSIONS) as ReportArtifactKind[]).find(
    (kind) => file === `report.${EXTENSIONS[kind]}`,
  );
  return artifact ? { reportId, version, artifact } : null;
}

/** The PDF cache before the object store: a bare `<id>.pdf` file name (no directory part). */
export function isLegacyPdfKey(key: string): boolean {
  return /^[A-Za-z0-9-]+\.pdf$/.test(key);
}
