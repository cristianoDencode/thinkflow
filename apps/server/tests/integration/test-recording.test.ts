import type { TestSessionDto, TestStepImageDto } from '@thinkflow/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScreenSettler } from '../../src/contexts/testing/domain/settle';
import {
  buttonFacts,
  fieldFacts,
  FakeRecorderBrowser,
  instantSettler,
} from '../testing/fake-recorder';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BASE = '/api/tests/sessions';

async function setup(recorder = new FakeRecorderBrowser()) {
  t = await createTestApp({ tests: { recorder, settler: instantSettler } });
  const { json } = await t.api<TestSessionDto>('POST', BASE, {
    name: 'Login',
    startUrl: 'https://a.b/login',
  });
  return { t, recorder, id: json.id };
}

const get = (id: string) => t!.api<TestSessionDto>('GET', `${BASE}/${id}`).then((r) => r.json);
const idle = () => t!.container.tests.recording.whenIdle();

describe('recording a session', () => {
  it('keeps the size of the maximized window as the test viewport', async () => {
    const recorder = new FakeRecorderBrowser();
    recorder.windowSize = { width: 1920, height: 969 };
    const { id } = await setup(recorder);
    await t!.api('POST', `${BASE}/${id}/record/start`);
    await idle();
    expect((await get(id)).definition.viewport).toEqual({ width: 1920, height: 969 });
    // a monitor bigger than the supported size is clamped, never rejected
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    recorder.windowSize = { width: 7680, height: 4320 };
    await t!.api('POST', `${BASE}/${id}/record/start`);
    await idle();
    expect((await get(id)).definition.viewport).toEqual({ width: 3840, height: 2160 });
  });

  it('records steps, automatic prints and secret values while the window is open', async () => {
    const { recorder, id } = await setup();
    const started = await t!.api<TestSessionDto>('POST', `${BASE}/${id}/record/start`);
    expect(started.status).toBe(200);
    expect(started.json.state).toBe('recording');
    expect(recorder.started).toEqual([
      {
        url: 'https://a.b/login',
        viewport: { width: 1366, height: 768 },
        maxDownloadBytes: 100 * 1024 * 1024,
      },
    ]);

    recorder.emit({ type: 'fill', facts: fieldFacts('E-mail'), value: 'ana@exemplo.com', at: 1 });
    recorder.emit({
      type: 'fill',
      facts: fieldFacts('Senha', {
        role: null,
        secret: true,
        candidates: [
          { locator: { kind: 'label', text: 'Senha' }, count: 1 },
          { locator: { kind: 'css', selector: '#senha' }, count: 1 },
        ],
      }),
      value: 'segredo-123',
      at: 2,
    });
    recorder.emit({ type: 'click', facts: buttonFacts('Entrar'), at: 3 });
    await idle();

    const s = await get(id);
    expect(s.definition.steps.map((x) => x.kind)).toEqual(['goto', 'fill', 'fill', 'click']);
    expect(s.stepCount).toBe(4);
    // every step got an automatic print (the initial page too), a PNG served by the image route,
    // out of the document by default (the person turns on what should go in)
    const withPrints = s.definition.steps.filter((x) => s.images[x.id]);
    expect(withPrints).toHaveLength(4);
    expect(s.imageCount).toBe(4);
    const print = s.images[withPrints[0]!.id]!;
    expect(print).toMatchObject({ stepId: withPrints[0]!.id, include: false, annotated: false });
    expect(withPrints.every((x) => !s.images[x.id]!.include)).toBe(true);
    expect(print.originalUrl).toContain('/evidences/');
    expect(print.originalUrl).toMatch(/original\.png$/);
    const img = await t!.app.inject({
      method: 'GET',
      url: print.imageUrl,
      headers: { cookie: t!.cookie },
    });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    // the secret never reaches the API, and its field is masked in every screenshot
    expect(JSON.stringify(s)).not.toContain('segredo-123');
    expect(recorder.screenshots.at(-1)!.maskCss).toEqual(
      expect.arrayContaining(['input[type=password]', '#senha']),
    );

    // editing is refused while recording
    expect(
      (await t!.api('DELETE', `${BASE}/${id}/steps/${s.definition.steps[1]!.id}`)).status,
    ).toBe(409);

    const stopped = await t!.api<TestSessionDto>('POST', `${BASE}/${id}/record/stop`);
    expect(stopped.json.state).toBe('idle');
    expect(recorder.closed).toBe(1);
  });

  it('pauses (ignoring actions) and ends when the user closes the window', async () => {
    const { recorder, id } = await setup();
    await t!.api('POST', `${BASE}/${id}/record/start`);
    const paused = await t!.api<TestSessionDto>('POST', `${BASE}/${id}/record/pause`, {
      paused: true,
    });
    expect(paused.json.state).toBe('paused');
    expect(recorder.states).toEqual([{ paused: true }]);
    recorder.emit({ type: 'click', facts: buttonFacts('Ignorado'), at: 1 });
    await t!.api('POST', `${BASE}/${id}/record/pause`, { paused: false });
    recorder.emit({ type: 'click', facts: buttonFacts('Gravado'), at: 2 });
    await idle();
    recorder.userClosed();
    const s = await get(id);
    expect(s.state).toBe('idle');
    expect(s.definition.steps.map((x) => x.target?.description ?? x.kind)).toEqual([
      'goto',
      'botão "Gravado"',
    ]);
  });

  it('allows one recording at a time and explains launch failures', async () => {
    const recorder = new FakeRecorderBrowser();
    const { id } = await setup(recorder);
    const { json: other } = await t!.api<TestSessionDto>('POST', BASE, {
      name: 'b',
      startUrl: 'https://a.b',
    });
    await t!.api('POST', `${BASE}/${id}/record/start`);
    const busy = await t!.api<{ error: { message: string } }>(
      'POST',
      `${BASE}/${other.id}/record/start`,
    );
    expect(busy.status).toBe(409);
    expect(busy.json.error.message).toContain('Já existe uma gravação');
    await t!.api('POST', `${BASE}/${id}/record/stop`);

    recorder.failNextStart =
      'Chromium não encontrado em C:\\x; rode `playwright install chromium`.';
    const failed = await t!.api<{ error: { message: string } }>(
      'POST',
      `${BASE}/${other.id}/record/start`,
    );
    expect(failed.status).toBe(503);
    expect(failed.json.error.message).toContain('Chromium não encontrado');
    expect((await get(other.id)).state).toBe('idle');
  });

  it('refuses to record where no window can be opened', async () => {
    t = await createTestApp({ tests: { display: { canOpenWindow: () => false } } });
    const { json } = await t.api<TestSessionDto>('POST', BASE, {
      name: 'a',
      startUrl: 'https://a.b',
    });
    const res = await t.api<{ error: { code: string } }>('POST', `${BASE}/${json.id}/record/start`);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('recording_unsupported');
  });

  it('keeps recording without prints while the storage is down, with a warning', async () => {
    const { recorder, id } = await setup();
    await t!.api('POST', `${BASE}/${id}/record/start`);
    await idle(); // the initial page is printed while the storage is still up
    t!.store.fail('MinIO fora do ar');
    recorder.emit({ type: 'click', facts: buttonFacts('Entrar'), at: 1 });
    await idle();
    const s = await get(id);
    expect(s.definition.steps).toHaveLength(2);
    expect(Object.keys(s.images)).toEqual([s.definition.steps[0]!.id]);
    expect(s.warning).toContain('prints não estão sendo salvos');
    t!.store.fail(null);
  });
});

describe('automatic print timing', () => {
  /** The first `immediate` waits end at once; the others last until released or aborted. */
  function manualSettler(immediate = 1) {
    const waits: { release(): void; aborted: boolean; maxMs: number }[] = [];
    const settler: ScreenSettler = {
      settle: (_probe, { maxMs, signal }) => {
        if (waits.length < immediate) {
          waits.push({ release() {}, aborted: false, maxMs });
          return Promise.resolve('settled');
        }
        return new Promise((resolve) => {
          const wait = { release: () => resolve('settled'), aborted: false, maxMs };
          waits.push(wait);
          signal?.addEventListener('abort', () => {
            wait.aborted = true;
            resolve('aborted');
          });
          if (signal?.aborted) {
            wait.aborted = true;
            resolve('aborted');
          }
        });
      },
    };
    return { waits, settler };
  }

  async function withSettler(settler: ScreenSettler) {
    const recorder = new FakeRecorderBrowser();
    t = await createTestApp({ tests: { recorder, settler } });
    const { json } = await t.api<TestSessionDto>('POST', BASE, {
      name: 'Login',
      startUrl: 'https://a.b/login',
    });
    await t.api('POST', `${BASE}/${json.id}/record/start`);
    await idle();
    return { recorder, id: json.id };
  }

  it('waits for the screen to settle before the print, with a hard cap', async () => {
    const { waits, settler } = manualSettler();
    const { recorder, id } = await withSettler(settler);
    expect(recorder.screenshots).toHaveLength(1); // the initial page
    recorder.emit({ type: 'click', facts: buttonFacts('Entrar'), at: 1 });
    await vi.waitFor(() => expect(waits).toHaveLength(2));
    // the step is saved, the print is waiting for the page
    expect((await get(id)).definition.steps).toHaveLength(2);
    expect(recorder.screenshots).toHaveLength(1);
    expect(waits[1]!.maxMs).toBe(8000);
    waits[1]!.release();
    await idle();
    expect(recorder.screenshots).toHaveLength(2);
    expect(Object.keys((await get(id)).images)).toHaveLength(2);
  });

  it('takes the print right then when the next action arrives before it settles', async () => {
    const { waits, settler } = manualSettler();
    const { recorder, id } = await withSettler(settler);
    recorder.emit({ type: 'click', facts: buttonFacts('Entrar'), at: 1 });
    await vi.waitFor(() => expect(waits).toHaveLength(2));
    expect(recorder.screenshots).toHaveLength(1);
    // the user acts again: the first step's print is not postponed to a later screen
    recorder.emit({ type: 'click', facts: buttonFacts('Sair'), at: 2 });
    await vi.waitFor(() => expect(recorder.screenshots).toHaveLength(2));
    expect(waits[1]!.aborted).toBe(true);
    await vi.waitFor(() => expect(waits).toHaveLength(3));
    const s = await get(id);
    const [, entrar, sair] = s.definition.steps;
    expect(s.images[entrar!.id]).toBeDefined();
    expect(s.images[sair!.id]).toBeUndefined(); // still waiting for its own screen
    waits[2]!.release();
    await idle();
    expect(Object.keys((await get(id)).images)).toHaveLength(3);
  });

  it('does not wait at all for a print whose next action already arrived', async () => {
    const { waits, settler } = manualSettler();
    const { recorder, id } = await withSettler(settler);
    // two actions in a row: the chain reaches the first one when the second one is already there
    recorder.emit({ type: 'click', facts: buttonFacts('A'), at: 1 });
    recorder.emit({ type: 'click', facts: buttonFacts('B'), at: 2 });
    await vi.waitFor(() => expect(waits.length).toBeGreaterThanOrEqual(3));
    expect(waits[1]!.aborted).toBe(true);
    waits.at(-1)!.release();
    await idle();
    expect(Object.keys((await get(id)).images)).toHaveLength(3);
  });

  it('waits a short time before a manual print and never cuts it short', async () => {
    const { waits, settler } = manualSettler(0);
    const recorder = new FakeRecorderBrowser();
    t = await createTestApp({ tests: { recorder, settler } });
    const { json } = await t.api<TestSessionDto>('POST', BASE, {
      name: 'Prints',
      startUrl: 'https://a.b/login',
    });
    await t.api('POST', `${BASE}/${json.id}/record/start`, { mode: 'capture' });
    const capture = t.api<TestStepImageDto>('POST', `${BASE}/${json.id}/capture`);
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    expect(waits[0]!.maxMs).toBe(3000);
    recorder.emit({ type: 'click', facts: buttonFacts('Entrar'), at: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(waits[0]!.aborted).toBe(false);
    expect(recorder.screenshots).toHaveLength(0);
    waits[0]!.release();
    expect((await capture).status).toBe(201);
    expect(recorder.screenshots).toHaveLength(1);
  });
});

describe('checks while recording', () => {
  it('"Verificar" prints the whole window as a checkpoint step and keeps recording', async () => {
    const waits: { maxMs: number }[] = [];
    const settler: ScreenSettler = {
      settle: async (_read, options) => {
        waits.push({ maxMs: options.maxMs });
        return 'settled';
      },
    };
    const recorder = new FakeRecorderBrowser();
    t = await createTestApp({ tests: { recorder, settler } });
    const { json: created } = await t.api<TestSessionDto>('POST', BASE, {
      name: 'Login',
      startUrl: 'https://a.b/login',
    });
    const id = created.id;
    await t.api('POST', `${BASE}/${id}/record/start`);
    await idle();
    recorder.emit({ type: 'click', facts: buttonFacts('Entrar'), at: 1 });
    await idle();
    waits.length = 0;
    const shots = recorder.screenshots.length;

    const res = await t.api<TestSessionDto>('POST', `${BASE}/${id}/record/checkpoint`);
    expect(res.status).toBe(200);
    // no pick mode: nothing is pushed to the browser, recording just goes on
    expect(res.json.recordingMode).toBe('record');
    expect(recorder.states).toEqual([]);
    expect(waits).toEqual([{ maxMs: 3000 }]); // the manual-print settle wait
    expect(recorder.screenshots.length).toBe(shots + 1);

    // the toolbar button does the same
    recorder.requestCheckpoint();
    await vi.waitFor(async () =>
      expect((await get(id)).definition.steps.filter((x) => x.kind === 'checkpoint')).toHaveLength(
        2,
      ),
    );
    await idle();
    recorder.emit({ type: 'click', facts: buttonFacts('Sair'), at: 5 });
    await idle();

    const s = await get(id);
    expect(s.definition.steps.map((x) => x.kind)).toEqual([
      'goto',
      'click',
      'checkpoint',
      'checkpoint',
      'click',
    ]);
    const checkpoint = s.definition.steps[2]!;
    expect(checkpoint).toMatchObject({ page: { url: 'https://a.b/login' }, comment: null });
    // a deliberate print: stored and in the document; the automatic ones start out of it
    expect(s.images[checkpoint.id]).toMatchObject({ stepId: checkpoint.id, include: true });
    expect(s.images[s.definition.steps[1]!.id]).toMatchObject({ include: false });
    expect(s.images[s.definition.steps[0]!.id]).toMatchObject({ include: false });
    expect(s.images[s.definition.steps[4]!.id]).toMatchObject({ include: false });
  });

  it('"Verificar" needs a recording in the step mode', async () => {
    const { id } = await setup();
    expect((await t!.api('POST', `${BASE}/${id}/record/checkpoint`)).status).toBe(409);
    await t!.api('POST', `${BASE}/${id}/record/start`, { mode: 'capture' });
    expect((await t!.api('POST', `${BASE}/${id}/record/checkpoint`)).status).toBe(409);
    // the old element-pick endpoint is gone
    expect((await t!.api('POST', `${BASE}/${id}/record/verify`, { active: true })).status).toBe(
      404,
    );
  });

  it('checks the current page URL and title', async () => {
    const { id } = await setup();
    await t!.api('POST', `${BASE}/${id}/record/start`);
    await t!.api('POST', `${BASE}/${id}/record/assert-page`, { type: 'urlContains' });
    const res = await t!.api<TestSessionDto>('POST', `${BASE}/${id}/record/assert-page`, {
      type: 'title',
    });
    expect(res.json.definition.steps.slice(-2).map((x) => x.assertion)).toEqual([
      { type: 'urlContains', text: '/painel?aba=1' },
      { type: 'title', text: 'Painel' },
    ]);
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    expect(
      (await t!.api('POST', `${BASE}/${id}/record/assert-page`, { type: 'title' })).status,
    ).toBe(409);
  });
});

describe('recording modes', () => {
  const start = (id: string, body?: unknown) =>
    t!.api<TestSessionDto & { error?: { code: string; message: string } }>(
      'POST',
      `${BASE}/${id}/record/start`,
      body,
    );

  it('records steps by default, stores the mode and continues in it', async () => {
    const { id } = await setup();
    expect((await get(id)).mode).toBeNull();
    const started = await start(id);
    expect(started.json).toMatchObject({ mode: 'record', recordingMode: 'record' });
    expect((await get(id)).definition.mode).toBe('record');
    await idle();
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    // continuing asks for nothing; asking for the other mode is refused
    expect((await start(id)).json.mode).toBe('record');
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    const refused = await start(id, { mode: 'capture' });
    expect(refused.status).toBe(409);
    expect(refused.json.error!.code).toBe('mode_locked');
    expect((await get(id)).state).toBe('idle');
  });

  it('has no manual capture and no mode switching while recording steps', async () => {
    const { recorder, id } = await setup();
    await start(id, { mode: 'record' });
    await idle();
    const refused = await t!.api<{ error: { code: string } }>('POST', `${BASE}/${id}/capture`);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('capture_unavailable');
    recorder.requestCapture(); // toolbar / Ctrl+Shift+S: ignored
    await idle();
    const s = await get(id);
    expect(s.definition.steps.map((x) => x.kind)).toEqual(['goto']);
    // the old switching endpoint is gone
    expect(
      (await t!.api('POST', `${BASE}/${id}/record/capture-only`, { active: true })).status,
    ).toBe(404);
  });

  it('"Só prints": nothing the user does becomes a step, each print is a capture step', async () => {
    const { recorder, id } = await setup();
    const started = await start(id, { mode: 'capture' });
    expect(started.json).toMatchObject({
      state: 'recording',
      recordingMode: 'capture',
      mode: 'capture',
    });
    expect(recorder.states.at(-1)).toEqual({ mode: 'capture' });
    await idle();
    expect((await get(id)).definition.steps).toEqual([]);

    recorder.emit({ type: 'click', facts: buttonFacts('Entrar'), at: 1 });
    recorder.emit({ type: 'navigate', url: 'https://a.b/painel', at: 2 });
    const first = await t!.api<TestStepImageDto>('POST', `${BASE}/${id}/capture`);
    expect(first.status).toBe(201);
    recorder.requestCapture(); // toolbar / Ctrl+Shift+S
    await vi.waitFor(async () => expect((await get(id)).definition.steps).toHaveLength(2));
    await idle();
    const s = await get(id);
    expect(s.definition.steps.map((x) => x.kind)).toEqual(['capture', 'capture']);
    expect(s.definition.steps[0]).toMatchObject({ page: { url: 'https://a.b/login' } });
    expect(Object.keys(s.images)).toEqual(s.definition.steps.map((x) => x.id));
    expect(first.json).toMatchObject({ stepId: s.definition.steps[0]!.id, include: true });
    expect(s.imageCount).toBe(2);

    // pause and checks need recorded steps
    expect((await t!.api('POST', `${BASE}/${id}/record/checkpoint`)).status).toBe(409);
    expect((await t!.api('POST', `${BASE}/${id}/record/pause`, { paused: true })).status).toBe(409);
    expect(
      (await t!.api('POST', `${BASE}/${id}/record/assert-page`, { type: 'title' })).status,
    ).toBe(409);

    // the mode stays: continuing keeps it, the other one is refused
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    expect((await get(id)).mode).toBe('capture');
    expect((await start(id)).json.recordingMode).toBe('capture');
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    expect((await start(id, { mode: 'record' })).status).toBe(409);
  });

  it('lets an empty session choose again, and infers the mode of older sessions', async () => {
    const { id } = await setup();
    await start(id, { mode: 'capture' });
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    // nothing recorded yet: nothing is locked
    expect((await start(id, { mode: 'record' })).json.mode).toBe('record');
    await t!.api('POST', `${BASE}/${id}/record/stop`);

    // a session saved without a mode (older versions): any replayable step = record
    const repo = t!.container.tests.repo;
    const session = (await repo.find(id))!;
    const { mode: _mode, ...definition } = session.definition;
    await repo.save({ ...session, definition });
    expect((await get(id)).mode).toBe('record');
  });

  it('refuses to replay a session that only has prints', async () => {
    const { id } = await setup();
    await start(id, { mode: 'capture' });
    await t!.api('POST', `${BASE}/${id}/capture`);
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    const run = await t!.api<{ error: { message: string } }>('POST', `${BASE}/${id}/runs`, {});
    expect(run.status).toBe(400);
    expect(run.json.error.message).toContain('só de prints');
  });
});

describe('editing steps', () => {
  async function recorded() {
    const { recorder, id } = await setup();
    await t!.api('POST', `${BASE}/${id}/record/start`);
    recorder.emit({ type: 'fill', facts: fieldFacts('E-mail'), value: 'a@b.c', at: 1 });
    recorder.emit({ type: 'click', facts: buttonFacts('Entrar'), at: 2 });
    await idle();
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    return { id, steps: (await get(id)).definition.steps };
  }

  it('comments, leaves a print out, reorders, adds notes and deletes (pruning parameters)', async () => {
    const { id, steps } = await recorded();
    const [goto, fill, click] = steps;

    const commented = await t!.api<TestSessionDto>('PATCH', `${BASE}/${id}/steps/${click!.id}`, {
      comment: 'Botão principal',
    });
    expect(commented.json.definition.steps[2]).toMatchObject({ comment: 'Botão principal' });
    // the print is the step's: its switch is the image's `include`
    const clickImage = commented.json.images[click!.id]!;
    const left = await t!.api<TestStepImageDto>(
      'PATCH',
      `${BASE}/${id}/evidences/${clickImage.id}`,
      { include: false },
    );
    expect(left.json).toMatchObject({ stepId: click!.id, include: false });

    const note = await t!.api<TestSessionDto>('POST', `${BASE}/${id}/steps/notes`, {
      comment: 'Usuário já cadastrado',
      afterStepId: goto!.id,
    });
    expect(note.status).toBe(201);
    expect(note.json.definition.steps.map((s) => s.kind)).toEqual([
      'goto',
      'note',
      'fill',
      'click',
    ]);

    const ids = note.json.definition.steps.map((s) => s.id);
    const reordered = await t!.api<TestSessionDto>('POST', `${BASE}/${id}/steps/reorder`, {
      ids: [ids[0], ids[2], ids[1], ids[3]],
    });
    expect(reordered.json.definition.steps.map((s) => s.kind)).toEqual([
      'goto',
      'fill',
      'note',
      'click',
    ]);
    expect((await t!.api('POST', `${BASE}/${id}/steps/reorder`, { ids: [ids[0]] })).status).toBe(
      400,
    );

    expect(reordered.json.definition.parameters).toHaveLength(1);
    const fillImage = reordered.json.images[fill!.id]!;
    const printKey = `tests/${id}/evidences/${fillImage.id}/original.png`;
    expect(await t!.store.head(printKey)).not.toBeNull();
    const deleted = await t!.api<TestSessionDto>('DELETE', `${BASE}/${id}/steps/${fill!.id}`);
    expect(deleted.json.definition.steps.map((s) => s.kind)).toEqual(['goto', 'note', 'click']);
    expect(deleted.json.definition.parameters).toEqual([]);
    expect(deleted.json.definition.dataSets[0]!.values).toEqual({});
    // the print goes with its step
    expect(await t!.store.head(printKey)).toBeNull();
    expect(Object.keys(deleted.json.images)).not.toContain(fill!.id);
  });

  it('removes only the print of a step (the step stays)', async () => {
    const { id, steps } = await recorded();
    const click = steps[2]!;
    const image = (await get(id)).images[click.id]!;
    expect((await t!.api('DELETE', `${BASE}/${id}/evidences/${image.id}`)).status).toBe(200);
    const s = await get(id);
    expect(s.definition.steps).toHaveLength(3);
    expect(s.images[click.id]).toBeUndefined();
    expect(await t!.store.head(`tests/${id}/evidences/${image.id}/original.png`)).toBeNull();
  });

  it('changes a value to a literal and validates the step', async () => {
    const { id, steps } = await recorded();
    const fill = steps[1]!;
    const lit = await t!.api<TestSessionDto>('PATCH', `${BASE}/${id}/steps/${fill.id}`, {
      value: { literal: 'fixo@exemplo.com' },
    });
    expect(lit.json.definition.steps[1]!.value).toEqual({ literal: 'fixo@exemplo.com' });
    // the parameter is no longer used
    expect(lit.json.definition.parameters).toEqual([]);
    const bad = await t!.api('PATCH', `${BASE}/${id}/steps/${fill.id}`, {
      value: { param: 'nope' },
    });
    expect(bad.status).toBe(400);
    expect((await t!.api('PATCH', `${BASE}/${id}/steps/missing`, { comment: 'x' })).status).toBe(
      404,
    );
  });
});
