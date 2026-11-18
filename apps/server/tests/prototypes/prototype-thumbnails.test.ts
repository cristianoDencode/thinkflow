import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrototypeRenderService } from '../../src/contexts/prototypes/application/prototype-render-service';
import { PrototypeService } from '../../src/contexts/prototypes/application/prototype-service';
import { PrototypeThumbnails } from '../../src/contexts/prototypes/application/prototype-thumbnails';
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

const DEBOUNCE = 25;

let handle: DbHandle;
let prototypes: PrototypeService;
let renderer: FakePrototypeRenderer;
let thumbnails: PrototypeThumbnails;
let errors: unknown[];
let hook: (id: string) => void;

beforeEach(() => {
  errors = [];
  handle = openDatabase(':memory:');
  const clock = new FakeClock();
  const repo = new SqlitePrototypeRepository(handle.db);
  const files = new ObjectPrototypeStore(
    scopeObjectStore(new MemoryObjectStore(), '', 'prototypes'),
  );
  hook = (id) => thumbnails.schedule(id);
  prototypes = new PrototypeService({
    repo,
    files,
    sessions: new SqliteSessionLookup(handle.db),
    clock,
    ids: seqIds(),
    onVersionSaved: (id) => hook(id),
  });
  renderer = new FakePrototypeRenderer();
  const render = new PrototypeRenderService({
    prototypes,
    repo,
    files,
    renderer,
    documents: {
      check: async () => undefined,
      addCaptureStep: async () => ({ stepId: 's' }),
      replaceStepImage: async () => undefined,
    },
    clock,
  });
  thumbnails = new PrototypeThumbnails({
    prototypes,
    render,
    debounceMs: DEBOUNCE,
    onError: (err) => errors.push(err),
  });
});
afterEach(() => {
  thumbnails.stop();
  handle.close();
});

const snapshot = (html: string) => ({ html, css: 'p{}', width: 800, height: 600 });
const settle = () => new Promise((r) => setTimeout(r, DEBOUNCE * 4));

describe('thumbnails in the background', () => {
  it('renders a captured screen after the quiet period, without blocking the save', async () => {
    const captured = await prototypes.createFromCapture({
      sessionId: null as unknown as string,
      stepId: null,
      menuPath: null,
      keepData: false,
      screen: {
        html: '<body><p>oi</p></body>',
        css: 'p{}',
        width: 800,
        height: 600,
        url: null,
        title: 'Tela',
      },
    });
    expect(captured.thumbnailUrl).toBeNull();
    expect(renderer.calls).toHaveLength(0);

    await vi.waitFor(async () => {
      expect((await prototypes.list())[0]?.thumbnailUrl).toMatch(/\/thumbnail\?v=/);
    });
    expect(renderer.calls).toHaveLength(1);
  });

  it('renders once for a burst of versions, and renders the newest one', async () => {
    const p = await prototypes.create({ name: 'A', snapshot: snapshot('<body>1</body>') });
    await prototypes.update(p.id, { snapshot: snapshot('<body>2</body>') });
    const last = await prototypes.update(p.id, { snapshot: snapshot('<body>3</body>') });
    await settle();
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0]!.document).toContain('<body>3</body>');
    const found = (await prototypes.list())[0]!;
    expect(found.thumbnailUrl).not.toBeNull();
    expect((await prototypes.require(p.id)).renderedVersionId).toBe(last.versionId);
  });

  it('renders the full CSS (base + edits) and keeps the tf-edits marker through PUT and restore', async () => {
    const css = 'p{color:red}\n/* tf-edits */\n#a{margin:1px}';
    const p = await prototypes.create({
      name: 'A',
      snapshot: {
        html: '<body><p id="a">1</p></body>',
        css: 'p{color:red}',
        width: 800,
        height: 600,
      },
    });
    const edited = await prototypes.update(p.id, {
      snapshot: { html: '<body><p id="a">2</p></body>', css, width: 800, height: 600 },
    });
    expect(edited.css).toBe(css);
    await settle();
    expect(renderer.calls.at(-1)!.document).toContain(css);
    await prototypes.update(p.id, {
      snapshot: { html: '<body>3</body>', css: 'p{}', width: 800, height: 600 },
    });
    const restored = await prototypes.restore(p.id, edited.versionId);
    expect(restored.css).toBe(css);
    await settle();
    expect(renderer.calls.at(-1)!.document).toContain(css);
  });

  it('renders again after a restore', async () => {
    const p = await prototypes.create({ name: 'A', snapshot: snapshot('<body>1</body>') });
    await settle();
    expect(renderer.calls).toHaveLength(1);
    await prototypes.update(p.id, { snapshot: snapshot('<body>2</body>') });
    await settle();
    expect(renderer.calls).toHaveLength(2);
    await prototypes.restore(p.id, p.versionId);
    await settle();
    expect(renderer.calls).toHaveLength(3);
    expect(renderer.calls[2]!.document).toContain('<body>1</body>');
  });

  it('only reports a failed render and still saves', async () => {
    renderer.failWith = { error: 'sem Chromium', unavailable: true };
    const p = await prototypes.create({ name: 'A', snapshot: snapshot('<body>1</body>') });
    await settle();
    expect(errors).toHaveLength(1);
    expect((await prototypes.require(p.id)).thumbnailKey).toBeNull();
  });

  it('ignores a prototype deleted before its turn', async () => {
    const p = await prototypes.create({ name: 'A', snapshot: snapshot('<body>1</body>') });
    await prototypes.delete(p.id);
    await settle();
    expect(errors).toEqual([]);
    expect(renderer.calls).toHaveLength(0);
  });

  it('drops what is waiting when stopped', async () => {
    await prototypes.create({ name: 'A', snapshot: snapshot('<body>1</body>') });
    thumbnails.stop();
    await settle();
    expect(renderer.calls).toHaveLength(0);
  });

  it('never fails a save because the hook failed', async () => {
    hook = () => {
      throw new Error('boom');
    };
    const created = await prototypes.create({ name: 'A', snapshot: snapshot('<body>1</body>') });
    expect(created.name).toBe('A');
  });
});
