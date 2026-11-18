/**
 * Reads the account limits (`notebook_limit`, `source_limit`, `tier`) of the connected Google account.
 *
 * The notebooklm-py CLI has no command that prints them (`usage --json` is compute usage only), but the
 * Python API does: `await client.settings.get_account_limits()` (notebooklm-py >= 0.8.0). The probe runs
 * a tiny Python script with the SAME interpreter the CLI uses: the CLI is a pip console script whose
 * shebang names that interpreter (a venv `bin/python`), so it is found by reading that shebang.
 * When it cannot be resolved (`uvx notebooklm`, a Windows `.exe` launcher, a non-Python wrapper...)
 * detection is simply reported as unavailable and the plan chosen by the user is used instead.
 *
 * The storage_state.json (Google cookies) is written to a 0600 file in a throw-away directory and only its
 * PATH is passed as an argument; nothing from it is ever printed or logged, and the script prints only
 * three numbers (or the NAME of the exception class on failure).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { NotebookLmAccountProbe, NotebookLmConfigStore } from '../../domain/ports';
import type { NotebookLmProbeResult } from '../../domain/ports';
import { minimalEnv, splitCommand } from './process-env';

const PROBE_TIMEOUT_MS = 30_000;

/** Run with `python -I -c <script> <storage_state.json path>`. */
export const PROBE_SCRIPT = `
import asyncio, json, sys

def num(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None

async def main(path):
    from notebooklm import NotebookLMClient
    async with NotebookLMClient.from_storage(path) as client:
        limits = await client.settings.get_account_limits()
    print(json.dumps({
        "source_limit": num(getattr(limits, "source_limit", None)),
        "notebook_limit": num(getattr(limits, "notebook_limit", None)),
        "tier": num(getattr(limits, "tier", None)),
    }))

try:
    asyncio.run(main(sys.argv[1]))
except BaseException as exc:
    print(json.dumps({"error": type(exc).__name__}))
    sys.exit(1)
`.trim();

export type RunResult =
  | { status: 'exit'; code: number; stdout: string; stderr: string }
  | { status: 'timeout' }
  | { status: 'spawn_error'; message: string };

export type ProcessRunner = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<RunResult>;

export const execFileRunner: ProcessRunner = (cmd, args, opts) =>
  new Promise<RunResult>((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        env: opts.env,
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024,
        signal: opts.signal,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ status: 'exit', code: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.killed || e.name === 'AbortError') return resolve({ status: 'timeout' });
        if (typeof e.code === 'number')
          return resolve({ status: 'exit', code: e.code, stdout, stderr });
        resolve({ status: 'spawn_error', message: e.code ? String(e.code) : 'erro' });
      },
    );
    child.stdin?.end();
  });

/* ---- which Python runs the CLI ---- */

const PYTHON_NAME = /^python(\d+(\.\d+)*)?(\.exe)?$/i;

function isExecutableFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [name, `${name}.exe`] : [name];
  for (const dir of dirs) {
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      if (isExecutableFile(file)) return file;
    }
  }
  return null;
}

function resolveExecutable(token: string, env: NodeJS.ProcessEnv): string | null {
  if (token.includes('/') || token.includes('\\')) {
    const file = path.resolve(token);
    return isExecutableFile(file) ? file : null;
  }
  return findOnPath(token, env);
}

function readHead(file: string, bytes = 512): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('latin1');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The interpreter named by a script's shebang, including pip's long-path `/bin/sh` + `'''exec'` form. */
export function interpreterFromScript(head: string, env: NodeJS.ProcessEnv): string | null {
  const lines = head.split(/\r?\n/);
  const first = lines[0] ?? '';
  if (!first.startsWith('#!')) return null;
  const { cmd, args } = splitCommand(first.slice(2));
  if (!cmd) return null;
  const base = path.basename(cmd);
  if (base === 'env') {
    const name = args.find((a) => !a.startsWith('-'));
    return name ? (resolveExecutable(name, env) ?? name) : null;
  }
  if (base === 'sh' || base === 'bash' || base === 'dash') {
    // pip: shebang too long for the kernel -> "#!/bin/sh" then "'''exec' "<python>" "$0" "$@""
    const m = /^'''exec'\s+("([^"]+)"|'([^']+)'|(\S+))\s+"\$0"/.exec(lines[1] ?? '');
    return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
  }
  return cmd;
}

export type InterpreterResult = { ok: true; python: string } | { ok: false; reason: string };

/**
 * Finds the Python that runs `cliCommand`. `python -m notebooklm` style commands use that Python
 * directly; a plain `notebooklm` / `/venv/bin/notebooklm` is resolved through its shebang.
 */
export function resolveCliPython(cliCommand: string, env: NodeJS.ProcessEnv): InterpreterResult {
  const { cmd, args } = splitCommand(cliCommand);
  const unavailable = (why: string): InterpreterResult => ({
    ok: false,
    reason: `Detecção automática indisponível: ${why}. Escolha o plano da conta manualmente.`,
  });
  if (!cmd) return unavailable('comando da CLI não configurado');
  const executable = resolveExecutable(cmd, env);
  if (!executable) return unavailable(`não encontrei "${cmd}" no servidor`);

  if (PYTHON_NAME.test(path.basename(executable)) || PYTHON_NAME.test(path.basename(cmd))) {
    return { ok: true, python: executable };
  }
  if (args.length > 0)
    return unavailable(
      'o comando da CLI usa um lançador (ex.: uvx) em vez do executável notebooklm',
    );
  const head = readHead(executable);
  const shebang = head === null ? null : interpreterFromScript(head, env);
  if (!shebang)
    return unavailable('a CLI não é um script Python (não encontrei o interpretador no shebang)');
  const python = resolveExecutable(shebang, env);
  if (!python) return unavailable('o interpretador Python da CLI não existe mais');
  if (!/python/i.test(path.basename(python)))
    return unavailable('o interpretador da CLI não é um Python');
  return { ok: true, python };
}

/* ---- parsing ---- */

const probeSchema = z
  .object({
    source_limit: z.number().int().min(0).nullish(),
    notebook_limit: z.number().int().min(0).nullish(),
    tier: z.number().int().min(0).nullish(),
    error: z.string().optional(),
  })
  .passthrough();

const ERROR_REASONS: Record<string, string> = {
  ModuleNotFoundError: 'o notebooklm-py não está instalado no Python da CLI',
  ImportError: 'o notebooklm-py não está instalado no Python da CLI',
  AttributeError:
    'a versão instalada do notebooklm-py não informa os limites da conta (use 0.8.0 ou mais nova)',
};

/** Turns the probe's stdout/exit into a result. Never trusts the output: anything odd is "unavailable". */
export function parseProbeOutput(run: RunResult): NotebookLmProbeResult {
  if (run.status === 'timeout')
    return {
      ok: false,
      reason: 'Detecção automática: o NotebookLM demorou demais para responder.',
    };
  if (run.status === 'spawn_error')
    return {
      ok: false,
      reason: 'Detecção automática indisponível: não consegui iniciar o Python da CLI.',
    };
  const lines = run.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  const last = lines[lines.length - 1] ?? '';
  let json: unknown;
  try {
    json = JSON.parse(last);
  } catch {
    return { ok: false, reason: 'Detecção automática: resposta inesperada do Python da CLI.' };
  }
  const parsed = probeSchema.safeParse(json);
  if (!parsed.success)
    return { ok: false, reason: 'Detecção automática: resposta inesperada do Python da CLI.' };
  if (parsed.data.error !== undefined || run.code !== 0) {
    const name = parsed.data.error ?? '';
    const known = ERROR_REASONS[name];
    return {
      ok: false,
      reason: known
        ? `Detecção automática indisponível: ${known}.`
        : `Detecção automática: não foi possível consultar os limites da conta${/^\w{1,60}$/.test(name) ? ` (${name})` : ''}.`,
    };
  }
  const sourceLimit = parsed.data.source_limit || null;
  const notebookLimit = parsed.data.notebook_limit || null;
  const tier = parsed.data.tier ?? null;
  if (sourceLimit === null && notebookLimit === null && tier === null)
    return { ok: false, reason: 'Detecção automática: a conta não informou os limites.' };
  return { ok: true, limits: { sourceLimit, notebookLimit, tier } };
}

/* ---- adapter ---- */

export interface CliAccountLimitsProbeOptions {
  config: NotebookLmConfigStore;
  /** Scratch space (`<workDir>/tmp`) and `NOTEBOOKLM_HOME`, normally `DATA_DIR/notebooklm`. */
  workDir: string;
  env?: NodeJS.ProcessEnv;
  run?: ProcessRunner;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export class CliAccountLimitsProbe implements NotebookLmAccountProbe {
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: ProcessRunner;

  constructor(private readonly options: CliAccountLimitsProbeOptions) {
    this.env = options.env ?? process.env;
    this.run = options.run ?? execFileRunner;
  }

  async detect(signal?: AbortSignal): Promise<NotebookLmProbeResult> {
    const config = this.options.config.get();
    if (!config.authJson) return { ok: false, reason: 'NotebookLM não configurado' };
    const python = resolveCliPython(config.cliCommand, this.env);
    if (!python.ok) return { ok: false, reason: python.reason };

    const scratch = path.join(this.options.workDir, 'tmp');
    fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const dir = path.join(scratch, `probe-${randomBytes(6).toString('hex')}`);
    fs.mkdirSync(dir, { mode: 0o700 });
    const file = path.join(dir, 'storage_state.json');
    try {
      fs.writeFileSync(file, config.authJson, { mode: 0o600 });
      const result = await this.run(python.python, ['-I', '-c', PROBE_SCRIPT, file], {
        // no NOTEBOOKLM_AUTH_JSON: the explicit path is the only credential source
        env: minimalEnv(this.env, { NOTEBOOKLM_HOME: this.options.workDir }),
        cwd: this.options.workDir,
        timeoutMs: this.options.timeoutMs ?? PROBE_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      return parseProbeOutput(result);
    } catch (err) {
      this.options.log?.(
        `NotebookLM: detecção de limites falhou (${err instanceof Error ? err.name : 'erro'})`,
      );
      return {
        ok: false,
        reason: 'Detecção automática indisponível: falha ao executar o Python da CLI.',
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
