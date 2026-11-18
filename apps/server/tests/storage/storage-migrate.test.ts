import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runStorageMigrate } from '../../src/cli/storage-migrate';
import { copyObjects } from '../../src/shared/infrastructure/storage/copy-objects';
import { LocalObjectStore } from '../../src/shared/infrastructure/storage/local-object-store';
import { MemoryObjectStore } from '../../src/shared/infrastructure/storage/memory-object-store';

const LIB = '7f1c2d3e-0000-4000-8000-000000000001';
const DOC = '7f1c2d3e-0000-4000-8000-000000000002';
const enc = (s: string) => new TextEncoder().encode(s);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-migrate-'));
  dirs.push(dir);
  return dir;
};

async function keys(store: MemoryObjectStore): Promise<string[]> {
  const out: string[] = [];
  for await (const info of store.list('')) out.push(info.key);
  return out;
}

describe('copyObjects', () => {
  it('copies with the same keys, keeps the source and skips what is already there', async () => {
    const source = new LocalObjectStore(tmp());
    await source.put('reports/r1/v1/report.html', enc('<p>oi</p>'), { contentType: 'text/html' });
    await source.put('library/l/d.pdf', enc('pdf'), { contentType: 'application/pdf' });
    const target = new MemoryObjectStore();

    expect(await copyObjects(source, target, { dryRun: true })).toEqual({
      copied: 2,
      skipped: 0,
      failed: 0,
    });
    expect(await keys(target)).toEqual([]);

    expect(await copyObjects(source, target)).toEqual({ copied: 2, skipped: 0, failed: 0 });
    expect(await keys(target)).toEqual(['library/l/d.pdf', 'reports/r1/v1/report.html']);
    expect((await target.head('reports/r1/v1/report.html'))!.contentType).toContain('text/html');
    expect(await source.head('library/l/d.pdf')).not.toBeNull();

    expect(await copyObjects(source, target)).toEqual({ copied: 0, skipped: 2, failed: 0 });
  });

  it('counts failures without stopping', async () => {
    const source = new LocalObjectStore(tmp());
    await source.put('reports/a.md', enc('a'), { contentType: 'text/markdown' });
    const target = new MemoryObjectStore();
    target.fail('fora do ar');
    const failed: string[] = [];
    expect(
      await copyObjects(source, target, { onObject: (k, o) => o === 'failed' && failed.push(k) }),
    ).toEqual({ copied: 0, skipped: 0, failed: 1 });
    expect(failed).toEqual(['reports/a.md']);
  });
});

describe('storage:migrate', () => {
  function setup() {
    const dataDir = tmp();
    const lines: string[] = [];
    return {
      dataDir,
      lines,
      run: (argv: string[], target: MemoryObjectStore, env: NodeJS.ProcessEnv = {}) =>
        runStorageMigrate({
          env: { DATA_DIR: dataDir, ...env },
          argv,
          print: (l) => lines.push(l),
          target,
        }),
    };
  }

  it('copies the local objects and the legacy library uploads to the target', async () => {
    const { dataDir, lines, run } = setup();
    const local = new LocalObjectStore(path.join(dataDir, 'objects'));
    await local.put('reports/r1/v1/report.html', enc('x'), { contentType: 'text/html' });
    fs.mkdirSync(path.join(dataDir, 'library', LIB), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'library', LIB, `${DOC}.pdf`), 'pdf');
    const target = new MemoryObjectStore();

    expect(await run(['--dry-run'], target)).toBe(0);
    expect(await keys(target)).toEqual([]);
    expect(lines.join('\n')).toContain('[simulação]');

    expect(await run([], target)).toBe(0);
    expect(await keys(target)).toEqual([`library/${LIB}/${DOC}.pdf`, 'reports/r1/v1/report.html']);
    expect(fs.existsSync(path.join(dataDir, 'library', LIB, `${DOC}.pdf`))).toBe(false);
    expect(lines.at(-1)).toContain('você pode apagar');
  });

  it('honors STORAGE_PREFIX and fails (exit 1) when the target is down', async () => {
    const { dataDir, lines, run } = setup();
    const local = new LocalObjectStore(path.join(dataDir, 'objects'));
    await local.put('tf/reports/a.md', enc('a'), { contentType: 'text/markdown' });
    await local.put('other/b.md', enc('b'), { contentType: 'text/markdown' });
    const target = new MemoryObjectStore();
    expect(await run([], target, { STORAGE_PREFIX: 'tf/' })).toBe(0);
    expect(await keys(target)).toEqual(['tf/reports/a.md']);

    target.fail('MinIO fora do ar');
    expect(await run([], target)).toBe(1);
    expect(lines.at(-1)).toContain('Destino indisponível');
  });

  it('refuses to run when the configured driver is not s3', async () => {
    const lines: string[] = [];
    const code = await runStorageMigrate({
      env: { DATA_DIR: tmp() },
      argv: [],
      print: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain('não é "s3"');
  });
});
