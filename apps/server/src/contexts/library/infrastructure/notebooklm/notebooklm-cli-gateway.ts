/**
 * NotebookLM gateway backed by the unofficial `notebooklm-py` CLI (teng-lin, MIT).
 *
 * SPIKE (Phase L7, notebooklm-py 0.8.6, verified with `--help`, the CLI source, and — against an
 * already-logged-in profile, read-only — `auth check --json`, `auth check --test --json`, `list --json`).
 * Everything below is what this adapter relies on; the port (`NotebookLmGateway`) stays stable if the
 * CLI changes and only this file needs to follow.
 *
 * Global options (before the command): `--storage PATH` (storage_state.json), `-p/--profile`.
 * Env: `NOTEBOOKLM_AUTH_JSON` (inline storage_state content, used as the auth source: `auth_source`
 * reports "NOTEBOOKLM_AUTH_JSON"), `NOTEBOOKLM_HOME` (config/context dir; replaces ~/.notebooklm).
 *
 * Commands (all with `--json`; ids may be partial prefixes):
 *   auth check --test --json
 *       exit 0 when ok, 1 otherwise; stdout JSON in both cases:
 *       { status: "ok"|"error", account: { email, authuser }, psidts: { present, expires_at },
 *         checks: { storage_exists, json_valid, cookies_present, sid_cookie, token_fetch },
 *         details: { auth_source, error|null, notebook_count, ... }, notebook_count }
 *       Without --test `checks.token_fetch` is null (local validation only). With env auth that has no
 *       "__Secure-1PSIDTS" cookie: status "error", details.error "Token fetch failed: Missing required cookies...".
 *   auth refresh [--verify]
 *       "exercises the auth path once" so Google rotates __Secure-1PSIDTS and the CLI persists the jar
 *       to the storage file. INCOMPATIBLE with NOTEBOOKLM_AUTH_JSON ("needs a writable storage_state.json",
 *       exit 1), so the gateway writes the decrypted credentials to a 0600 temp file, runs
 *       `--storage <file> auth refresh --verify` WITHOUT the env var, reads the file back, deletes it.
 *   create [-u] TITLE --json          -> { notebook: { id, title, role, created_at, ... } }
 *   delete -n NB -y --json            -> { notebook_id, success }       (without -y in --json: VALIDATION_ERROR)
 *   source add CONTENT -n NB --type file --title T --mime-type M --request-timeout S --json
 *                                     -> { source: { id, title, type, url } }
 *       (`--title` applies to uploaded files, `--mime-type` overrides extension inference.)
 *   source wait SOURCE_ID -n NB --timeout S --interval S --json
 *       exit 0 -> { source_id, title, status: "ready", status_code }
 *       exit 1 -> { source_id, status: "error"|"not_found", error }; exit 2 -> timeout
 *   source list -n NB --json          -> rows with { id, title, type, url, status, ... } (not needed: wait is enough)
 *   source delete SOURCE_ID -n NB -y --json -> { action: "delete", source_id, notebook_id, success, status }
 *   ask --prompt-file FILE -n NB [-s SRC]... --new --json --request-timeout S
 *       -> { answer: "text with [1] [2] markers", conversation_id, turn_number, is_follow_up,
 *            references: [{ source_id, citation_number, cited_text, start_char, end_char, ... }], ... }
 *       `--prompt-file` avoids argv length/quoting/leaks. `--new` starts a fresh server-side conversation
 *       (deletes the previous one; `--json` implies --yes; "no prior conversation is fine") so questions
 *       from different chats never contaminate each other.
 *   list --json                       -> { notebooks: [{ index, id, title, is_owner, role, created_at, ... }], count }
 *   login --storage PATH [--browser-timeout S] [--browser chromium|chrome|msedge] [--fresh]
 *       opens a headed browser, saves automatically once the login is detected, exit 0. Cannot run while
 *       NOTEBOOKLM_AUTH_JSON is set ("Cannot run 'login' when NOTEBOOKLM_AUTH_JSON is set", exit 1).
 *       The Playwright browser profile is created next to the storage file (`<dir>/browser_profile` when the
 *       file is named storage_state.json) -> see CliLoginRunner, which uses a throw-away directory.
 *
 * Errors with --json: stdout `{ "error": true, "code": CODE, "message": "..." }` and a non-zero exit
 * (1 for AUTH_REQUIRED/AUTH_ERROR/RATE_LIMITED/VALIDATION_ERROR/NOT_FOUND/NETWORK_ERROR..., 2 for
 * UNEXPECTED_ERROR, e.g. "Missing required cookies" when the session is gone).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  credentialsNeedRenewal,
  normalizeStorageState,
  parseSourceLimitError,
  sourceLimitMessage,
} from '../../domain/notebooklm';
import {
  NotebookLmError,
  type NotebookLmConfigStore,
  type NotebookLmErrorKind,
  type NotebookLmGateway,
} from '../../domain/ports';
import { minimalEnv, splitCommand } from './process-env';

export interface NotebookLmCliGatewayOptions {
  config: NotebookLmConfigStore;
  /** `NOTEBOOKLM_HOME` and scratch space (`<workDir>/tmp`), normally `DATA_DIR/notebooklm`. */
  workDir: string;
  env?: NodeJS.ProcessEnv;
  /** Minimum pause between two CLI processes (Google rate limits). Default 1500 ms. */
  minGapMs?: number;
  /** Extra time the process may live after the CLI's own timeout fires. Default 5000 ms. */
  killGraceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_BUFFER = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const ADD_TIMEOUT_MS = 300_000;
const REFRESH_TIMEOUT_MS = 90_000;
/** After a failed automatic renewal, do not try again for this long. */
const RENEW_RETRY_MS = 10 * 60 * 1000;

const idRef = z.object({ id: z.string().min(1) }).passthrough();
const createSchema = z.object({ notebook: idRef }).passthrough();
const addSchema = z.object({ source: idRef }).passthrough();
const referenceSchema = z
  .object({
    source_id: z.string().optional(),
    sourceId: z.string().optional(),
    citation_number: z.number().nullish(),
    citationNumber: z.number().nullish(),
    cited_text: z.string().nullish(),
    citedText: z.string().nullish(),
  })
  .passthrough();
const askSchema = z
  .object({ answer: z.string(), references: z.array(referenceSchema).nullish() })
  .passthrough();
const checkSchema = z
  .object({
    status: z.string().optional(),
    account: z.object({ email: z.string().nullish() }).passthrough().nullish(),
    checks: z.object({ token_fetch: z.boolean().nullish() }).passthrough().nullish(),
    details: z.object({ error: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();
const errorBodySchema = z
  .object({ error: z.literal(true), code: z.string().optional(), message: z.string().optional() })
  .passthrough();

const MESSAGES: Record<
  Exclude<NotebookLmErrorKind, 'unavailable' | 'cli_missing' | 'source_limit'>,
  string
> = {
  not_configured: 'NotebookLM não configurado',
  auth: 'Credenciais do NotebookLM expiradas ou inválidas. Entre novamente com o Google.',
  rate_limited: 'Limite de uso do NotebookLM atingido. Tente novamente mais tarde.',
  timeout: 'O NotebookLM demorou demais para responder.',
  bad_response: 'Resposta inesperada da CLI do NotebookLM.',
};

/** Maps a CLI failure (JSON error code + message text) to a NotebookLmError kind. */
export function classifyFailure(code: string | undefined, text: string): NotebookLmErrorKind {
  const c = (code ?? '').toUpperCase();
  if (c !== 'AUTH_REQUIRED' && c !== 'AUTH_ERROR' && parseSourceLimitError(text))
    return 'source_limit';
  if (c === 'RATE_LIMITED') return 'rate_limited';
  if (c === 'AUTH_REQUIRED' || c === 'AUTH_ERROR') return 'auth';
  if (/\b429\b|rate.?limit|quota|too many requests/i.test(text)) return 'rate_limited';
  if (
    /\bauth|login|log in|sign.?in|expired|unauthori[sz]ed|\b40[13]\b|missing required cookies|cookies?\b/i.test(
      text,
    )
  )
    return 'auth';
  return 'unavailable';
}

const shorten = (text: string, max = 240): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

function parseJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // tolerate log lines around the payload
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export class NotebookLmCliGateway implements NotebookLmGateway {
  private readonly config: NotebookLmConfigStore;
  private readonly workDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly minGapMs: number;
  private readonly killGraceMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  /** Serializes the CLI processes: one at a time. */
  private tail: Promise<void> = Promise.resolve();
  private lastEnd = 0;
  private lastRenewAttempt = 0;

  constructor(options: NotebookLmCliGatewayOptions) {
    this.config = options.config;
    this.workDir = options.workDir;
    this.env = options.env ?? process.env;
    this.minGapMs = options.minGapMs ?? 1500;
    this.killGraceMs = options.killGraceMs ?? 5000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? (() => undefined);
  }

  /* ---- port ---- */

  async check(signal?: AbortSignal): Promise<{ ok: boolean; message: string; account?: string }> {
    try {
      return await this.exclusive(signal, async () => {
        const res = await this.exec(['auth', 'check', '--test', '--json'], {
          timeoutMs: DEFAULT_TIMEOUT_MS,
          signal,
        });
        const json = parseJson(res.stdout);
        const body = checkSchema.safeParse(json);
        if (!body.success || errorBodySchema.safeParse(json).success) throw this.failure(res);
        const account = body.data.account?.email ?? undefined;
        if (res.code === 0 && body.data.status === 'ok') {
          return {
            ok: true,
            message: account ? `Conectado como ${account}` : 'Conectado ao NotebookLM',
            ...(account ? { account } : {}),
          };
        }
        const detail = body.data.details?.error ?? body.data.status ?? '';
        const kind = classifyFailure(undefined, detail);
        return {
          ok: false,
          message:
            kind === 'auth'
              ? MESSAGES.auth
              : `Falha na verificação do NotebookLM: ${shorten(detail) || 'motivo desconhecido'}`,
        };
      });
    } catch (err) {
      if (err instanceof NotebookLmError) return { ok: false, message: err.message };
      throw err;
    }
  }

  async refreshCredentials(signal?: AbortSignal): Promise<void> {
    await this.exclusive(signal, () => this.doRefresh(signal), { renew: false });
  }

  async createNotebook(title: string, signal?: AbortSignal): Promise<{ id: string }> {
    return this.exclusive(signal, async () => {
      const body = await this.json(['create', '--json', '--', title], { signal });
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) throw this.bad('create');
      return { id: parsed.data.notebook.id };
    });
  }

  async deleteNotebook(id: string, signal?: AbortSignal): Promise<void> {
    await this.exclusive(signal, async () => {
      await this.json(['delete', '-n', id, '-y', '--json'], { signal });
    });
  }

  async addSource(
    notebookId: string,
    file: { bytes: Uint8Array; fileName: string; title: string; mimeType: string },
    signal?: AbortSignal,
  ): Promise<{ sourceId: string }> {
    if (!/^[a-z0-9_-]{1,100}\.[a-z0-9]{1,8}$/.test(file.fileName)) {
      throw new Error('Nome de arquivo inválido para o NotebookLM');
    }
    return this.exclusive(signal, async () => {
      // The original lives in the ObjectStore: the CLI gets a 0600 copy in the scratch dir (swept
      // at boot), in its own directory so it keeps the app-generated name and extension.
      const dir = path.join(this.scratchDir(), `src-${randomBytes(6).toString('hex')}`);
      fs.mkdirSync(dir, { mode: 0o700 });
      const localFile = path.join(dir, file.fileName);
      fs.writeFileSync(localFile, file.bytes, { mode: 0o600 });
      try {
        return await this.addSourceFile(notebookId, { ...file, path: localFile }, signal);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  private async addSourceFile(
    notebookId: string,
    file: { path: string; title: string; mimeType: string },
    signal?: AbortSignal,
  ): Promise<{ sourceId: string }> {
    const body = await this.json(
      [
        'source',
        'add',
        '-n',
        notebookId,
        '--type',
        'file',
        '--title',
        file.title,
        '--mime-type',
        file.mimeType,
        '--request-timeout',
        String(Math.floor(ADD_TIMEOUT_MS / 1000) - 30),
        '--json',
        '--',
        file.path,
      ],
      { signal, timeoutMs: ADD_TIMEOUT_MS },
    );
    const parsed = addSchema.safeParse(body);
    if (!parsed.success) throw this.bad('source add');
    return { sourceId: parsed.data.source.id };
  }

  async waitSourceReady(
    notebookId: string,
    sourceId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.exclusive(signal, async () => {
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      const res = await this.exec(
        [
          'source',
          'wait',
          sourceId,
          '-n',
          notebookId,
          '--timeout',
          String(seconds),
          '--interval',
          '2',
          '--json',
        ],
        { timeoutMs: timeoutMs + 30_000, signal },
      );
      if (res.code === 0) return;
      if (res.code === 2) throw new NotebookLmError('timeout', MESSAGES.timeout);
      const body = parseJson(res.stdout) as { status?: string; error?: string } | undefined;
      if (body && !('code' in body) && (body.status === 'error' || body.status === 'not_found')) {
        const full = body.status === 'error' ? parseSourceLimitError(body.error ?? '') : undefined;
        if (full)
          throw new NotebookLmError('source_limit', sourceLimitMessage(full.limit), full.limit);
        throw new NotebookLmError(
          'unavailable',
          body.status === 'not_found'
            ? 'O documento não foi encontrado no NotebookLM.'
            : `O NotebookLM não conseguiu processar o documento: ${shorten(body.error ?? '')}`,
        );
      }
      throw this.failure(res);
    });
  }

  async deleteSource(notebookId: string, sourceId: string, signal?: AbortSignal): Promise<void> {
    await this.exclusive(signal, async () => {
      await this.json(['source', 'delete', sourceId, '-n', notebookId, '-y', '--json'], {
        signal,
      });
    });
  }

  async ask(
    notebookId: string,
    question: string,
    opts: { sourceIds?: string[]; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{
    answer: string;
    references: { sourceId: string; citationNumber: number; citedText: string }[];
  }> {
    return this.exclusive(opts.signal, async () => {
      // The question travels in a 0600 temp file, never in argv (length, quoting, `ps` leaks).
      const scratch = this.scratchDir();
      const promptFile = path.join(scratch, `ask-${randomBytes(6).toString('hex')}.txt`);
      fs.writeFileSync(promptFile, question, { mode: 0o600 });
      try {
        const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
        const body = await this.json(
          [
            'ask',
            '--prompt-file',
            promptFile,
            '-n',
            notebookId,
            ...(opts.sourceIds ?? []).flatMap((id) => ['-s', id]),
            '--new',
            '--request-timeout',
            String(seconds),
            '--json',
          ],
          { signal: opts.signal, timeoutMs: opts.timeoutMs + this.killGraceMs },
        );
        const parsed = askSchema.safeParse(body);
        if (!parsed.success) throw this.bad('ask');
        const references = (parsed.data.references ?? []).flatMap((ref, index) => {
          const sourceId = ref.source_id ?? ref.sourceId;
          if (!sourceId) return [];
          return [
            {
              sourceId,
              citationNumber: ref.citation_number ?? ref.citationNumber ?? index + 1,
              citedText: ref.cited_text ?? ref.citedText ?? '',
            },
          ];
        });
        return { answer: parsed.data.answer, references };
      } finally {
        fs.rmSync(promptFile, { force: true });
      }
    });
  }

  /* ---- internals ---- */

  private bad(command: string): NotebookLmError {
    return new NotebookLmError('bad_response', `${MESSAGES.bad_response} (${command})`);
  }

  private scratchDir(): string {
    const dir = path.join(this.workDir, 'tmp');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** One CLI process at a time, spaced out, after an optional automatic credential renewal. */
  private exclusive<T>(
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
    opts: { renew: boolean } = { renew: true },
  ): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    return previous.then(async () => {
      try {
        if (signal?.aborted) throw new NotebookLmError('timeout', 'Operação cancelada');
        const wait = this.lastEnd + this.minGapMs - Date.now();
        if (this.lastEnd > 0 && wait > 0) await this.sleep(wait);
        if (opts.renew) await this.autoRenew(signal);
        return await fn();
      } finally {
        this.lastEnd = Date.now();
        release();
      }
    });
  }

  /** Non-fatal: when the renewal fails the call simply proceeds with the stored credentials. */
  private async autoRenew(signal: AbortSignal | undefined): Promise<void> {
    const config = this.config.get();
    const now = this.now();
    if (!config.authJson || !credentialsNeedRenewal(config.credentialsUpdatedAt, now)) return;
    if (now - this.lastRenewAttempt < RENEW_RETRY_MS) return;
    this.lastRenewAttempt = now;
    try {
      await this.doRefresh(signal);
    } catch (err) {
      this.log(
        `NotebookLM: renovação automática falhou (${err instanceof Error ? err.message : 'erro'})`,
      );
    }
  }

  private async doRefresh(signal: AbortSignal | undefined): Promise<void> {
    const config = this.config.get();
    if (!config.authJson) throw new NotebookLmError('not_configured', MESSAGES.not_configured);
    const dir = fs.mkdtempSync(path.join(this.scratchDir(), 'refresh-'));
    const file = path.join(dir, 'storage_state.json');
    try {
      fs.writeFileSync(file, config.authJson, { mode: 0o600 });
      const res = await this.exec(['--storage', file, 'auth', 'refresh', '--verify'], {
        timeoutMs: REFRESH_TIMEOUT_MS,
        signal,
        withAuth: false,
      });
      if (res.code !== 0) throw this.failure(res);
      const refreshed = normalizeStorageState(fs.readFileSync(file, 'utf8'));
      if (!refreshed) throw this.bad('auth refresh');
      this.config.set({ authJson: refreshed, credentialsUpdatedAt: this.now() });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Runs a command and returns its parsed JSON body; any failure becomes a NotebookLmError. */
  private async json(
    args: string[],
    opts: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown> {
    const res = await this.exec(args, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: opts.signal,
    });
    const body = parseJson(res.stdout);
    if (res.code !== 0 || errorBodySchema.safeParse(body).success) throw this.failure(res);
    if (body === undefined || body === null || typeof body !== 'object') {
      throw new NotebookLmError('bad_response', MESSAGES.bad_response);
    }
    return body;
  }

  /** Builds the error for a non-zero exit (or `{error: true}` body). */
  private failure(res: ExecResult): NotebookLmError {
    const parsed = errorBodySchema.safeParse(parseJson(res.stdout));
    const code = parsed.success ? parsed.data.code : undefined;
    const text = `${parsed.success ? (parsed.data.message ?? '') : ''}\n${res.stderr}`.trim();
    const kind = classifyFailure(code, text);
    if (kind === 'source_limit') {
      const limit = parseSourceLimitError(text)?.limit ?? null;
      return new NotebookLmError('source_limit', sourceLimitMessage(limit), limit);
    }
    if (kind === 'unavailable') {
      return new NotebookLmError(
        'unavailable',
        `NotebookLM indisponível: ${shorten(text) || `a CLI terminou com código ${res.code}`}`,
      );
    }
    return new NotebookLmError(kind, MESSAGES[kind as keyof typeof MESSAGES]);
  }

  private exec(
    args: string[],
    opts: { timeoutMs: number; signal?: AbortSignal; withAuth?: boolean },
  ): Promise<ExecResult> {
    const config = this.config.get();
    const withAuth = opts.withAuth !== false;
    if (withAuth && !config.authJson) {
      return Promise.reject(new NotebookLmError('not_configured', MESSAGES.not_configured));
    }
    const { cmd, args: baseArgs } = splitCommand(config.cliCommand);
    if (!cmd) {
      return Promise.reject(
        new NotebookLmError('cli_missing', 'Comando da CLI do NotebookLM não configurado'),
      );
    }
    const env = minimalEnv(this.env, {
      NOTEBOOKLM_HOME: this.workDir,
      ...(withAuth && config.authJson ? { NOTEBOOKLM_AUTH_JSON: config.authJson } : {}),
    });
    fs.mkdirSync(this.workDir, { recursive: true, mode: 0o700 });

    return new Promise<ExecResult>((resolve, reject) => {
      const child = execFile(
        cmd,
        [...baseArgs, ...args],
        {
          env,
          cwd: this.workDir,
          timeout: opts.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_BUFFER,
          signal: opts.signal,
          windowsHide: true,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout, stderr });
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
          if (e.code === 'ENOENT' || e.code === 'EACCES') {
            return reject(
              new NotebookLmError(
                'cli_missing',
                `CLI do NotebookLM não encontrada ("${cmd}"). Instale o notebooklm-py ou ajuste o comando nas configurações.`,
              ),
            );
          }
          if (e.name === 'AbortError' || e.code === 'ABORT_ERR') {
            // execFile reports the abort before the killed child has exited: wait for it, so
            // callers never see a still-running CLI (on Windows it keeps workDir locked)
            const cancelled = () => reject(new NotebookLmError('timeout', 'Operação cancelada'));
            if (child.exitCode !== null || child.signalCode !== null) return cancelled();
            child.once('exit', cancelled);
            return;
          }
          if (e.killed) return reject(new NotebookLmError('timeout', MESSAGES.timeout));
          if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            return reject(new NotebookLmError('bad_response', MESSAGES.bad_response));
          }
          if (typeof e.code === 'number') return resolve({ code: e.code, stdout, stderr });
          reject(
            new NotebookLmError('unavailable', `NotebookLM indisponível: ${shorten(e.message)}`),
          );
        },
      );
      child.stdin?.end();
    });
  }
}

/** Removes leftovers of a crashed run: scratch files and login directories. Call once at boot. */
export function sweepNotebookLmScratch(workDir: string): void {
  try {
    fs.rmSync(path.join(workDir, 'tmp'), { recursive: true, force: true });
    for (const entry of fs.readdirSync(workDir)) {
      if (entry.startsWith('login-'))
        fs.rmSync(path.join(workDir, entry), { recursive: true, force: true });
    }
  } catch {
    /* workDir does not exist yet */
  }
}
