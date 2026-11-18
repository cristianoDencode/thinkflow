import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  type S3StorageConfig,
} from '../../src/shared/infrastructure/config';

const SECRET = 'Sup3r_Secret!Key#1234567890';

const s3Env = {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'http://minio:9000',
  S3_BUCKET: 'thinkflow',
  S3_ACCESS_KEY_ID: 'thinkflow-app',
  S3_SECRET_ACCESS_KEY: SECRET,
};

function issuesOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).issues;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig: base settings', () => {
  it('has working defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      port: 3737,
      host: '127.0.0.1',
      logLevel: 'info',
      cookieSecure: false,
      secret: undefined,
    });
    expect(config.dataDir).toBe(path.resolve('./data'));
  });

  it('reads the base variables and treats empty strings as unset', () => {
    const config = loadConfig({
      PORT: '8080',
      HOST: '0.0.0.0',
      DATA_DIR: '/var/lib/thinkflow',
      LOG_LEVEL: 'debug',
      COOKIE_SECURE: 'true',
      THINKFLOW_SECRET: '',
      WEB_DIR: '',
    });
    expect(config).toMatchObject({
      port: 8080,
      host: '0.0.0.0',
      dataDir: path.resolve('/var/lib/thinkflow'),
      logLevel: 'debug',
      cookieSecure: true,
      secret: undefined,
      webDir: undefined,
    });
    expect(loadConfig({ PORT: '' }).port).toBe(3737);
  });

  it('reports invalid PORT and LOG_LEVEL in pt-BR', () => {
    expect(issuesOf({ PORT: 'abc', LOG_LEVEL: 'loud' })).toEqual([
      'PORT inválida: use um número inteiro entre 1 e 65535.',
      expect.stringMatching(/^LOG_LEVEL inválido: use fatal, error/),
    ]);
    expect(issuesOf({ PORT: '70000' })[0]).toMatch(/^PORT inválida/);
  });
});

describe('loadConfig: storage', () => {
  it('defaults to the local driver under DATA_DIR/objects', () => {
    const config = loadConfig({ DATA_DIR: '/data' });
    expect(config.storage).toEqual({
      driver: 'local',
      dir: path.resolve('/data/objects'),
      prefix: '',
      maxObjectBytes: 100 * 1024 * 1024,
    });
  });

  it('honors STORAGE_LOCAL_DIR, STORAGE_PREFIX and STORAGE_MAX_OBJECT_MB', () => {
    const config = loadConfig({
      DATA_DIR: '/data',
      STORAGE_LOCAL_DIR: '/mnt/docs',
      STORAGE_PREFIX: 'prod/thinkflow/',
      STORAGE_MAX_OBJECT_MB: '8',
    });
    expect(config.storage).toMatchObject({
      driver: 'local',
      dir: path.resolve('/mnt/docs'),
      prefix: 'prod/thinkflow/',
      maxObjectBytes: 8 * 1024 * 1024,
    });
  });

  it('does not require any S3 variable for the local driver', () => {
    expect(loadConfig({ STORAGE_DRIVER: 'local', S3_BUCKET: 'Inválido!!' }).storage.driver).toBe(
      'local',
    );
  });

  it('builds the s3 config with its defaults', () => {
    const storage = loadConfig(s3Env).storage as S3StorageConfig;
    expect(storage).toMatchObject({
      driver: 's3',
      endpoint: 'http://minio:9000',
      region: 'us-east-1',
      bucket: 'thinkflow',
      accessKeyId: 'thinkflow-app',
      forcePathStyle: true,
      sse: '',
      sseKmsKeyId: undefined,
      createBucket: false,
      timeoutMs: 30_000,
      connectTimeoutMs: 3_000,
      maxAttempts: 3,
      prefix: '',
    });
    expect(storage.secretAccessKey).toBe(SECRET);
  });

  it('forcePathStyle defaults to true with an endpoint and false without (AWS)', () => {
    const { S3_ENDPOINT: _drop, ...aws } = s3Env;
    expect((loadConfig(aws).storage as S3StorageConfig).forcePathStyle).toBe(false);
    expect((loadConfig(aws).storage as S3StorageConfig).endpoint).toBeUndefined();
    expect(
      (loadConfig({ ...s3Env, S3_FORCE_PATH_STYLE: 'false' }).storage as S3StorageConfig)
        .forcePathStyle,
    ).toBe(false);
  });

  it('normalizes the endpoint and reads the tuning variables', () => {
    const storage = loadConfig({
      ...s3Env,
      S3_ENDPOINT: 'https://s3.example.com:9443/',
      S3_REGION: 'sa-east-1',
      S3_CREATE_BUCKET: 'true',
      S3_SSE: 'aws:kms',
      S3_SSE_KMS_KEY_ID: 'alias/thinkflow',
      S3_TIMEOUT_MS: '5000',
      S3_CONNECT_TIMEOUT_MS: '1000',
      S3_MAX_ATTEMPTS: '5',
    }).storage as S3StorageConfig;
    expect(storage).toMatchObject({
      endpoint: 'https://s3.example.com:9443',
      region: 'sa-east-1',
      createBucket: true,
      sse: 'aws:kms',
      sseKmsKeyId: 'alias/thinkflow',
      timeoutMs: 5000,
      connectTimeoutMs: 1000,
      maxAttempts: 5,
    });
  });

  it('reads the credentials from *_FILE (Docker secrets), trimming the newline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-cfg-'));
    fs.writeFileSync(path.join(dir, 'id'), 'file-access-id\n');
    fs.writeFileSync(path.join(dir, 'secret'), `${SECRET}\n`);
    const { S3_ACCESS_KEY_ID: _a, S3_SECRET_ACCESS_KEY: _b, ...rest } = s3Env;
    const storage = loadConfig({
      ...rest,
      S3_ACCESS_KEY_ID_FILE: path.join(dir, 'id'),
      S3_SECRET_ACCESS_KEY_FILE: path.join(dir, 'secret'),
    }).storage as S3StorageConfig;
    expect(storage.accessKeyId).toBe('file-access-id');
    expect(storage.secretAccessKey).toBe(SECRET);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the secret out of JSON, inspect and spreads', () => {
    const config = loadConfig(s3Env);
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(inspect(config, { depth: 5 })).not.toContain(SECRET);
    expect(JSON.stringify({ ...config.storage })).not.toContain(SECRET);
    expect((config.storage as S3StorageConfig).secretAccessKey).toBe(SECRET);
  });
});

describe('loadConfig: storage errors (pt-BR, never with values)', () => {
  it('lists every missing required variable at once', () => {
    expect(issuesOf({ STORAGE_DRIVER: 's3' })).toEqual([
      'STORAGE_DRIVER=s3 exige S3_BUCKET (ex.: thinkflow).',
      'STORAGE_DRIVER=s3 exige S3_ACCESS_KEY_ID (ou S3_ACCESS_KEY_ID_FILE).',
      'STORAGE_DRIVER=s3 exige S3_SECRET_ACCESS_KEY (ou S3_SECRET_ACCESS_KEY_FILE).',
    ]);
  });

  it('rejects an unknown driver', () => {
    expect(issuesOf({ STORAGE_DRIVER: 'gcs' })).toEqual([
      'STORAGE_DRIVER inválido: use "local" ou "s3".',
    ]);
  });

  it.each([
    ['not a URL', 'minio:9000'],
    ['wrong scheme', 'ftp://minio:9000'],
    ['with credentials', `http://admin:${SECRET}@minio:9000`],
    ['with a path', 'http://minio:9000/bucket'],
    ['garbage', 'not a url'],
  ])('rejects S3_ENDPOINT %s', (_name, endpoint) => {
    const issues = issuesOf({ ...s3Env, S3_ENDPOINT: endpoint });
    expect(issues).toEqual([
      'S3_ENDPOINT inválido: use http(s)://host:porta (ex.: http://minio:9000).',
    ]);
  });

  it('validates bucket, region, prefix, booleans, numbers and SSE', () => {
    const issues = issuesOf({
      ...s3Env,
      S3_BUCKET: 'Bucket_Inválido',
      S3_REGION: 'região',
      STORAGE_PREFIX: 'Pasta',
      STORAGE_MAX_OBJECT_MB: '0',
      S3_FORCE_PATH_STYLE: 'talvez',
      S3_CREATE_BUCKET: 'sim',
      S3_TIMEOUT_MS: 'x',
      S3_CONNECT_TIMEOUT_MS: '1',
      S3_MAX_ATTEMPTS: '99',
      S3_SSE: 'rot13',
    });
    expect(issues).toHaveLength(10);
    expect(issues.join('\n')).toMatch(/S3_BUCKET inválido/);
    expect(issues.join('\n')).toMatch(/S3_REGION inválida/);
    expect(issues.join('\n')).toMatch(/STORAGE_PREFIX inválido/);
    expect(issues.join('\n')).toMatch(
      /STORAGE_MAX_OBJECT_MB inválido: use um número inteiro entre 1 e 1024/,
    );
    expect(issues.join('\n')).toMatch(/S3_FORCE_PATH_STYLE inválido: use true ou false/);
    expect(issues.join('\n')).toMatch(/S3_CREATE_BUCKET inválido/);
    expect(issues.join('\n')).toMatch(/S3_TIMEOUT_MS inválido/);
    expect(issues.join('\n')).toMatch(/S3_CONNECT_TIMEOUT_MS inválido/);
    expect(issues.join('\n')).toMatch(/S3_MAX_ATTEMPTS inválido/);
    expect(issues.join('\n')).toMatch(/S3_SSE inválido/);
  });

  it('requires a KMS key id with aws:kms', () => {
    expect(issuesOf({ ...s3Env, S3_SSE: 'aws:kms' })).toEqual([
      'S3_SSE=aws:kms exige S3_SSE_KMS_KEY_ID.',
    ]);
  });

  it('rejects both a variable and its _FILE, unreadable and empty files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-cfg-'));
    fs.writeFileSync(path.join(dir, 'empty'), '\n');
    expect(issuesOf({ ...s3Env, S3_SECRET_ACCESS_KEY_FILE: path.join(dir, 'x') })).toEqual([
      'Defina S3_SECRET_ACCESS_KEY ou S3_SECRET_ACCESS_KEY_FILE, não os dois.',
    ]);
    const { S3_SECRET_ACCESS_KEY: _s, ...rest } = s3Env;
    expect(issuesOf({ ...rest, S3_SECRET_ACCESS_KEY_FILE: path.join(dir, 'missing') })).toEqual([
      'S3_SECRET_ACCESS_KEY_FILE: não foi possível ler o arquivo informado.',
    ]);
    expect(issuesOf({ ...rest, S3_SECRET_ACCESS_KEY_FILE: path.join(dir, 'empty') })).toEqual([
      'S3_SECRET_ACCESS_KEY_FILE aponta para um arquivo vazio.',
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never leaks a secret or invalid value through the error', () => {
    const attempts: NodeJS.ProcessEnv[] = [
      { ...s3Env, S3_ENDPOINT: `http://admin:${SECRET}@minio:9000/x` },
      { ...s3Env, S3_BUCKET: SECRET },
      { ...s3Env, S3_SSE: SECRET },
      { ...s3Env, S3_TIMEOUT_MS: SECRET },
      { ...s3Env, STORAGE_DRIVER: SECRET },
      { ...s3Env, S3_REGION: SECRET },
      { ...s3Env, STORAGE_PREFIX: SECRET },
    ];
    for (const env of attempts) {
      let caught: unknown;
      try {
        loadConfig(env);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const error = caught as ConfigError;
      expect(error.message).not.toContain(SECRET);
      expect(JSON.stringify(error.issues)).not.toContain(SECRET);
      expect(inspect(error)).not.toContain(SECRET);
    }
  });

  it('formats the message for the console', () => {
    try {
      loadConfig({ STORAGE_DRIVER: 's3', S3_BUCKET: 'thinkflow', S3_ACCESS_KEY_ID: 'a' });
    } catch (err) {
      expect((err as ConfigError).message).toBe(
        'Configuração inválida:\n - STORAGE_DRIVER=s3 exige S3_SECRET_ACCESS_KEY (ou S3_SECRET_ACCESS_KEY_FILE).',
      );
      return;
    }
    throw new Error('expected ConfigError');
  });
});
