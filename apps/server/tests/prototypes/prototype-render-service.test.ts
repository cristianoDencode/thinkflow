import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrototypeRenderService } from '../../src/contexts/prototypes/application/prototype-render-service';
import { PrototypeService } from '../../src/contexts/prototypes/application/prototype-service';
import type { DocumentStepSink } from '../../src/contexts/prototypes/domain/ports';
import { MAX_SENT_TO, withSentTo } from '../../src/contexts/prototypes/domain/prototype';
import { ObjectPrototypeStore } from '../../src/contexts/prototypes/infrastructure/object-prototype-store';
import {
  SqlitePrototypeRepository,
  SqliteSessionLookup,
} from '../../src/contexts/prototypes/infrastructure/sqlite-prototype-repository';
import { openDatabase, type DbHandle } from '../../src/shared/infrastructure/db/client';
import { MemoryObjectStore } from '../../src/shared/infrastructure/storage/memory-object-store';
import { FakeClock } from '../../src/shared/kernel/clock';
import { scopeObjectStore } from '../../src/shared/kernel/scoped-object-store';
import { seqIds } from '../helpers';
import { FakePrototypeRenderer } from './fake-renderer';

let handle: DbHandle;
let store: MemoryObjectStore;
let clock: FakeClock;
let prototypes: PrototypeService;
let renderer: FakePrototypeRenderer;
let service: PrototypeRenderService;
const sunk: unknown[] = [];

const sink: DocumentStepSink = {
  check: async () => undefined,
  addCaptureStep: async (input) => {
    sunk.push(input);
    return { stepId: `step-${sunk.length}` };
  },
  replaceStepImage: async (input) => void sunk.push(input),
};

beforeEach(() => {
  sunk.length = 0;
  handle = openDatabase(':memory:');
  store = new MemoryObjectStore();
  clock = new FakeClock();
  const repo = new SqlitePrototypeRepository(handle.db);
  const files = new ObjectPrototypeStore(scopeObjectStore(store, '', 'prototypes'));
  prototypes = new PrototypeService({
    repo,
    files,
    sessions: new SqliteSessionLookup(handle.db),
    clock,
    ids: seqIds(),
  });
  renderer = new FakePrototypeRenderer();
  service = new PrototypeRenderService({
    prototypes,
    repo,
    files,
    renderer,
    documents: sink,
    clock,
  });
});
afterEach(() => handle.close());

const create = () =>
  prototypes.create({
    name: 'Tela',
    snapshot: { html: '<body>a</body>', css: 'p{}', width: 800, height: 600 },
  });

describe('PrototypeRenderService.render', () => {
  it('renders once per version and scale; force and edits render again', async () => {
    const p = await create();
    const first = await service.render(p.id);
    expect(first).toMatchObject({ cached: false, width: 800, height: 600, scale: 1 });
    expect(first.renderedVersionId).toBe(p.versionId);
    expect(first.thumbnailUrl).toMatch(/^\/api\/prototypes\/.+\/thumbnail\?v=\d+$/);
    expect(await store.head(`prototypes/${p.id}/thumbnail.png`)).not.toBeNull();

    expect((await service.render(p.id)).cached).toBe(true);
    expect(renderer.calls).toHaveLength(1);

    expect((await service.render(p.id, { force: true })).cached).toBe(false);
    expect((await service.render(p.id, { scale: 2 })).width).toBe(1600);
    expect((await service.render(p.id, { scale: 2 })).cached).toBe(true);
    expect(renderer.calls).toHaveLength(3);

    const edited = await prototypes.update(p.id, {
      snapshot: { html: '<body>b</body>', css: '', width: 800, height: 600 },
    });
    const after = await service.render(p.id, { scale: 2 });
    expect(after).toMatchObject({ cached: false, renderedVersionId: edited.versionId });
  });

  it('shares the work of simultaneous renders of the same prototype', async () => {
    const p = await create();
    const [a, b] = await Promise.all([service.render(p.id), service.render(p.id)]);
    expect(a).toEqual(b);
    expect(renderer.calls).toHaveLength(1);
  });

  it('503 when Chromium is unavailable, 502 for other failures; nothing is stored', async () => {
    const p = await create();
    renderer.failWith = { error: 'sem navegador', unavailable: true };
    await expect(service.render(p.id)).rejects.toMatchObject({
      httpStatus: 503,
      code: 'renderer_unavailable',
    });
    renderer.failWith = { error: 'travou', unavailable: false };
    await expect(service.render(p.id)).rejects.toMatchObject({ httpStatus: 502 });
    expect((await prototypes.get(p.id)).thumbnailUrl).toBeNull();
    expect(await prototypes.thumbnail(p.id)).toBeNull();
  });

  it('is not an edit: updatedAt and the version list stay as they were', async () => {
    const p = await create();
    clock.advance(5000);
    await service.render(p.id);
    const after = await prototypes.get(p.id);
    expect(after.updatedAt).toBe(p.updatedAt);
    expect(after.versionCount).toBe(1);
  });
});

describe('PrototypeRenderService.sendToSession', () => {
  it('needs a session, defaults the title and caps/dedupes sentTo', async () => {
    const p = await create();
    await expect(service.sendToSession(p.id, { target: 'newStep' })).rejects.toMatchObject({
      httpStatus: 409,
    });
    const res = await service.sendToSession(p.id, { target: 'newStep', sessionId: 's1' });
    expect(sunk[0]).toMatchObject({
      sessionId: 's1',
      title: 'Protótipo: Tela',
      include: true,
      width: 800,
      height: 600,
    });
    expect(res.sentTo).toEqual([{ sessionId: 's1', stepId: 'step-1', at: clock.now() }]);
  });

  it('withSentTo keeps one entry per step, newest last, capped', () => {
    let list = withSentTo([], { sessionId: 's', stepId: 'a', at: 1 });
    list = withSentTo(list, { sessionId: 's', stepId: 'b', at: 2 });
    list = withSentTo(list, { sessionId: 's', stepId: 'a', at: 3 });
    expect(list.map((e) => [e.stepId, e.at])).toEqual([
      ['b', 2],
      ['a', 3],
    ]);
    for (let i = 0; i < MAX_SENT_TO + 5; i++)
      list = withSentTo(list, { sessionId: 's', stepId: `x${i}`, at: i });
    expect(list).toHaveLength(MAX_SENT_TO);
    expect(list.at(-1)!.stepId).toBe(`x${MAX_SENT_TO + 4}`);
  });
});
