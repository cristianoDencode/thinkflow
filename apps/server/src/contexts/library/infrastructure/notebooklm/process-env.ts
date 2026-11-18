import type { ChildProcess } from 'node:child_process';

/** Variables a child CLI may inherit. Everything else (API keys, THINKFLOW_SECRET...) is dropped. */
const BASE_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  // needed behind a corporate proxy / custom CA
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
] as const;

/** Extra variables only the interactive login needs (a window on the user's desktop). */
const DISPLAY_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'PLAYWRIGHT_BROWSERS_PATH',
] as const;

export function minimalEnv(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string>,
  opts: { display?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const keys: readonly string[] = opts.display ? [...BASE_KEYS, ...DISPLAY_KEYS] : BASE_KEYS;
  for (const key of keys) {
    const value = source[key];
    if (value) env[key] = value;
  }
  env.LANG ??= 'C.UTF-8';
  env.PYTHONIOENCODING = 'utf-8';
  return { ...env, ...extra };
}

/**
 * `cliCommand` is split on whitespace: `notebooklm`, `/opt/venv/bin/notebooklm`, `node fixture.mjs`.
 * Double or single quotes group a part with spaces (Windows: `"C:\Program Files\nodejs\node.exe" x.mjs`);
 * backslashes are kept literally so Windows paths need no escaping.
 */
export function splitCommand(command: string): { cmd: string; args: string[] } {
  const parts: string[] = [];
  for (const m of command.trim().matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    parts.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  const [cmd = '', ...args] = parts;
  return { cmd, args };
}

/** Terminates a detached child and the processes it spawned (the browser), then force-kills. */
export function killTree(child: ChildProcess, graceMs = 3000): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  const send = (signal: NodeJS.Signals) => {
    try {
      // negative pid = the whole process group (the child was spawned with `detached: true`)
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-pid, signal);
    } catch {
      /* already gone */
    }
  };
  send('SIGTERM');
  const timer = setTimeout(() => send('SIGKILL'), graceMs);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}
