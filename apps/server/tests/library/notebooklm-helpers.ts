import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  NotebookLmError,
  type NotebookLmConfig,
  type NotebookLmAccountProbe,
  type NotebookLmConfigStore,
  type NotebookLmGateway,
  type NotebookLmProbeResult,
} from '../../src/contexts/library/domain/ports';

export const FAKE_CLI = fileURLToPath(
  new URL('../fixtures/fake-notebooklm-cli.mjs', import.meta.url),
);

/** `cliCommand` that runs the fake CLI with the given `--fake-*` knobs. */
export function fakeCliCommand(knobs: Record<string, string> = {}): string {
  const args = Object.entries(knobs).map(([k, v]) => `--fake-${k}=${v}`);
  // quoted: on Windows process.execPath usually lives under "C:\Program Files"
  return [`"${process.execPath}"`, `"${FAKE_CLI}"`, ...args].join(' ');
}

/** A made-up Playwright storage_state (never a real credential). */
export const fakeStorageState = (value = 'fake-cookie-value'): string =>
  JSON.stringify({
    cookies: [{ name: 'SID', value, domain: '.google.com', path: '/' }],
    origins: [],
  });

export interface FakeCliLogEntry {
  event: string;
  pid: number;
  at: number;
  argv?: string[];
  envKeys?: string[];
  home?: string | null;
  hasAuthEnv?: boolean;
  marker?: string | null;
  storage?: boolean;
  [key: string]: unknown;
}

export function readFakeCliLog(file: string): FakeCliLogEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeCliLogEntry);
}

export const starts = (log: FakeCliLogEntry[]) => log.filter((e) => e.event === 'start');

/** In-memory `NotebookLmConfigStore`. */
export class MemoryNotebookLmConfig implements NotebookLmConfigStore {
  private config: NotebookLmConfig;
  private queries = new Map<string, number>();

  constructor(patch: Partial<NotebookLmConfig> = {}) {
    this.config = {
      enabled: true,
      authJson: fakeStorageState(),
      cliCommand: fakeCliCommand(),
      plan: 'auto',
      dailyQueryLimit: null,
      detected: null,
      detectionAttemptedAt: null,
      detectionError: null,
      timeoutSec: 120,
      fallbackToLocal: true,
      credentialsUpdatedAt: Date.now(),
      lastCheck: null,
      ...patch,
    };
  }
  get(): NotebookLmConfig {
    return { ...this.config };
  }
  set(patch: Partial<NotebookLmConfig>): void {
    this.config = { ...this.config, ...patch };
  }
  countQuery(day: string): number {
    const n = (this.queries.get(day) ?? 0) + 1;
    this.queries.set(day, n);
    return n;
  }
  queriesOn(day: string): number {
    return this.queries.get(day) ?? 0;
  }
}

/** In-memory NotebookLM, same magic words as the fake CLI. Also used by the L8 engine tests. */
export class FakeNotebookLmGateway implements NotebookLmGateway {
  readonly calls: string[] = [];
  readonly notebooks = new Map<string, string>();
  readonly sources = new Map<string, { notebookId: string; title: string }>();
  /** The next call rejects with this error. */
  failNext: NotebookLmError | null = null;
  /** The last question received (the tests assert on what NotebookLM was asked). */
  lastAsk: { notebookId: string; question: string; sourceIds?: string[] } | null = null;
  private seq = 0;

  private enter(name: string): void {
    this.calls.push(name);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }

  async check() {
    this.calls.push('check');
    return {
      ok: true,
      message: 'Conectado como fake.user@example.com',
      account: 'fake.user@example.com',
    };
  }
  async refreshCredentials() {
    this.enter('refreshCredentials');
  }
  async createNotebook(title: string) {
    this.enter('createNotebook');
    const id = `nb_${++this.seq}`;
    this.notebooks.set(id, title);
    return { id };
  }
  async deleteNotebook(id: string) {
    this.enter('deleteNotebook');
    this.notebooks.delete(id);
  }
  async addSource(
    notebookId: string,
    file: { bytes: Uint8Array; fileName: string; title: string; mimeType: string },
  ) {
    this.enter('addSource');
    const id = `src_${++this.seq}`;
    this.sources.set(id, { notebookId, title: file.title });
    return { sourceId: id };
  }
  async waitSourceReady() {
    this.enter('waitSourceReady');
  }
  async deleteSource(_notebookId: string, sourceId: string) {
    this.enter('deleteSource');
    this.sources.delete(sourceId);
  }
  async ask(
    notebookId: string,
    question: string,
    opts: { sourceIds?: string[]; timeoutMs: number; signal?: AbortSignal },
  ) {
    this.enter('ask');
    if (question.includes('__RATE__')) throw new NotebookLmError('rate_limited', 'rate limited');
    if (question.includes('__AUTH__')) throw new NotebookLmError('auth', 'auth expired');
    if (question.includes('__TIMEOUT__')) throw new NotebookLmError('timeout', 'timeout');
    const inNotebook = [...this.sources]
      .filter(([, v]) => v.notebookId === notebookId)
      .map(([id]) => id);
    const ids = opts.sourceIds?.length
      ? opts.sourceIds
      : inNotebook.length
        ? inNotebook
        : ['src_fake_1'];
    this.lastAsk = { notebookId, question, sourceIds: opts.sourceIds };
    return {
      answer: `Resposta simulada [1].`,
      references: ids.map((sourceId, i) => ({
        sourceId,
        citationNumber: i + 1,
        citedText: `Trecho citado ${i + 1}`,
      })),
    };
  }
}

/** Probe that answers with a canned result and counts its calls. */
export class FakeNotebookLmProbe implements NotebookLmAccountProbe {
  calls = 0;
  constructor(public result: NotebookLmProbeResult | Error) {}
  async detect(): Promise<NotebookLmProbeResult> {
    this.calls += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

/** What the probe reports for a given plan tier (numbers from the published table). */
export const proAccount = (): NotebookLmProbeResult => ({
  ok: true,
  limits: { sourceLimit: 300, notebookLimit: 500, tier: 2 },
});
