import {
  PROTOTYPE_LIMITS,
  type PrototypeBlockDto,
  type PrototypeCaptureResultDto,
  type PrototypeDetailDto,
  type PrototypeDto,
  type TestSessionDto,
} from '@thinkflow/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePrototypeRenderer } from '../prototypes/fake-renderer';
import { FakeRecorderBrowser, instantSettler } from '../testing/fake-recorder';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const API = '/api/prototypes';
const SESSIONS = '/api/tests/sessions';

async function setup(recorder = new FakeRecorderBrowser()) {
  t = await createTestApp({ tests: { recorder, settler: instantSettler } });
  return { t, recorder };
}

describe('prototype thumbnails', () => {
  it('show up in the list after a save, without asking for the image', async () => {
    const renderer = new FakePrototypeRenderer();
    t = await createTestApp({
      tests: { recorder: new FakeRecorderBrowser(), settler: instantSettler },
      prototypes: { renderer, thumbnailDebounceMs: 10 },
    });
    const created = await t.api<PrototypeDetailDto>('POST', API, {
      name: 'Tela',
      snapshot: { html: '<body>a</body>', css: '', width: 800, height: 600 },
    });
    expect(created.json.thumbnailUrl).toBeNull();
    await vi.waitFor(async () => {
      const list = await t!.api<PrototypeDto[]>('GET', API);
      expect(list.json[0]?.thumbnailUrl).toMatch(/thumbnail/);
    });

    // a new version makes a new image
    await t.api('PUT', `${API}/${created.json.id}`, {
      snapshot: { html: '<body>b</body>', css: '', width: 800, height: 600 },
    });
    await vi.waitFor(() => expect(renderer.calls).toHaveLength(2));
    expect(renderer.calls[1]!.document).toContain('<body>b</body>');
  });
});

describe('stored CSS', () => {
  it('round-trips the editor marker (base + "/* tf-edits */" + edits) unchanged through PUT and GET', async () => {
    const { t } = await setup();
    const created = await t.api<PrototypeDetailDto>('POST', API, {
      name: 'Tela',
      snapshot: {
        html: '<body><p id="a">a</p></body>',
        css: 'p{color:red}',
        width: 800,
        height: 600,
      },
    });
    const css =
      'p{color:red}\n@media (min-width:1px){p{x:y}}\n/* tf-edits */\n#a{margin:1px}\n.b::before{content:"1"}';
    const put = await t.api<PrototypeDetailDto>('PUT', `${API}/${created.json.id}`, {
      snapshot: { html: '<body><p id="a">a</p></body>', css, width: 800, height: 600 },
    });
    expect(put.json.css).toBe(css);
    expect((await t.api<PrototypeDetailDto>('GET', `${API}/${created.json.id}`)).json.css).toBe(
      css,
    );
  });
});

describe('prototype routes', () => {
  it('require a session', async () => {
    const { t } = await setup();
    for (const [method, url] of [
      ['GET', API],
      ['POST', API],
      ['GET', `${API}/x`],
      ['PUT', `${API}/x`],
      ['DELETE', `${API}/x`],
      ['GET', `${API}/blocks`],
      ['POST', `${API}/x/render`],
      ['POST', `${SESSIONS}/x/record/prototype`],
    ] as const) {
      const res = await t.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('creates, lists, reads, renames and deletes a prototype', async () => {
    const { t } = await setup();
    const created = await t.api<PrototypeDetailDto>('POST', API, {
      name: 'Consulta',
      snapshot: {
        html: '<body><p onclick="x()">oi</p></body>',
        css: 'p{color:red}',
        width: 1000,
        height: 600,
      },
      source: { url: 'https://a.b/x.php?q=1', menuPath: 'A > B' },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      name: 'Consulta',
      html: '<body><p>oi</p></body>',
      css: 'p{color:red}',
      source: { url: 'https://a.b/x.php', file: 'x.php', menuPath: 'A > B' },
    });

    const list = await t.api<PrototypeDto[]>('GET', API);
    expect(list.json.map((p) => p.id)).toEqual([created.json.id]);
    expect(list.json[0]).not.toHaveProperty('html');

    const got = await t.api<PrototypeDetailDto>('GET', `${API}/${created.json.id}`);
    expect(got.json.html).toBe('<body><p>oi</p></body>');

    const renamed = await t.api<PrototypeDetailDto>('PUT', `${API}/${created.json.id}`, {
      name: 'Outro nome',
    });
    expect(renamed.json).toMatchObject({ name: 'Outro nome', versionCount: 1 });

    expect((await t.api('DELETE', `${API}/${created.json.id}`)).status).toBe(204);
    expect((await t.api('GET', `${API}/${created.json.id}`)).status).toBe(404);
    expect((await t.api('DELETE', `${API}/${created.json.id}`)).status).toBe(404);
  });

  it('versions: read an old one, restore it, and /render says why without Chromium (503)', async () => {
    const { t } = await setup();
    const created = await t.api<PrototypeDetailDto>('POST', API, {
      name: 'A',
      snapshot: { html: '<p>1</p>', css: '', width: 800, height: 600 },
    });
    const id = created.json.id;
    const edited = await t.api<PrototypeDetailDto>('PUT', `${API}/${id}`, {
      snapshot: { html: '<p>2</p>', css: 'a{b:c}', width: 900, height: 650 },
      note: 'Segunda',
    });
    expect(edited.json.versions.map((v) => v.note)).toEqual(['Segunda', 'Importado']);

    const old = await t.api('GET', `${API}/${id}/versions/${created.json.versionId}`);
    expect(old.json).toEqual({ html: '<p>1</p>', css: '', width: 800, height: 600 });
    expect((await t.api('GET', `${API}/${id}/versions/nao-existe`)).status).toBe(404);

    const restored = await t.api<PrototypeDetailDto>(
      'POST',
      `${API}/${id}/versions/${created.json.versionId}/restore`,
    );
    expect(restored.json).toMatchObject({ versionCount: 3, html: '<p>1</p>', width: 800 });

    const render = await t.api<{ error: { code: string; message: string } }>(
      'POST',
      `${API}/${id}/render`,
    );
    expect(render.status).toBe(503);
    expect(render.json.error.code).toBe('renderer_unavailable');
    expect(render.json.error.message).toMatch(/Chromium/);
  });

  it('validates input and enforces the limits (400 / 413)', async () => {
    const { t } = await setup();
    expect((await t.api('POST', API, { name: '' })).status).toBe(400);
    expect(
      (
        await t.api('POST', API, {
          name: 'A',
          snapshot: { html: '<p/>', css: '', width: 10, height: 600 },
        })
      ).status,
    ).toBe(400);
    expect((await t.api('POST', API, { name: 'A', sessionId: 'nao-existe' })).status).toBe(404);
    expect((await t.api('GET', `${API}?sessionId=${'x'.repeat(200)}`)).status).toBe(400);

    const big = await t.api<{ error: { code: string } }>('POST', API, {
      name: 'Grande',
      snapshot: {
        html: `<p>${'x'.repeat(PROTOTYPE_LIMITS.maxSnapshotBytes + 10)}</p>`,
        css: '',
        width: 800,
        height: 600,
      },
    });
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe('prototype_too_large');
    expect((await t.api<PrototypeDto[]>('GET', API)).json).toEqual([]);
  });

  it('blocks: save, list, delete', async () => {
    const { t } = await setup();
    const block = await t.api<PrototypeBlockDto>('POST', `${API}/blocks`, {
      name: 'Barra de botões',
      html: '<div><script>x()</script><button>Ok</button></div>',
      css: '.a{b:c}',
    });
    expect(block.status).toBe(201);
    expect(block.json).toMatchObject({
      category: 'Meus blocos',
      html: '<div><button>Ok</button></div>',
    });
    expect((await t.api<PrototypeBlockDto[]>('GET', `${API}/blocks`)).json).toHaveLength(1);
    expect((await t.api('POST', `${API}/blocks`, { name: 'x', html: '' })).status).toBe(400);
    expect(
      (
        await t.api('POST', `${API}/blocks`, {
          name: 'x',
          html: `<p>${'x'.repeat(PROTOTYPE_LIMITS.maxBlockBytes + 1)}</p>`,
        })
      ).status,
    ).toBe(413);
    expect((await t.api('DELETE', `${API}/blocks/${block.json.id}`)).status).toBe(204);
    expect((await t.api('DELETE', `${API}/blocks/${block.json.id}`)).status).toBe(404);
  });

  it('keeps the HTML of a prototype in the prototypes/ scope of the object store', async () => {
    const { t } = await setup();
    const created = await t.api<PrototypeDetailDto>('POST', API, { name: 'A' });
    const keys = [];
    for await (const info of t.store.list('')) keys.push(info.key);
    expect(keys.filter((k) => k.startsWith('prototypes/'))).toEqual([
      `prototypes/${created.json.id}/${created.json.versionId}.json`,
    ]);
  });
});

describe('prototypes linked to test sessions', () => {
  it('are unlinked, not deleted, when the session is deleted', async () => {
    const { t } = await setup();
    const session = await t.api<TestSessionDto>('POST', SESSIONS, {
      name: 'Minha sessão',
      startUrl: 'https://a.b/',
    });
    const linked = await t.api<PrototypeDetailDto>('POST', API, {
      name: 'A',
      sessionId: session.json.id,
    });
    expect(linked.json).toMatchObject({ sessionId: session.json.id, sessionName: 'Minha sessão' });
    const filtered = await t.api<PrototypeDto[]>('GET', `${API}?sessionId=${session.json.id}`);
    expect(filtered.json).toHaveLength(1);

    expect((await t.api('DELETE', `${SESSIONS}/${session.json.id}`)).status).toBe(200);
    const after = await t.api<PrototypeDetailDto>('GET', `${API}/${linked.json.id}`);
    expect(after.status).toBe(200);
    expect(after.json).toMatchObject({ sessionId: null, sessionName: null, stepId: null });
    expect(
      (await t.api<PrototypeDto[]>('GET', `${API}?sessionId=${session.json.id}`)).json,
    ).toEqual([]);
  });

  it('can be linked, moved and unlinked with PUT', async () => {
    const { t } = await setup();
    const a = await t.api<TestSessionDto>('POST', SESSIONS, {
      name: 'A',
      startUrl: 'https://a.b/',
    });
    const proto = await t.api<PrototypeDetailDto>('POST', API, { name: 'P' });
    const linked = await t.api<PrototypeDetailDto>('PUT', `${API}/${proto.json.id}`, {
      sessionId: a.json.id,
    });
    expect(linked.json.sessionName).toBe('A');
    const unlinked = await t.api<PrototypeDetailDto>('PUT', `${API}/${proto.json.id}`, {
      sessionId: null,
    });
    expect(unlinked.json.sessionId).toBeNull();
  });
});

describe('capturing the current screen while recording', () => {
  const start = async (mode: 'record' | 'capture') => {
    const { t, recorder } = await setup();
    const session = await t.api<TestSessionDto>('POST', SESSIONS, {
      name: 'Sessão',
      startUrl: 'https://a.b/',
    });
    await t.api('POST', `${SESSIONS}/${session.json.id}/record/start`, { mode });
    await t.container.tests.recording.whenIdle();
    return { t, recorder, id: session.json.id };
  };

  it('needs a recording in progress', async () => {
    const { t } = await setup();
    const session = await t.api<TestSessionDto>('POST', SESSIONS, {
      name: 'S',
      startUrl: 'https://a.b/',
    });
    const res = await t.api<{ error: { code: string } }>(
      'POST',
      `${SESSIONS}/${session.json.id}/record/prototype`,
    );
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('not_recording');
  });

  it('is refused while recording steps: a prototype is a screen of "Só prints"', async () => {
    const { t, recorder, id } = await start('record');
    const res = await t.api<{ error: { code: string } }>(
      'POST',
      `${SESSIONS}/${id}/record/prototype`,
      {},
    );
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('prototype_capture_mode_only');
    expect(recorder.prototypeCaptures).toBe(0);
    // the toolbar of the browser does not show the button in this mode; a stray request is ignored
    recorder.requestPrototype();
    await t.container.tests.recording.whenIdle();
    expect(recorder.prototypeCaptures).toBe(0);
    expect((await t.api<PrototypeDto[]>('GET', API)).json).toEqual([]);
    expect((await t.api<TestSessionDto>('GET', `${SESSIONS}/${id}`)).json.state).toBe('recording');
  });

  it('creates a scrubbed prototype linked to the session and its current step, with the components', async () => {
    const { t, recorder, id } = await start('capture');
    recorder.screen = {
      html: '<body><label>Código</label><input value="123"><table><tr><th>Nº</th></tr><tr><td>2026/9</td></tr></table><div>Usuário 52998224725</div></body>',
      css: 'label{color:#111}',
      width: 1100,
      height: 650,
      url: 'https://a.b/w/2/emp1_empconsulta001.php?e=1',
      title: 'Consulta Empenho',
      blankFrames: 1,
    };
    // "Só prints": the current step is the last capture
    const shot = await t.api<{ stepId: string }>('POST', `${SESSIONS}/${id}/capture`);
    expect(shot.status).toBe(201);
    const session = (await t.api<TestSessionDto>('GET', `${SESSIONS}/${id}`)).json;
    const lastStep = session.definition.steps.at(-1)!;

    const res = await t.api<PrototypeCaptureResultDto>(
      'POST',
      `${SESSIONS}/${id}/record/prototype`,
      {},
    );
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      sessionId: id,
      sessionName: 'Sessão',
      stepId: lastStep.id,
      scrubbed: true,
      width: 1100,
      height: 650,
      versionCount: 1,
      components: { field: 1, grid: 1 },
      source: {
        url: 'https://a.b/w/2/emp1_empconsulta001.php',
        file: 'emp1_empconsulta001.php',
        title: 'Consulta Empenho',
        menuPath: null, // "Só prints" records no menu clicks
      },
    });
    expect(res.json.warnings).toEqual([expect.stringContaining('1 quadro(s)')]);
    expect(res.json.name).toMatch(/^emp1_empconsulta001\.php — /);
    const detail = await t.api<PrototypeDetailDto>('GET', `${API}/${res.json.id}`);
    // values and cells gone, the user's CPF replaced, components annotated
    expect(detail.json.html).toBe(
      '<body><label>Código</label><input data-ec="field"><table data-ec="grid"><tr data-ec-part="header"><th>Nº</th></tr><tr data-ec-part="row"><td data-ec-part="cell">—</td></tr></table><div>Usuário 00000000000</div></body>',
    );
    expect(detail.json.components).toEqual({ field: 1, grid: 1 });
    expect(detail.json.css).toBe('label{color:#111}');
    expect(detail.json.versions[0]!.note).toBe('Captura');

    // the session goes on and the capture added no step
    const after = (await t.api<TestSessionDto>('GET', `${SESSIONS}/${id}`)).json;
    expect(after.state).toBe('recording');
    expect(after.definition.steps).toHaveLength(session.definition.steps.length);
    expect(recorder.prototypeCaptures).toBe(1);
  });

  it('keepData stores values and cells; the toolbar button works', async () => {
    const { t, recorder, id } = await start('capture');
    recorder.screen = { ...recorder.screen!, html: '<body><input value="Ana"></body>' };
    const kept = await t.api<PrototypeDto>('POST', `${SESSIONS}/${id}/record/prototype`, {
      keepData: true,
    });
    expect(kept.json.scrubbed).toBe(false);
    expect(kept.json.stepId).toBeNull(); // "Só prints": nothing was recorded as a step yet
    expect((await t.api<PrototypeDetailDto>('GET', `${API}/${kept.json.id}`)).json.html).toBe(
      '<body><input value="Ana" data-ec="field"></body>',
    );

    // toolbar "Protótipo" inside the recorded browser
    recorder.requestPrototype();
    await t.container.tests.recording.whenIdle();
    const all = (await t.api<PrototypeDto[]>('GET', `${API}?sessionId=${id}`)).json;
    expect(all).toHaveLength(2);
    expect(all.some((p) => p.scrubbed)).toBe(true);
  });

  it('reports a closed page and a refused capture without losing the recording', async () => {
    const { t, recorder, id } = await start('capture');
    recorder.screen = null;
    const res = await t.api<{ error: { code: string } }>(
      'POST',
      `${SESSIONS}/${id}/record/prototype`,
    );
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('page_closed');
    expect((await t.api<TestSessionDto>('GET', `${SESSIONS}/${id}`)).json.state).toBe('recording');
  });

  it('is refused (413) when the captured screen is too big, and says why on the toolbar path', async () => {
    const { t, recorder, id } = await start('capture');
    recorder.screen = {
      ...recorder.screen!,
      html: `<body>${'x'.repeat(PROTOTYPE_LIMITS.maxSnapshotBytes + 1)}</body>`,
    };
    const res = await t.api('POST', `${SESSIONS}/${id}/record/prototype`);
    expect(res.status).toBe(413);
    expect((await t.api<PrototypeDto[]>('GET', API)).json).toEqual([]);

    recorder.requestPrototype();
    await t.container.tests.recording.whenIdle();
    const session = (await t.api<TestSessionDto>('GET', `${SESSIONS}/${id}`)).json;
    expect(session.warning).toMatch(/excede o tamanho máximo/);
  });
});
