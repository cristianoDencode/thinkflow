import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  NotebookLmLoginHandle,
  NotebookLmLoginOutcome,
  NotebookLmLoginRunner,
} from '../../domain/ports';
import { canOpenWindow } from '../../../../shared/infrastructure/display';
import { killTree, minimalEnv, splitCommand } from './process-env';

export const LOGIN_UNSUPPORTED_MESSAGE =
  "O servidor não tem tela para abrir o login. Use 'Importar login existente' ou cole o storage_state.json.";

export interface CliLoginRunnerOptions {
  /** `NOTEBOOKLM_HOME`; each login gets a throw-away `login-<rand>` directory below it. */
  workDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Detects a container (no desktop there). Default: `/.dockerenv` exists. */
  isContainer?: () => boolean;
  /** Extra seconds after `--browser-timeout` before the process is killed. */
  graceSec?: number;
}

/**
 * Runs `notebooklm login --storage <dir>/storage_state.json --browser-timeout N`: a Chromium window
 * opens on the machine running the server and the CLI saves the session automatically once the Google
 * login is detected.
 *
 * Credential hygiene: the plaintext file and the Playwright browser profile (which holds the same
 * cookies) live in one throw-away directory (mode 700) that is deleted as soon as the process ends,
 * whatever the outcome. NOTEBOOKLM_AUTH_JSON is never passed (the CLI refuses to log in with it).
 */
export class CliLoginRunner implements NotebookLmLoginRunner {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly isContainer: () => boolean;

  constructor(private readonly options: CliLoginRunnerOptions) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.isContainer = options.isContainer ?? (() => fs.existsSync('/.dockerenv'));
  }

  support(): { supported: boolean; message: string } {
    if (!canOpenWindow({ env: this.env, platform: this.platform, isContainer: this.isContainer })) {
      return { supported: false, message: LOGIN_UNSUPPORTED_MESSAGE };
    }
    return { supported: true, message: '' };
  }

  start(opts: { cliCommand: string; timeoutSec: number }): NotebookLmLoginHandle {
    const dir = path.join(this.options.workDir, `login-${randomBytes(6).toString('hex')}`);
    const file = path.join(dir, 'storage_state.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    const { cmd, args } = splitCommand(opts.cliCommand);
    let cancelled = false;
    let child: ReturnType<typeof spawn> | null = null;

    const result = new Promise<NotebookLmLoginOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: NotebookLmLoginOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(outcome);
      };
      const deadline = setTimeout(
        () => {
          if (child) killTree(child);
        },
        (opts.timeoutSec + (this.options.graceSec ?? 30)) * 1000,
      );

      if (!cmd) {
        cleanup();
        return settle({ ok: false, cancelled: false, message: 'Comando da CLI não configurado' });
      }
      try {
        child = spawn(
          cmd,
          [...args, 'login', '--storage', file, '--browser-timeout', String(opts.timeoutSec)],
          {
            cwd: dir,
            env: minimalEnv(this.env, { NOTEBOOKLM_HOME: this.options.workDir }, { display: true }),
            stdio: 'ignore',
            detached: this.platform !== 'win32',
            windowsHide: false,
          },
        );
      } catch {
        cleanup();
        return settle({ ok: false, cancelled: false, message: 'Não foi possível iniciar a CLI' });
      }
      child.on('error', (err: NodeJS.ErrnoException) => {
        cleanup();
        settle({
          ok: false,
          cancelled: false,
          message:
            err.code === 'ENOENT' || err.code === 'EACCES'
              ? `CLI do NotebookLM não encontrada ("${cmd}"). Instale o notebooklm-py ou ajuste o comando nas configurações.`
              : 'Não foi possível iniciar a CLI do NotebookLM',
        });
      });
      child.on('close', (code) => {
        let content: string | null = null;
        try {
          if (code === 0 && !cancelled) content = fs.readFileSync(file, 'utf8');
        } catch {
          content = null;
        }
        cleanup();
        if (cancelled) return settle({ ok: false, cancelled: true, message: 'Login cancelado.' });
        if (content !== null) return settle({ ok: true, storageState: content });
        settle({
          ok: false,
          cancelled: false,
          message:
            code === 0
              ? 'O login terminou sem salvar as credenciais. Tente novamente.'
              : 'O login não foi concluído (tempo esgotado ou janela fechada). Tente novamente.',
        });
      });
    });

    return {
      result,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (child) killTree(child);
      },
    };
  }
}
