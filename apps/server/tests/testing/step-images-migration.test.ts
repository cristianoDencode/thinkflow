import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrateLegacyStepImages } from '../../src/contexts/testing/infrastructure/migrate-step-images';
import { SqliteTestRepository } from '../../src/contexts/testing/infrastructure/sqlite-test-repository';
import { SecretBox } from '../../src/shared/infrastructure/crypto';
import {
  defaultMigrationsDir,
  openDatabase,
  type DbHandle,
} from '../../src/shared/infrastructure/db/client';
import { testEvidences, testSessions } from '../../src/shared/infrastructure/db/schema';

const dirs: string[] = [];
const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A copy of the migrations folder that stops before `0015_step_images` (the old schema). */
const before15 = (name: string) => Number(name.slice(0, 4)) < 15;
function migrationsBefore15(): string {
  const src = defaultMigrationsDir();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-migrations-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'meta'));
  for (const f of fs.readdirSync(src)) {
    if (f.endsWith('.sql') && before15(f)) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  }
  const journal = JSON.parse(fs.readFileSync(path.join(src, 'meta', '_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { tag: string }) => before15(e.tag));
  fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  return dir;
}

const step = (id: string, at: number, extra: Record<string, unknown> = {}) => ({
  id,
  at,
  kind: 'click',
  page: null,
  thumbnailKey: null,
  includeThumbnail: false,
  comment: null,
  target: {
    locators: [{ kind: 'css', selector: `#${id}` }],
    description: `elemento ${id}`,
    bbox: null,
    frameUrl: null,
  },
  ...extra,
});

const evidence = (id: string, seq: number, at: number, stepId: string | null, over = {}) => ({
  id,
  sessionId: 'S',
  stepId,
  seq,
  at,
  width: 1920,
  height: 1080,
  originalKey: `S/evidences/${id}/original.png`,
  annotatedKey: null,
  annotations: '[]',
  crop: null,
  comment: `comentário ${id}`,
  include: true,
  createdAt: at,
  updatedAt: at,
  ...over,
});

/** A session as the previous version left it: thumbnails in steps, loose and doubled evidences. */
function seedLegacy(file: string) {
  const old = openDatabase(file, migrationsBefore15());
  const { db } = old;
  db.insert(testSessions)
    .values({
      id: 'S',
      name: 'Legado',
      startUrl: 'https://a.b',
      definition: JSON.stringify({
        schemaVersion: 1,
        viewport: { width: 1920, height: 969 },
        autoThumbnails: true,
        parameters: [],
        dataSets: [{ id: 'recorded', name: 'Gravado', values: {} }],
        steps: [
          step('s1', 100, {
            kind: 'goto',
            url: 'https://a.b',
            target: null,
            thumbnailKey: 'S/steps/s1.jpg',
            includeThumbnail: true,
          }),
          step('s2', 200, { thumbnailKey: 'S/steps/s2.jpg', includeThumbnail: false }),
          // has an evidence AND a thumbnail: the evidence wins
          step('s3', 300, { thumbnailKey: 'S/steps/s3.jpg', includeThumbnail: true }),
          step('s4', 400),
          {
            id: 'n1',
            at: 450,
            kind: 'note',
            page: null,
            thumbnailKey: null,
            includeThumbnail: false,
            comment: 'nota',
            target: null,
          },
        ],
      }),
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(testEvidences)
    .values([
      evidence('e1', 1, 150, null, { comment: 'avulsa antes do s2' }), // loose, between s1 and s2
      evidence('e2', 2, 310, 's3'), // the image of s3
      evidence('e3', 3, 320, 's3', { include: false }), // a second one on the same step
      evidence('e4', 4, 999, null, { annotatedKey: 'S/evidences/e4/annotated.png' }), // loose, last
      evidence('e5', 5, 350, 'gone'), // its step was deleted in the meantime
    ])
    .run();
  old.close();
}

describe('migration 0015 + migrateLegacyStepImages', () => {
  it('turns evidences and thumbnails into step images without losing anything', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-db-')), 'db.sqlite');
    dirs.push(path.dirname(file));
    seedLegacy(file);

    // the new version boots: drizzle applies 0015 (unique index) first...
    const handle = openDatabase(file);
    handles.push(handle);
    const afterSql = handle.db.select().from(testEvidences).orderBy(testEvidences.seq).all();
    // ...the SQL step unlinked the doubled evidence, nothing was deleted yet
    expect(afterSql).toHaveLength(5);
    expect(afterSql.find((e) => e.id === 'e3')!.stepId).toBeNull();
    expect(afterSql.find((e) => e.id === 'e2')!.stepId).toBe('s3');

    let n = 0;
    const result = migrateLegacyStepImages(handle.db, {
      newId: () => `new${++n}`,
      now: () => 5000,
    });
    expect(result).toEqual({ sessions: 1, thumbnails: 2, captures: 4 });

    const repo = new SqliteTestRepository(handle.db, new SecretBox('x'));
    const session = (await repo.find('S'))!;
    // loose evidences (e1, e3, e4, e5) became capture steps, inserted by timestamp
    expect(session.definition.steps.map((s) => `${s.id}:${s.kind}`)).toEqual(
      [
        's1:goto',
        'new3:capture', // e1 (at 150)
        's2:click',
        's3:click',
        'new4:capture', // e3 (at 320)
        'new5:capture', // e5 (at 350)
        's4:click',
        'n1:note',
        'new6:capture', // e4 (at 999)
      ].map((x) => x),
    );
    // no thumbnail fields survive, and the stored JSON parses with the current schema
    expect(JSON.stringify(session.definition)).not.toMatch(/thumbnailKey|includeThumbnail/);

    const images = await repo.evidences('S');
    const byStep = new Map(images.map((e) => [e.stepId, e]));
    expect(images).toHaveLength(7); // 5 evidences + 2 thumbnails: nothing lost
    expect(new Set(images.map((e) => e.stepId)).size).toBe(images.length); // one per step

    // s1 / s2: the old thumbnail is the step's image; "in the document" only if it was included
    expect(byStep.get('s1')).toMatchObject({
      originalKey: 'S/steps/s1.jpg',
      include: true,
      annotatedKey: null,
      width: 1920,
      height: 969,
    });
    expect(byStep.get('s2')).toMatchObject({ originalKey: 'S/steps/s2.jpg', include: false });
    // s3: the evidence won over its thumbnail
    expect(byStep.get('s3')).toMatchObject({
      id: 'e2',
      originalKey: 'S/evidences/e2/original.png',
    });
    expect(images.some((e) => e.originalKey === 'S/steps/s3.jpg')).toBe(false);
    // the loose ones kept comment, annotated render and inclusion
    expect(byStep.get('new3')).toMatchObject({
      id: 'e1',
      comment: 'avulsa antes do s2',
      include: true,
    });
    expect(byStep.get('new4')).toMatchObject({ id: 'e3', include: false });
    expect(byStep.get('new6')).toMatchObject({
      id: 'e4',
      annotatedKey: 'S/evidences/e4/annotated.png',
    });
    expect(byStep.get('s4')).toBeUndefined();

    // idempotent: a second boot changes nothing
    const again = migrateLegacyStepImages(handle.db, { newId: () => `x${++n}` });
    expect(again).toEqual({ sessions: 0, thumbnails: 0, captures: 0 });
    expect(handle.db.select().from(testEvidences).all()).toHaveLength(7);
  });

  it('infers the mode of migrated sessions and leaves current sessions alone', async () => {
    const handle = openDatabase(':memory:');
    handles.push(handle);
    const { db } = handle;
    const now = 1;
    db.insert(testSessions)
      .values({
        id: 'P',
        name: 'Só prints antigo',
        startUrl: 'https://a.b',
        definition: JSON.stringify({
          schemaVersion: 1,
          viewport: { width: 1366, height: 768 },
          autoThumbnails: true,
          parameters: [],
          dataSets: [{ id: 'recorded', name: 'Gravado', values: {} }],
          steps: [],
        }),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(testEvidences)
      .values([
        { ...evidence('p1', 1, 10, null), sessionId: 'P' },
        { ...evidence('p2', 2, 20, null), sessionId: 'P' },
      ])
      .run();
    // a session already in the new shape is not touched
    db.insert(testSessions)
      .values({
        id: 'N',
        name: 'Novo',
        startUrl: 'https://a.b',
        definition: JSON.stringify({
          schemaVersion: 1,
          viewport: { width: 1366, height: 768 },
          mode: 'record',
          autoThumbnails: true,
          parameters: [],
          dataSets: [{ id: 'recorded', name: 'Gravado', values: {} }],
          steps: [(({ thumbnailKey: _t, includeThumbnail: _i, ...rest }) => rest)(step('a', 1))],
        }),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const before = db.select().from(testSessions).where(eq(testSessions.id, 'N')).get()!.definition;

    let n = 0;
    migrateLegacyStepImages(db, { newId: () => `c${++n}` });

    const repo = new SqliteTestRepository(db, new SecretBox('x'));
    const migrated = (await repo.find('P'))!;
    expect(migrated.definition.steps.map((s) => s.kind)).toEqual(['capture', 'capture']);
    expect(migrated.definition.mode).toBeUndefined(); // inferred, not stored
    expect(db.select().from(testSessions).where(eq(testSessions.id, 'N')).get()!.definition).toBe(
      before,
    );
  });
});
