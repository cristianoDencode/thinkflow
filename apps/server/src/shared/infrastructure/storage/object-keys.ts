/** Key rules shared by every ObjectStore adapter (identical behavior in memory, local and S3). */

export const MAX_OBJECT_KEY_LENGTH = 512;

/** Lowercase, digits and `._/-`; starts with an alphanumeric. Further structure is checked below. */
export const OBJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;

/** STORAGE_PREFIX: empty or one or more `segment/` (e.g. `thinkflow/`, `prod/thinkflow/`). */
export const STORAGE_PREFIX_PATTERN = /^([a-z0-9][a-z0-9._-]*\/)+$/;

function structureProblem(value: string, allowTrailingSlash: boolean): string | null {
  if (value.length > MAX_OBJECT_KEY_LENGTH) return 'longa demais';
  if (!OBJECT_KEY_PATTERN.test(value)) return 'caracteres inválidos';
  const body = allowTrailingSlash && value.endsWith('/') ? value.slice(0, -1) : value;
  for (const segment of body.split('/')) {
    if (segment === '') return 'segmento vazio';
    if (segment === '.' || segment === '..') return 'segmento relativo';
  }
  return null;
}

export function isValidObjectKey(key: string): boolean {
  return typeof key === 'string' && structureProblem(key, false) === null;
}

/** Programming error (not a user error): throws a plain `Error`. */
export function assertObjectKey(key: string): void {
  const problem = typeof key === 'string' ? structureProblem(key, false) : 'não é texto';
  if (problem) throw new Error(`Chave de objeto inválida (${problem}): ${JSON.stringify(key)}`);
}

/**
 * Prefix for `list` (may be empty, or end anywhere) or for `deletePrefix` (`requireSlash`: must be
 * a non-empty directory-like prefix ending in `/`, so a bad call can never wipe a whole store by
 * accident or match sibling names such as `reports/1` vs `reports/10`).
 */
export function assertObjectPrefix(prefix: string, options: { requireSlash?: boolean } = {}): void {
  if (typeof prefix !== 'string') throw new Error('Prefixo de objeto inválido (não é texto).');
  if (options.requireSlash) {
    if (!prefix.endsWith('/') || prefix === '/') {
      throw new Error(
        `Prefixo de objeto inválido (deve terminar em "/"): ${JSON.stringify(prefix)}`,
      );
    }
  } else if (prefix === '') {
    return;
  }
  const problem = structureProblem(prefix, true);
  if (problem)
    throw new Error(`Prefixo de objeto inválido (${problem}): ${JSON.stringify(prefix)}`);
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
};

/** Best-effort media type from the extension (the local driver stores no metadata). */
export function contentTypeFromKey(key: string): string | null {
  const dot = key.lastIndexOf('.');
  if (dot < 0 || key.indexOf('/', dot) >= 0) return null;
  return CONTENT_TYPES[key.slice(dot + 1)] ?? null;
}

/** Metadata travels as HTTP headers (x-amz-meta-*): printable ASCII only, lowercase names. */
export function assertAsciiMetadata(metadata: Record<string, string> | undefined): void {
  for (const [name, value] of Object.entries(metadata ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(`Nome de metadado inválido: ${JSON.stringify(name)}`);
    }
    if (!/^[\x20-\x7e]*$/.test(value)) {
      throw new Error(`Valor de metadado não-ASCII para "${name}".`);
    }
  }
}

export const DEFAULT_MAX_OBJECT_BYTES = 100 * 1024 * 1024;
