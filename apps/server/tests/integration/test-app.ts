import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from '../../src/app';
import { UnavailableRenderer } from '../../src/contexts/reports/infrastructure/unavailable-renderer';
import { loadConfig } from '../../src/shared/infrastructure/config';
import { openDatabase, type DbHandle } from '../../src/shared/infrastructure/db/client';
import { MemoryObjectStore } from '../../src/shared/infrastructure/storage/memory-object-store';
import { UnavailablePrototypeRenderer } from '../prototypes/fake-renderer';
import { FakePgGateway } from '../databases/fake-pg-gateway';
import { FakeRecorderBrowser, FakeRunner, instantSettler } from '../testing/fake-recorder';

export interface TestApp {
  app: FastifyInstance;
  container: Awaited<ReturnType<typeof buildApp>>['container'];
  cookie: string;
  /** The test database (to inspect rows the API does not expose). */
  db: DbHandle['db'];
  /** The object store behind the generated documents (an in-memory one unless overridden). */
  store: MemoryObjectStore;
  /** Directory holding the library's original uploads. */
  libraryDir: string;
  /** NOTEBOOKLM_HOME / scratch dir of the NotebookLM integration. */
  notebookLmDir: string;
  /** Fake OS home: the CLI's own login would live in `<homeDir>/.notebooklm/...`. */
  homeDir: string;
  apiKey: string;
  close(): Promise<void>;
  api<T = unknown>(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }>;
}

/** Default OCR for tests: never starts the real (slow) Tesseract worker. */
export const silentOcr: NonNullable<BuildAppOptions['ocrEngine']> = {
  method: 'ocr-local',
  recognize: async () => '',
};

export async function createTestApp(overrides: Partial<BuildAppOptions> = {}): Promise<TestApp> {
  const handle = openDatabase(':memory:');
  const config = { ...loadConfig({}), webDir: '/nonexistent' };
  const libraryDir =
    overrides.libraryDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-lib-'));
  const notebookLmDir =
    overrides.notebookLm?.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-nlm-'));
  const homeDir =
    overrides.notebookLm?.homeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-home-'));
  const reportsDir =
    overrides.reports?.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-reports-'));
  const store = (overrides.objectStore ?? new MemoryObjectStore()) as MemoryObjectStore;
  const { app, container } = await buildApp({
    config,
    db: handle.db,
    secret: 'test-secret',
    libraryDir,
    ocrEngine: silentOcr,
    // never open a real Postgres pool from the suite
    pgGateway: new FakePgGateway(),
    ...overrides,
    // never write documents under DATA_DIR/objects from the suite
    objectStore: store,
    // never start a real Chromium or write PDFs into DATA_DIR from the suite
    reports: {
      diagramRenderer: new UnavailableRenderer(),
      pdfRenderer: new UnavailableRenderer(),
      dataDir: reportsDir,
      ...overrides.reports,
    },
    // never start a real Chromium to render prototypes
    prototypes: { renderer: new UnavailablePrototypeRenderer(), ...overrides.prototypes },
    // never open a real browser window from the suite; pretend a display exists
    tests: {
      display: { canOpenWindow: () => true },
      recorder: new FakeRecorderBrowser(),
      runner: new FakeRunner(),
      settler: instantSettler,
      ...overrides.tests,
    },
    // never touch the real ~/.notebooklm or DATA_DIR; pretend a display exists
    notebookLm: {
      env: { PATH: process.env.PATH ?? '', DISPLAY: ':99' },
      platform: 'linux',
      isContainer: () => false,
      minGapMs: 0,
      ...overrides.notebookLm,
      workDir: notebookLmDir,
      homeDir,
    },
  });

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { name: 'Alex', title: 'Analista', password: 'senha-forte-123' },
  });
  const setCookie = setup.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;

  const api = async <T>(method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { cookie },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, json: (res.body ? JSON.parse(res.body) : null) as T };
  };

  const key = await api<{ key: string }>('POST', '/api/api-keys', { name: 'tests' });

  return {
    app,
    container,
    cookie,
    db: handle.db,
    store,
    libraryDir,
    notebookLmDir,
    homeDir,
    apiKey: key.json.key,
    api,
    close: async () => {
      await app.close();
      handle.close();
      if (!overrides.libraryDir) fs.rmSync(libraryDir, { recursive: true, force: true });
      if (!overrides.reports?.dataDir) fs.rmSync(reportsDir, { recursive: true, force: true });
      if (!overrides.notebookLm?.workDir)
        fs.rmSync(notebookLmDir, { recursive: true, force: true });
      if (!overrides.notebookLm?.homeDir) fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

/** Parses an SSE body into JSON payloads (ignores [DONE]). */
export function sseEvents(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .map((frame) =>
      frame
        .split('\n')
        .find((l) => l.startsWith('data: '))
        ?.slice(6),
    )
    .filter((d): d is string => !!d && d !== '[DONE]')
    .map((d) => JSON.parse(d) as Record<string, unknown>);
}
