import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CliAccountLimitsProbe,
  PROBE_SCRIPT,
  interpreterFromScript,
  parseProbeOutput,
  resolveCliPython,
  type ProcessRunner,
  type RunResult,
} from '../../src/contexts/library/infrastructure/notebooklm/account-limits-probe';
import { MemoryNotebookLmConfig, fakeStorageState } from './notebooklm-helpers';

const exit = (stdout: string, code = 0): RunResult => ({
  status: 'exit',
  code,
  stdout,
  stderr: '',
});

describe('parseProbeOutput', () => {
  it('reads the three numbers', () => {
    expect(
      parseProbeOutput(exit('{"source_limit": 300, "notebook_limit": 500, "tier": 2}\n')),
    ).toEqual({ ok: true, limits: { sourceLimit: 300, notebookLimit: 500, tier: 2 } });
  });

  it('ignores log lines before the JSON and accepts partial answers', () => {
    expect(
      parseProbeOutput(
        exit('warning: x\n{"source_limit": 100, "notebook_limit": null, "tier": null}'),
      ),
    ).toEqual({ ok: true, limits: { sourceLimit: 100, notebookLimit: null, tier: null } });
  });

  it('is unavailable when the account reports nothing', () => {
    const res = parseProbeOutput(
      exit('{"source_limit": null, "notebook_limit": null, "tier": null}'),
    );
    expect(res).toMatchObject({ ok: false });
  });

  it.each(['', 'not json at all', '[1,2,3]', '{"source_limit": "300"}', '{"source_limit": -5}'])(
    'rejects garbage (%j)',
    (stdout) => {
      expect(parseProbeOutput(exit(stdout))).toMatchObject({ ok: false });
    },
  );

  it('explains a missing package and an old version, naming only the exception class', () => {
    expect(parseProbeOutput(exit('{"error": "ModuleNotFoundError"}', 1))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('não está instalado'),
    });
    expect(parseProbeOutput(exit('{"error": "AttributeError"}', 1))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('0.8.0'),
    });
    const other = parseProbeOutput(exit('{"error": "AuthError"}', 1));
    expect(other).toMatchObject({ ok: false, reason: expect.stringContaining('(AuthError)') });
  });

  it('treats a non-zero exit as failure even with plausible numbers', () => {
    expect(parseProbeOutput(exit('{"source_limit": 300}', 1))).toMatchObject({ ok: false });
  });

  it('reports timeouts and spawn errors', () => {
    expect(parseProbeOutput({ status: 'timeout' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('demorou demais'),
    });
    expect(parseProbeOutput({ status: 'spawn_error', message: 'ENOENT' })).toMatchObject({
      ok: false,
    });
  });
});

describe('interpreter resolution', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const write = (rel: string, content: string, mode = 0o755) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode });
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-probe-'));
    env = { PATH: path.join(dir, 'bin') };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('finds the venv Python through the console script shebang', () => {
    const python = write('venv/bin/python3', '');
    const cli = write('venv/bin/notebooklm', `#!${python}\nimport sys\n`);
    expect(resolveCliPython(cli, env)).toEqual({ ok: true, python });
  });

  it('resolves a bare command on PATH', () => {
    const python = write('bin/python3', '');
    write('bin/notebooklm', `#!${python}\n`);
    expect(resolveCliPython('notebooklm', env)).toEqual({ ok: true, python });
  });

  it('follows "#!/usr/bin/env python3"', () => {
    const python = write('bin/python3', '');
    write('bin/notebooklm', '#!/usr/bin/env python3\n');
    expect(resolveCliPython('notebooklm', env)).toEqual({ ok: true, python });
  });

  it("understands pip's long-path '/bin/sh' + exec form", () => {
    const python = write('long venv/bin/python', '');
    const head = `#!/bin/sh\n'''exec' "${python}" "$0" "$@"\n' '''\n`;
    expect(interpreterFromScript(head, env)).toBe(python);
    const cli = write('long venv/bin/notebooklm', head);
    expect(resolveCliPython(`"${cli}"`, env)).toEqual({ ok: true, python });
  });

  it('uses the Python of "python -m notebooklm" style commands', () => {
    const python = write('bin/python3', '');
    expect(resolveCliPython('python3 -m notebooklm', env)).toEqual({ ok: true, python });
  });

  it('is unavailable when the interpreter in the shebang no longer exists', () => {
    const cli = write('venv/bin/notebooklm', `#!${path.join(dir, 'gone/bin/python3')}\n`);
    expect(resolveCliPython(cli, env)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('não existe mais'),
    });
  });

  it('is unavailable for launchers (uvx), binaries and unknown commands', () => {
    write('bin/uvx', '\u007fELF....'); // a binary: no shebang
    expect(resolveCliPython('uvx notebooklm', env)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('lançador'),
    });
    write('bin/notebooklm', '\u007fELF....');
    expect(resolveCliPython('notebooklm', env)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('não é um script Python'),
    });
    expect(resolveCliPython('nao-existe', env)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('não encontrei'),
    });
    expect(resolveCliPython('   ', env)).toMatchObject({ ok: false });
  });

  it('refuses a shebang that is not a Python', () => {
    const bash = write('bin/node', '');
    write('bin/notebooklm', `#!${bash}\n`);
    expect(resolveCliPython('notebooklm', env)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('não é um Python'),
    });
  });
});

describe('CliAccountLimitsProbe', () => {
  let dir: string;
  let work: string;
  let python: string;
  let env: NodeJS.ProcessEnv;
  const secret = 'super-secret-cookie-value';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-probe-'));
    work = path.join(dir, 'work');
    fs.mkdirSync(path.join(dir, 'venv/bin'), { recursive: true });
    python = path.join(dir, 'venv/bin/python3');
    fs.writeFileSync(python, '', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'venv/bin/notebooklm'), `#!${python}\n`, { mode: 0o755 });
    env = { PATH: '/usr/bin', NOTEBOOKLM_AUTH_JSON: 'must-not-leak', THINKFLOW_SECRET: 'nope' };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const make = (run: ProcessRunner, patch = {}) =>
    new CliAccountLimitsProbe({
      config: new MemoryNotebookLmConfig({
        authJson: fakeStorageState(secret),
        cliCommand: path.join(dir, 'venv/bin/notebooklm'),
        ...patch,
      }),
      workDir: work,
      env,
      run,
    });

  it('runs the script with the CLI Python, the storage path as argument, and cleans up', async () => {
    let seen: {
      cmd: string;
      args: string[];
      env: Record<string, string>;
      timeoutMs: number;
    } | null = null;
    let fileContent = '';
    const probe = make(async (cmd, args, opts) => {
      seen = { cmd, args, env: opts.env, timeoutMs: opts.timeoutMs };
      fileContent = fs.readFileSync(args[3]!, 'utf8');
      expect(fs.statSync(args[3]!).mode & 0o077).toBe(0); // 0600
      return exit('{"source_limit": 300, "notebook_limit": 500, "tier": 2}');
    });
    const res = await probe.detect();
    expect(res).toEqual({ ok: true, limits: { sourceLimit: 300, notebookLimit: 500, tier: 2 } });
    expect(seen!.cmd).toBe(python);
    expect(seen!.args.slice(0, 3)).toEqual(['-I', '-c', PROBE_SCRIPT]);
    expect(seen!.args[3]).toMatch(/storage_state\.json$/);
    expect(seen!.args.join(' ')).not.toContain(secret); // only the PATH travels in argv
    expect(fileContent).toContain(secret);
    expect(seen!.env).not.toHaveProperty('NOTEBOOKLM_AUTH_JSON');
    expect(seen!.env).not.toHaveProperty('THINKFLOW_SECRET');
    expect(seen!.timeoutMs).toBe(30_000);
    expect(fs.readdirSync(path.join(work, 'tmp'))).toEqual([]);
    expect(PROBE_SCRIPT).not.toMatch(/print\(.*(path|cookie|storage)/i);
  });

  it('does not start any process when the interpreter is missing', async () => {
    let called = false;
    const probe = make(
      async () => {
        called = true;
        return exit('{}');
      },
      { cliCommand: 'uvx notebooklm' },
    );
    const res = await probe.detect();
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining('indisponível') });
    expect(called).toBe(false);
  });

  it('reports a timeout and still removes the credentials file', async () => {
    const probe = make(async () => ({ status: 'timeout' }));
    expect(await probe.detect()).toMatchObject({ ok: false });
    expect(fs.readdirSync(path.join(work, 'tmp'))).toEqual([]);
  });

  it('survives a runner that throws', async () => {
    const probe = make(async () => {
      throw new Error(`boom ${secret}`);
    });
    const res = await probe.detect();
    expect(res).toMatchObject({ ok: false });
    expect(JSON.stringify(res)).not.toContain(secret);
  });

  it('needs credentials', async () => {
    const probe = make(async () => exit('{}'), { authJson: null });
    expect(await probe.detect()).toEqual({ ok: false, reason: 'NotebookLM não configurado' });
  });
});
