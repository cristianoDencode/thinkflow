import { PROTOTYPE_LIMITS } from '@thinkflow/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrototypeService } from '../../src/contexts/prototypes/application/prototype-service';
import { ObjectPrototypeStore } from '../../src/contexts/prototypes/infrastructure/object-prototype-store';
import {
  SqlitePrototypeRepository,
  SqliteSessionLookup,
} from '../../src/contexts/prototypes/infrastructure/sqlite-prototype-repository';
import { FakeClock } from '../../src/shared/kernel/clock';
import { scopeObjectStore } from '../../src/shared/kernel/scoped-object-store';
import { openDatabase, type DbHandle } from '../../src/shared/infrastructure/db/client';
import { testSessions } from '../../src/shared/infrastructure/db/schema';
import { MemoryObjectStore } from '../../src/shared/infrastructure/storage/memory-object-store';
import { collect, seqIds } from '../helpers';

let handle: DbHandle;
let store: MemoryObjectStore;
let clock: FakeClock;
let service: PrototypeService;

beforeEach(() => {
  handle = openDatabase(':memory:');
  store = new MemoryObjectStore();
  clock = new FakeClock();
  service = new PrototypeService({
    repo: new SqlitePrototypeRepository(handle.db),
    files: new ObjectPrototypeStore(scopeObjectStore(store, '', 'prototypes')),
    sessions: new SqliteSessionLookup(handle.db),
    clock,
    ids: seqIds(),
  });
});
afterEach(() => handle.close());

const snap = (html: string, over: { width?: number; height?: number; css?: string } = {}) => ({
  html,
  css: over.css ?? '',
  width: over.width ?? 800,
  height: over.height ?? 600,
});
const stored = async () => (await collect(store.list('prototypes/'))).map((o) => o.key);

describe('PrototypeService: prototypes and versions', () => {
  it('creates a blank prototype with one version, and stores the HTML in the object store', async () => {
    const created = await service.create({ name: ' Tela de teste ' });
    expect(created).toMatchObject({
      name: 'Tela de teste',
      html: '<body></body>',
      css: '',
      width: 1280,
      height: 720,
      versionCount: 1,
      scrubbed: false,
      sessionId: null,
      thumbnailUrl: null,
    });
    expect(created.versions).toHaveLength(1);
    expect(await stored()).toEqual([`prototypes/${created.id}/${created.versionId}.json`]);
  });

  it('sanitizes what is stored, on create and on update', async () => {
    const created = await service.create({
      name: 'A',
      snapshot: snap('<body onload="x()"><script>x()</script><p>oi</p></body>', {
        css: '@import url(http://evil/x.css);p{color:red}',
      }),
    });
    expect(created.html).toBe('<body><p>oi</p></body>');
    expect(created.css).toBe('p{color:red}');
    const updated = await service.update(created.id, {
      snapshot: snap('<a href="javascript:x()">l</a>'),
    });
    expect(updated.html).toBe('<a>l</a>');
  });

  it('a snapshot creates a version; a rename does not; restoring creates another one', async () => {
    const created = await service.create({ name: 'A', snapshot: snap('<p>1</p>') });
    clock.advance(1000);
    const renamed = await service.update(created.id, { name: 'B' });
    expect(renamed).toMatchObject({ name: 'B', versionCount: 1, versionId: created.versionId });

    clock.advance(1000);
    const edited = await service.update(created.id, {
      snapshot: snap('<p>2</p>', { width: 900, height: 700 }),
      note: 'Ajuste',
    });
    expect(edited).toMatchObject({ versionCount: 2, html: '<p>2</p>', width: 900, height: 700 });
    expect(edited.versions.map((v) => v.note)).toEqual(['Ajuste', 'Importado']);

    const old = await service.version(created.id, created.versionId);
    expect(old).toEqual({ html: '<p>1</p>', css: '', width: 800, height: 600 });

    clock.advance(1000);
    const restored = await service.restore(created.id, created.versionId);
    expect(restored).toMatchObject({ versionCount: 3, html: '<p>1</p>', width: 800 });
    expect(restored.versions[0]!.note).toMatch(/^Restaurado de \d\d\/\d\d\/\d{4} \d\d:\d\d$/);
    expect(restored.versionId).not.toBe(created.versionId);
  });

  it('caps the versions, dropping the oldest and their files; the current one is kept', async () => {
    const max = PROTOTYPE_LIMITS.maxVersionsPerPrototype;
    const created = await service.create({ name: 'A', snapshot: snap('<p>v1</p>') });
    const first = created.versionId;
    let last = created;
    for (let i = 2; i <= max + 5; i++) {
      clock.advance(1);
      last = await service.update(created.id, { snapshot: snap(`<p>v${i}</p>`) });
    }
    expect(last.versionCount).toBe(max);
    expect(last.versions).toHaveLength(max);
    expect(last.html).toBe(`<p>v${max + 5}</p>`);
    expect(last.versions.some((v) => v.id === first)).toBe(false);
    expect(await stored()).toHaveLength(max);
    await expect(service.version(created.id, first)).rejects.toMatchObject({ httpStatus: 404 });
    // the oldest still there is v6
    const oldest = last.versions.at(-1)!;
    expect((await service.version(created.id, oldest.id)).html).toBe('<p>v6</p>');
  });

  it('refuses snapshots over the size limit (413) and keeps the previous version', async () => {
    const created = await service.create({ name: 'A', snapshot: snap('<p>ok</p>') });
    const big = `<p>${'x'.repeat(PROTOTYPE_LIMITS.maxSnapshotBytes)}</p>`;
    await expect(service.update(created.id, { snapshot: snap(big) })).rejects.toMatchObject({
      httpStatus: 413,
    });
    expect((await service.get(created.id)).html).toBe('<p>ok</p>');
  });

  it('refuses invalid sizes and unknown sessions; the list filters by session', async () => {
    await expect(
      service.create({ name: 'A', snapshot: snap('<p/>', { width: 10 }) }),
    ).rejects.toThrow();
    await expect(service.create({ name: 'A', sessionId: 'nao-existe' })).rejects.toMatchObject({
      httpStatus: 404,
    });
    await service.create({ name: 'solto' });
    expect(await service.list({ sessionId: 'nao-existe' })).toEqual([]);
    expect(await service.list()).toHaveLength(1);
  });

  it('enforces the limit of prototypes', async () => {
    const repo = new SqlitePrototypeRepository(handle.db);
    const spy = Object.assign(Object.create(repo) as object, {
      count: async () => PROTOTYPE_LIMITS.maxPrototypes,
    }) as SqlitePrototypeRepository;
    const limited = new PrototypeService({
      repo: spy,
      files: new ObjectPrototypeStore(scopeObjectStore(store, '', 'prototypes')),
      sessions: new SqliteSessionLookup(handle.db),
      clock,
      ids: seqIds(),
    });
    await expect(limited.create({ name: 'A' })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('deleting removes the rows and every stored file', async () => {
    const created = await service.create({ name: 'A' });
    await service.update(created.id, { snapshot: snap('<p>2</p>') });
    expect(await stored()).toHaveLength(2);
    await service.delete(created.id);
    expect(await stored()).toEqual([]);
    await expect(service.get(created.id)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('PrototypeService: capture', () => {
  it('scrubs by default and records the source, the step and the version note', async () => {
    const lookup = new SqliteSessionLookup(handle.db);
    // a fake session row is needed for the link
    handle.db
      .insert(testSessions)
      .values({
        id: 's1',
        name: 'Sessão',
        startUrl: 'https://a.b',
        definition: '{}',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    expect(await lookup.exists('s1')).toBe(true);
    const dto = await service.createFromCapture({
      sessionId: 's1',
      stepId: 'st-1',
      menuPath: 'A > B',
      keepData: false,
      screen: {
        html: '<body><input value="Ana"><table><tr><th>H</th></tr><tr><td>dado</td></tr></table></body>',
        css: 'a{b:c}',
        width: 1200,
        height: 700,
        url: 'https://a.b/w/1/emp1_x.php?id=1',
        title: 'Consulta',
      },
    });
    expect(dto).toMatchObject({
      sessionId: 's1',
      sessionName: 'Sessão',
      stepId: 'st-1',
      scrubbed: true,
      versionCount: 1,
      width: 1200,
      source: {
        url: 'https://a.b/w/1/emp1_x.php',
        file: 'emp1_x.php',
        menuPath: 'A > B',
        title: 'Consulta',
      },
    });
    expect(dto.name).toMatch(/^emp1_x\.php — \d\d\/\d\d\/\d{4} \d\d:\d\d$/);
    const detail = await service.get(dto.id);
    // scrubbed, and the loose field is recognized (annotated, never restructured)
    expect(detail.html).toBe(
      '<body><input data-ec="field"><table data-ec="grid"><tr data-ec-part="header"><th>H</th></tr><tr data-ec-part="row"><td data-ec-part="cell">—</td></tr></table></body>',
    );
    expect(dto.components).toEqual({ field: 1, grid: 1 });
    expect(detail.components).toEqual({ field: 1, grid: 1 });
    expect(dto.warnings).toEqual([]);
    expect(detail.versions[0]!.note).toBe('Captura');
  });

  it('keepData stores the screen as it was, flagged as not scrubbed', async () => {
    const dto = await service.createFromCapture({
      sessionId: null as unknown as string,
      stepId: null,
      menuPath: null,
      keepData: true,
      screen: {
        html: '<body><input value="Ana"></body>',
        css: '',
        width: 800,
        height: 600,
        url: null,
        title: 'T',
      },
    });
    expect(dto.scrubbed).toBe(false);
    expect((await service.get(dto.id)).html).toBe(
      '<body><input value="Ana" data-ec="field"></body>',
    );
  });

  it('keepData also keeps the personal data of the screen; the default replaces it', async () => {
    const screen = {
      html: '<body><div>Usuário 52998224725</div></body>',
      css: '',
      width: 800,
      height: 600,
      url: null,
      title: 'T',
    };
    const base = { sessionId: null as unknown as string, stepId: null, menuPath: null, screen };
    const kept = await service.createFromCapture({ ...base, keepData: true });
    expect((await service.get(kept.id)).html).toContain('52998224725');
    const scrubbed = await service.createFromCapture({ ...base, keepData: false });
    expect((await service.get(scrubbed.id)).html).toBe(
      '<body><div>Usuário 00000000000</div></body>',
    );
  });

  it('warns about frames that could not be read', async () => {
    const dto = await service.createFromCapture({
      sessionId: null as unknown as string,
      stepId: null,
      menuPath: null,
      keepData: false,
      screen: {
        html: '<body></body>',
        css: '',
        width: 800,
        height: 600,
        url: null,
        title: 'T',
        blankFrames: 2,
      },
    });
    expect(dto.warnings).toEqual([expect.stringContaining('2 quadro(s) de outra origem')]);
  });
});

describe('PrototypeService: blocks', () => {
  it('saves sanitized blocks, lists them by category and deletes them', async () => {
    const a = await service.createBlock({
      name: 'Botão',
      category: 'Ações',
      html: '<button onclick="x()">Ok</button>',
    });
    await service.createBlock({ name: 'Campo', html: '<input>', css: 'input{x:y}' });
    expect(a.html).toBe('<button>Ok</button>');
    const blocks = await service.blocks();
    expect(blocks.map((b) => [b.category, b.name])).toEqual([
      ['Ações', 'Botão'],
      ['Meus blocos', 'Campo'],
    ]);
    await service.deleteBlock(a.id);
    expect(await service.blocks()).toHaveLength(1);
    await expect(service.deleteBlock(a.id)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('refuses a block over the size limit and over the count limit', async () => {
    await expect(
      service.createBlock({
        name: 'Grande',
        html: `<p>${'x'.repeat(PROTOTYPE_LIMITS.maxBlockBytes)}</p>`,
      }),
    ).rejects.toMatchObject({ httpStatus: 413 });
    const repo = new SqlitePrototypeRepository(handle.db);
    const spy = Object.assign(Object.create(repo) as object, {
      countBlocks: async () => PROTOTYPE_LIMITS.maxBlocks,
    }) as SqlitePrototypeRepository;
    const limited = new PrototypeService({
      repo: spy,
      files: new ObjectPrototypeStore(scopeObjectStore(store, '', 'prototypes')),
      sessions: new SqliteSessionLookup(handle.db),
      clock,
      ids: seqIds(),
    });
    await expect(limited.createBlock({ name: 'X', html: '<p/>' })).rejects.toMatchObject({
      httpStatus: 409,
    });
  });
});
