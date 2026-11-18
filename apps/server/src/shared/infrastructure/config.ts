import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { STORAGE_PREFIX_PATTERN } from './storage/object-keys';

/** Invalid environment. The messages are pt-BR and name variables only, never their values. */
export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuração inválida:\n${issues.map((i) => ` - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Empty strings (e.g. `${VAR:-}` in compose) count as "not set". */
const optionalText = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

const envSchema = z.object({
  PORT: optionalText,
  HOST: optionalText,
  DATA_DIR: optionalText,
  THINKFLOW_SECRET: optionalText,
  LOG_LEVEL: optionalText,
  COOKIE_SECURE: optionalText,
  WEB_DIR: optionalText,
  MIGRATIONS_DIR: optionalText,
  PRIVACY_PRESIDIO_URL: optionalText,
});

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export interface LocalStorageConfig {
  driver: 'local';
  /** Absolute directory (`STORAGE_LOCAL_DIR`, default `DATA_DIR/objects`). */
  dir: string;
  /** Key prefix (empty or `segment/…/`). */
  prefix: string;
  maxObjectBytes: number;
}

export interface S3StorageConfig {
  driver: 's3';
  prefix: string;
  maxObjectBytes: number;
  /** `http(s)://host[:port]`; undefined = AWS. */
  endpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  /** Not enumerable: never shows up in JSON, `console.log` or spreads. */
  readonly secretAccessKey: string;
  forcePathStyle: boolean;
  sse: '' | 'AES256' | 'aws:kms';
  sseKmsKeyId: string | undefined;
  createBucket: boolean;
  timeoutMs: number;
  connectTimeoutMs: number;
  maxAttempts: number;
}

export type StorageConfig = LocalStorageConfig | S3StorageConfig;

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  secret: string | undefined;
  logLevel: string;
  cookieSecure: boolean;
  webDir: string | undefined;
  migrationsDir: string | undefined;
  storage: StorageConfig;
  /** `PRIVACY_PRESIDIO_URL`: default Presidio sidecar URL while the setting is empty. */
  presidioUrl?: string | undefined;
}

/** Collects pt-BR problems while reading the storage variables. */
class StorageEnvReader {
  readonly issues: string[] = [];
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  text(name: string): string | undefined {
    const v = this.env[name];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  }

  int(name: string, fallback: number, min: number, max: number): number {
    const raw = this.text(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
      this.issues.push(`${name} inválido: use um número inteiro entre ${min} e ${max}.`);
      return fallback;
    }
    return n;
  }

  bool(name: string, fallback: boolean): boolean {
    const raw = this.text(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    this.issues.push(`${name} inválido: use true ou false.`);
    return fallback;
  }

  /** `NAME` or `NAME_FILE` (Docker/Kubernetes secrets). Required. */
  secret(name: string): string | undefined {
    const direct = this.text(name);
    const file = this.text(`${name}_FILE`);
    if (direct !== undefined && file !== undefined) {
      this.issues.push(`Defina ${name} ou ${name}_FILE, não os dois.`);
      return undefined;
    }
    if (file !== undefined) {
      try {
        const content = fs.readFileSync(file, 'utf8').trim();
        if (content === '') {
          this.issues.push(`${name}_FILE aponta para um arquivo vazio.`);
          return undefined;
        }
        return content;
      } catch {
        this.issues.push(`${name}_FILE: não foi possível ler o arquivo informado.`);
        return undefined;
      }
    }
    if (direct === undefined) {
      this.issues.push(`STORAGE_DRIVER=s3 exige ${name} (ou ${name}_FILE).`);
    }
    return direct;
  }
}

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function loadStorage(env: NodeJS.ProcessEnv, dataDir: string, issues: string[]): StorageConfig {
  const r = new StorageEnvReader(env);

  const driverRaw = r.text('STORAGE_DRIVER')?.toLowerCase() ?? 'local';
  if (driverRaw !== 'local' && driverRaw !== 's3') {
    r.issues.push('STORAGE_DRIVER inválido: use "local" ou "s3".');
  }
  const driver = driverRaw === 's3' ? 's3' : 'local';

  const prefix = r.text('STORAGE_PREFIX') ?? '';
  if (prefix !== '' && !STORAGE_PREFIX_PATTERN.test(prefix)) {
    r.issues.push(
      'STORAGE_PREFIX inválido: use pastas em minúsculas terminadas em "/" (ex.: thinkflow/).',
    );
  }
  const maxObjectBytes = r.int('STORAGE_MAX_OBJECT_MB', 100, 1, 1024) * 1024 * 1024;

  if (driver === 'local') {
    const dirRaw = r.text('STORAGE_LOCAL_DIR');
    issues.push(...r.issues);
    return {
      driver: 'local',
      dir: dirRaw ? path.resolve(dirRaw) : path.join(dataDir, 'objects'),
      prefix,
      maxObjectBytes,
    };
  }

  // --- s3 ---
  const endpointRaw = r.text('S3_ENDPOINT');
  let endpoint: string | undefined;
  if (endpointRaw !== undefined) {
    try {
      const url = new URL(endpointRaw);
      const plainPath = url.pathname === '/' || url.pathname === '';
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        !url.hostname ||
        url.username ||
        url.password ||
        !plainPath ||
        url.search ||
        url.hash
      ) {
        throw new Error('invalid');
      }
      endpoint = url.origin;
    } catch {
      r.issues.push('S3_ENDPOINT inválido: use http(s)://host:porta (ex.: http://minio:9000).');
    }
  }

  const region = r.text('S3_REGION') ?? 'us-east-1';
  if (!REGION_PATTERN.test(region)) r.issues.push('S3_REGION inválida (ex.: us-east-1).');

  const bucket = r.text('S3_BUCKET');
  if (bucket === undefined) {
    r.issues.push('STORAGE_DRIVER=s3 exige S3_BUCKET (ex.: thinkflow).');
  } else if (!BUCKET_PATTERN.test(bucket)) {
    r.issues.push(
      'S3_BUCKET inválido: use 3 a 63 caracteres (minúsculas, números, "." e "-"), começando e terminando com letra ou número.',
    );
  }

  const accessKeyId = r.secret('S3_ACCESS_KEY_ID');
  const secretAccessKey = r.secret('S3_SECRET_ACCESS_KEY');
  const forcePathStyle = r.bool('S3_FORCE_PATH_STYLE', endpoint !== undefined);

  const sseRaw = r.text('S3_SSE') ?? '';
  if (sseRaw !== '' && sseRaw !== 'AES256' && sseRaw !== 'aws:kms') {
    r.issues.push('S3_SSE inválido: use vazio, AES256 ou aws:kms.');
  }
  const sse = sseRaw === 'AES256' || sseRaw === 'aws:kms' ? sseRaw : '';
  const sseKmsKeyId = r.text('S3_SSE_KMS_KEY_ID');
  if (sse === 'aws:kms' && sseKmsKeyId === undefined) {
    r.issues.push('S3_SSE=aws:kms exige S3_SSE_KMS_KEY_ID.');
  }

  const createBucket = r.bool('S3_CREATE_BUCKET', false);
  const timeoutMs = r.int('S3_TIMEOUT_MS', 30_000, 100, 600_000);
  const connectTimeoutMs = r.int('S3_CONNECT_TIMEOUT_MS', 3_000, 100, 120_000);
  const maxAttempts = r.int('S3_MAX_ATTEMPTS', 3, 1, 10);

  issues.push(...r.issues);
  const config = {
    driver: 's3' as const,
    prefix,
    maxObjectBytes,
    endpoint,
    region,
    bucket: bucket ?? '',
    accessKeyId: accessKeyId ?? '',
    forcePathStyle,
    sse,
    sseKmsKeyId,
    createBucket,
    timeoutMs,
    connectTimeoutMs,
    maxAttempts,
  };
  return Object.defineProperty(config, 'secretAccessKey', {
    value: secretAccessKey ?? '',
    enumerable: false,
    writable: false,
  }) as S3StorageConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const issues: string[] = [];
  const parsed = envSchema.parse(env);

  let port = 3737;
  if (parsed.PORT !== undefined) {
    const n = Number(parsed.PORT);
    if (!/^\d+$/.test(parsed.PORT.trim()) || n < 1 || n > 65535) {
      issues.push('PORT inválida: use um número inteiro entre 1 e 65535.');
    } else {
      port = n;
    }
  }
  let logLevel = 'info';
  if (parsed.LOG_LEVEL !== undefined) {
    if (!LOG_LEVELS.includes(parsed.LOG_LEVEL)) {
      issues.push(`LOG_LEVEL inválido: use ${LOG_LEVELS.join(', ')}.`);
    } else {
      logLevel = parsed.LOG_LEVEL;
    }
  }

  const dataDir = path.resolve(parsed.DATA_DIR ?? './data');
  const storage = loadStorage(env, dataDir, issues);
  if (issues.length > 0) throw new ConfigError(issues);

  return {
    port,
    host: parsed.HOST ?? '127.0.0.1',
    dataDir,
    secret: parsed.THINKFLOW_SECRET || undefined,
    logLevel,
    cookieSecure: parsed.COOKIE_SECURE === 'true',
    webDir: parsed.WEB_DIR ? path.resolve(parsed.WEB_DIR) : undefined,
    migrationsDir: parsed.MIGRATIONS_DIR ? path.resolve(parsed.MIGRATIONS_DIR) : undefined,
    storage,
    presidioUrl: parsed.PRIVACY_PRESIDIO_URL?.trim(),
  };
}
