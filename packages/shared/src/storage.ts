/** Object storage (generated documents): status shown in Settings and the reports screens. */
export type StorageDriverDto = 'local' | 's3' | 'memory';

export interface StorageStatusDto {
  driver: StorageDriverDto;
  /** False when the last check failed (the server still runs in degraded mode). */
  available: boolean;
  /** pt-BR, secret-free explanation when unavailable. */
  reason: string | null;
  /** Directory (local) or `endpoint/bucket` (s3); never contains credentials. */
  location: string;
  bucket: string | null;
  /** Key prefix inside the bucket/directory (empty when none). */
  prefix: string;
  /** Epoch ms of the last check (null before the first one). */
  checkedAt: number | null;
  latencyMs: number | null;
  /** Documents still waiting to be uploaded to the store. */
  pendingUploads: number;
  /** Last upload error (pt-BR), if any. */
  lastError: string | null;
}
