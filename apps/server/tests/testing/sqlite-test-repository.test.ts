import { describe, expect, it } from 'vitest';
import { SqliteTestRepository } from '../../src/contexts/testing/infrastructure/sqlite-test-repository';
import {
  newDefinition,
  type TestRun,
  type TestSession,
} from '../../src/contexts/testing/domain/session';
import { canOpenWindow } from '../../src/shared/infrastructure/display';
import { SecretBox } from '../../src/shared/infrastructure/crypto';
import { openDatabase } from '../../src/shared/infrastructure/db/client';
import { testSessions } from '../../src/shared/infrastructure/db/schema';

function make(secret = 'test-secret') {
  const handle = openDatabase(':memory:');
  return { handle, repo: new SqliteTestRepository(handle.db, new SecretBox(secret)) };
}

const session = (id: string, at: number): TestSession => ({
  id,
  name: id,
  startUrl: 'https://a.b',
  definition: newDefinition({}),
  secrets: {},
  createdAt: at,
  updatedAt: at,
});

const run = (id: string, sessionId: string, createdAt: number): TestRun => ({
  id,
  sessionId,
  seq: 1,
  rerunOf: null,
  snapshot: null,
  dataSetId: null,
  status: 'passed',
  headed: false,
  results: [],
  error: null,
  createdAt,
  startedAt: createdAt,
  finishedAt: createdAt + 1,
});

describe('SqliteTestRepository', () => {
  it('keeps secret values encrypted at rest and decrypts them on read', async () => {
    const { handle, repo } = make();
    await repo.save({ ...session('s1', 1), secrets: { recorded: { p2: 'senha-123' } } });
    const raw = handle.db.select().from(testSessions).get()!;
    expect(raw.secretsEnc).not.toBe('');
    expect(raw.secretsEnc).not.toContain('senha-123');
    expect(raw.definition).not.toContain('senha-123');
    expect((await repo.find('s1'))!.secrets).toEqual({ recorded: { p2: 'senha-123' } });
  });

  it('drops secrets that cannot be decrypted (THINKFLOW_SECRET changed)', async () => {
    const { handle, repo } = make('a');
    await repo.save({ ...session('s1', 1), secrets: { recorded: { p2: 'x' } } });
    const other = new SqliteTestRepository(handle.db, new SecretBox('b'));
    expect((await other.find('s1'))!.secrets).toEqual({});
  });

  it('lists newest first, counts evidences and finds the last run per session', async () => {
    const { repo } = make();
    await repo.save(session('old', 1));
    await repo.save(session('new', 2));
    expect((await repo.list()).map((s) => s.id)).toEqual(['new', 'old']);

    for (const [id, seq] of [
      ['e1', 1],
      ['e2', 2],
    ] as const) {
      await repo.saveEvidence({
        id,
        sessionId: 'old',
        stepId: `step-${id}`,
        seq,
        at: seq,
        width: 10,
        height: 10,
        originalKey: `old/evidences/${id}/original.png`,
        annotatedKey: null,
        annotations: [{ type: 'badge', x: 0.5, y: 0.5, n: 1, color: '#f00' }],
        crop: null,
        comment: '',
        include: true,
        createdAt: seq,
        updatedAt: seq,
      });
    }
    expect(await repo.evidenceCounts()).toEqual(new Map([['old', 2]]));
    // a step has one image at most (unique index): a second one on the same step is refused
    await expect(
      repo.saveEvidence({ ...(await repo.evidences('old'))[0]!, id: 'dup', seq: 3 }),
    ).rejects.toThrow(/UNIQUE/);
    expect((await repo.evidences('old'))[0]!.annotations).toHaveLength(1);

    await repo.saveRun(run('r1', 'old', 10));
    await repo.saveRun({ ...run('r2', 'old', 20), status: 'failed' });
    await repo.saveRun(run('r3', 'new', 5));
    const last = await repo.lastRuns();
    expect(last.get('old')!.id).toBe('r2');
    expect(last.get('new')!.id).toBe('r3');
    expect((await repo.runs('old', 1)).map((r) => r.id)).toEqual(['r2']);

    await repo.delete('old');
    expect(await repo.evidences('old')).toEqual([]);
    expect(await repo.findRun('r1')).toBeNull();
  });
});

describe('canOpenWindow', () => {
  it('needs a desktop or X11/Wayland, outside containers', () => {
    const no = () => false;
    expect(canOpenWindow({ platform: 'win32', env: {}, isContainer: no })).toBe(true);
    expect(canOpenWindow({ platform: 'darwin', env: {}, isContainer: no })).toBe(true);
    expect(canOpenWindow({ platform: 'linux', env: {}, isContainer: no })).toBe(false);
    expect(canOpenWindow({ platform: 'linux', env: { DISPLAY: ':0' }, isContainer: no })).toBe(
      true,
    );
    expect(
      canOpenWindow({ platform: 'linux', env: { WAYLAND_DISPLAY: 'w' }, isContainer: no }),
    ).toBe(true);
    expect(canOpenWindow({ platform: 'win32', env: {}, isContainer: () => true })).toBe(false);
  });
});
