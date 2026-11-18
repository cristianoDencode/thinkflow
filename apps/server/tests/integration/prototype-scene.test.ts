import { createHash } from 'node:crypto';
import {
  PROTOTYPE_LIMITS,
  type PrototypeDetailDto,
  type PrototypeRenderDto,
  type PrototypeScene,
  type SceneAssetDto,
  type SceneFromHtmlDto,
} from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { fakePng, FakePrototypeRenderer } from '../prototypes/fake-renderer';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const API = '/api/prototypes';

const SCREEN = `<body style="margin:0;background:#e0e0e0">
  <div data-ec="window-title"><span data-ec-part="title">Consulta</span></div>
  <fieldset data-ec="fieldset"><legend data-ec-part="legend">Filtros</legend>
    <table><tr data-ec="lookup"><td data-ec-part="label">Reduzido:</td><td><input data-ec-part="input"></td></tr>
    <tr data-ec="date"><td data-ec-part="label">Data Emissão:</td><td><input data-ec-part="input" type="date"></td></tr></table>
  </fieldset>
  <div data-ec="button-bar"><input type="button" data-ec-part="button" value="Pesquisa"></div></body>`;

async function setup() {
  const renderer = new FakePrototypeRenderer();
  t = await createTestApp({ prototypes: { renderer, thumbnailDebounceMs: 3_600_000 } });
  const created = await t.api<PrototypeDetailDto>('POST', API, {
    name: 'Tela X',
    snapshot: { html: SCREEN, css: 'body{font:11px Arial}', width: 800, height: 600 },
  });
  return { t, renderer, id: created.json.id };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Status of GET /assets/:asset (the body is a PNG, which `t.api` cannot parse as JSON). */
const assetStatus = async (id: string, asset: string) =>
  (
    await t!.app.inject({
      method: 'GET',
      url: `${API}/${id}/assets/${asset}`,
      headers: { cookie: t!.cookie },
    })
  ).statusCode;

const upload = (id: string, png: Uint8Array) =>
  t!.api<SceneAssetDto>('POST', `${API}/${id}/assets`, { png: b64(png) });

const sceneWith = (asset: string): PrototypeScene => ({
  version: 1,
  background: { asset },
  layers: [
    {
      id: 'a1',
      name: 'Imagem',
      type: 'image',
      x: 10,
      y: 20,
      width: 100,
      height: 20,
      visible: true,
      locked: false,
      image: { asset },
    },
    {
      id: 't1',
      name: 'Texto',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      visible: true,
      locked: false,
      text: {
        value: 'Olá',
        fontSize: 11,
        fontFamily: 'Arial',
        color: '#000',
        bold: false,
        align: 'left',
      },
    },
  ],
});

describe('scene assets', () => {
  it('stores a PNG by its hash, dedupes it and serves it with long-lived cache headers', async () => {
    const { t, id } = await setup();
    const png = fakePng(30, 20, 7);
    const first = await upload(id, png);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ asset: sha(png), width: 30, height: 20 });
    expect((await upload(id, png)).json.asset).toBe(first.json.asset);
    const keys = [];
    for await (const o of t.store.list(`prototypes/${id}/assets/`)) keys.push(o.key);
    expect(keys).toHaveLength(1);

    const res = await t.app.inject({
      method: 'GET',
      url: `${API}/${id}/assets/${first.json.asset}`,
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(new Uint8Array(res.rawPayload)).toEqual(png);
  });

  it('refuses what is not a PNG, and an unknown id or prototype is 404', async () => {
    const { t, id } = await setup();
    expect((await upload(id, new Uint8Array(40))).status).toBe(400);
    const notBase64 = await t.api('POST', `${API}/${id}/assets`, { png: 'isto não é base64!' });
    expect(notBase64.status).toBe(400);
    expect((await t.api('POST', `${API}/${id}/assets`, {})).status).toBe(400);
    expect((await upload('nope', fakePng(2, 2))).status).toBe(404);

    const other = await t.api<PrototypeDetailDto>('POST', API, {
      name: 'Outra',
      snapshot: { html: '<body></body>', css: '', width: 400, height: 300 },
    });
    const { json } = await upload(id, fakePng(5, 5));
    // an asset of one prototype is not visible through another
    expect(await assetStatus(other.json.id, json.asset)).toBe(404);
    expect(await assetStatus(id, 'f'.repeat(64))).toBe(404);
    expect((await t.api('GET', `${API}/${id}/assets/not-a-hash`)).status).toBe(400);
    expect((await t.api('GET', `${API}/nope/assets/${json.asset}`)).status).toBe(404);
  });

  it('are removed together with their prototype', async () => {
    const { t, id } = await setup();
    const { json } = await upload(id, fakePng(5, 5));
    expect(await t.store.head(`prototypes/${id}/assets/${json.asset}.png`)).not.toBeNull();
    expect((await t.api('DELETE', `${API}/${id}`)).status).toBe(204);
    expect(await t.store.head(`prototypes/${id}/assets/${json.asset}.png`)).toBeNull();
  });

  it('refuses an image over the limit', async () => {
    const { id } = await setup();
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    big.set(fakePng(10, 10));
    expect((await upload(id, big)).status).toBe(413);
  });
});

describe('versions with a scene', () => {
  it('saves and returns the scene (PUT, GET, version and restore), and works without one', async () => {
    const { t, id } = await setup();
    const { json: asset } = await upload(id, fakePng(100, 20, 1));
    const scene = sceneWith(asset.asset);
    const saved = await t.api<PrototypeDetailDto>('PUT', `${API}/${id}`, {
      snapshot: { html: SCREEN, css: '', width: 800, height: 600, scene },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.scene).toEqual(scene);
    expect((await t.api<PrototypeDetailDto>('GET', `${API}/${id}`)).json.scene).toEqual(scene);

    // a plain HTML version afterwards has no scene; the earlier one still has
    const plain = await t.api<PrototypeDetailDto>('PUT', `${API}/${id}`, {
      snapshot: { html: '<body>x</body>', css: '', width: 800, height: 600 },
    });
    expect(plain.json.scene).toBeUndefined();
    const sceneVersion = saved.json.versionId;
    const old = await t.api<{ scene?: PrototypeScene }>(
      'GET',
      `${API}/${id}/versions/${sceneVersion}`,
    );
    expect(old.json.scene).toEqual(scene);
    const restored = await t.api<PrototypeDetailDto>(
      'POST',
      `${API}/${id}/versions/${sceneVersion}/restore`,
    );
    expect(restored.json.scene).toEqual(scene);
  });

  it('refuses a scene that uses an image the prototype does not have', async () => {
    const { t, id } = await setup();
    const res = await t.api<{ error?: unknown }>('PUT', `${API}/${id}`, {
      snapshot: {
        html: SCREEN,
        css: '',
        width: 800,
        height: 600,
        scene: sceneWith('c'.repeat(64)),
      },
    });
    expect(res.status).toBe(400);
    expect((await t.api<PrototypeDetailDto>('GET', `${API}/${id}`)).json.versionCount).toBe(1);

    // an image of ANOTHER prototype does not count either
    const other = await t.api<PrototypeDetailDto>('POST', API, {
      name: 'Outra',
      snapshot: { html: '<body></body>', css: '', width: 400, height: 300 },
    });
    const { json } = await upload(other.json.id, fakePng(4, 4));
    const again = await t.api('PUT', `${API}/${id}`, {
      snapshot: { html: SCREEN, css: '', width: 800, height: 600, scene: sceneWith(json.asset) },
    });
    expect(again.status).toBe(400);
  });

  it('rejects a malformed scene', async () => {
    const { t, id } = await setup();
    const bad = await t.api('PUT', `${API}/${id}`, {
      snapshot: {
        html: SCREEN,
        css: '',
        width: 800,
        height: 600,
        scene: { version: 1, background: null, layers: [{ id: 'x', name: 'y', type: 'image' }] },
      },
    });
    expect(bad.status).toBe(400);
  });

  it('creates a prototype with a scene that needs no image, but not one that needs assets', async () => {
    const { t } = await setup();
    const plain: PrototypeScene = { version: 1, background: null, layers: [] };
    const ok = await t.api<PrototypeDetailDto>('POST', API, {
      name: 'Livre',
      snapshot: { html: '<body></body>', css: '', width: 800, height: 600, scene: plain },
    });
    expect(ok.status).toBe(201);
    expect(ok.json.scene).toEqual(plain);
    const bad = await t.api('POST', API, {
      name: 'Livre 2',
      snapshot: {
        html: '<body></body>',
        css: '',
        width: 800,
        height: 600,
        scene: sceneWith('d'.repeat(64)),
      },
    });
    expect(bad.status).toBe(400);
  });

  it('copies the images when a prototype is saved as a template and a template is used', async () => {
    const { t, id } = await setup();
    const { json: asset } = await upload(id, fakePng(100, 20, 1));
    await t.api('PUT', `${API}/${id}`, {
      snapshot: { html: SCREEN, css: '', width: 800, height: 600, scene: sceneWith(asset.asset) },
    });
    const template = await t.api<PrototypeDetailDto>('POST', `${API}/${id}/save-as-template`, {
      name: 'Modelo livre',
    });
    expect(template.status).toBe(201);
    expect(template.json.scene).toEqual(sceneWith(asset.asset));
    expect(await assetStatus(template.json.id, asset.asset)).toBe(200);

    const copy = await t.api<PrototypeDetailDto>('POST', API, {
      name: 'Cópia',
      fromTemplateId: template.json.id,
    });
    expect(copy.status).toBe(201);
    expect(await assetStatus(copy.json.id, asset.asset)).toBe(200);
  });

  it('keeps the snapshot byte limit', async () => {
    const { t, id } = await setup();
    const html = `<body>${'x'.repeat(PROTOTYPE_LIMITS.maxSnapshotBytes)}</body>`;
    const res = await t.api('PUT', `${API}/${id}`, {
      snapshot: {
        html,
        css: '',
        width: 800,
        height: 600,
        scene: { version: 1, background: null, layers: [] },
      },
    });
    expect(res.status).toBe(413);
  });
});

describe('POST /scene/from-html', () => {
  it('cuts the current version into a background and one layer per component', async () => {
    const { t, renderer, id } = await setup();
    const res = await t.api<SceneFromHtmlDto>('POST', `${API}/${id}/scene/from-html`);
    expect(res.status).toBe(200);
    const { scene } = res.json;
    expect(renderer.decomposeCalls).toHaveLength(1);
    const call = renderer.decomposeCalls[0]!;
    expect(call).toMatchObject({ width: 800, height: 600, scale: 1, layerCount: 5 });
    expect(call.document).toContain('data-ec="fieldset" data-tf-layer="2" data-tf-container="0"');
    expect(call.document).toContain('data-ec="lookup" data-tf-layer="3"');

    expect(scene.version).toBe(1);
    expect(scene.layers.map((l) => [l.name, l.source?.kind])).toEqual([
      ['Título de janela: Consulta', 'window-title'],
      ['Grupo: Filtros', 'fieldset'],
      ['Lookup: Reduzido', 'lookup'],
      ['Data: Data Emissão', 'date'],
      ['Barra de botões', 'button-bar'],
    ]);
    expect(scene.layers[2]).toMatchObject({
      type: 'image',
      x: 10,
      y: 60,
      width: 100,
      height: 20,
      visible: true,
      locked: false,
    });
    // every referenced image is stored, and the whole scene is valid to save as a version
    expect(await assetStatus(id, scene.background!.asset)).toBe(200);
    for (const layer of scene.layers) {
      expect(await assetStatus(id, layer.image!.asset)).toBe(200);
    }
    const saved = await t.api<PrototypeDetailDto>('PUT', `${API}/${id}`, {
      snapshot: { html: SCREEN, css: '', width: 800, height: 600, scene },
    });
    expect(saved.status).toBe(200);
  });

  it('does not save a version, and skips components the browser did not see', async () => {
    const { t, renderer, id } = await setup();
    renderer.hiddenLayers = new Set([1, 5]);
    const res = await t.api<SceneFromHtmlDto>('POST', `${API}/${id}/scene/from-html`);
    expect(res.json.scene.layers.map((l) => l.source?.kind)).toEqual([
      'fieldset',
      'lookup',
      'date',
    ]);
    expect((await t.api<PrototypeDetailDto>('GET', `${API}/${id}`)).json.versionCount).toBe(1);
  });

  it('is 404 for an unknown prototype and 503 without Chromium', async () => {
    const { t, id } = await setup();
    expect((await t.api('POST', `${API}/nope/scene/from-html`)).status).toBe(404);
    const unavailable = await createTestApp();
    try {
      const p = await unavailable.api<PrototypeDetailDto>('POST', API, {
        name: 'X',
        snapshot: { html: SCREEN, css: '', width: 800, height: 600 },
      });
      const res = await unavailable.api('POST', `${API}/${p.json.id}/scene/from-html`);
      expect(res.status).toBe(503);
    } finally {
      await unavailable.close();
    }
    expect(id).toBeTruthy();
  });
});

describe('POST /assets/from-block', () => {
  it('renders a sanitized block on the e-Cidade window background', async () => {
    const { t, renderer, id } = await setup();
    const res = await t.api<SceneAssetDto>('POST', `${API}/${id}/assets/from-block`, {
      html: '<table><tr><td>Campo</td><td><input value="x" onclick="alert(1)"><script>x()</script></td></tr></table>',
      css: 'td{color:red}',
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ width: 150, height: 24 });
    const doc = renderer.blockCalls[0]!.document;
    expect(doc).toContain('data-tf-block');
    expect(doc).toContain('#e0e0e0');
    expect(doc).toContain('td{color:red}');
    expect(doc).not.toContain('<script');
    expect(doc).not.toContain('onclick');
    expect(await assetStatus(id, res.json.asset)).toBe(200);
  });

  it('validates the body and the size', async () => {
    const { t, id } = await setup();
    expect((await t.api('POST', `${API}/${id}/assets/from-block`, { css: '' })).status).toBe(400);
    const huge = await t.api('POST', `${API}/${id}/assets/from-block`, {
      html: 'x'.repeat(PROTOTYPE_LIMITS.maxBlockBytes + 1),
    });
    expect(huge.status).toBe(413);
  });
});

describe('rendering a scene version', () => {
  it('draws the scene (images inlined), and a new scene is a new render', async () => {
    const { t, renderer, id } = await setup();
    const { json: asset } = await upload(id, fakePng(100, 20, 1));
    const scene = sceneWith(asset.asset);
    await t.api('PUT', `${API}/${id}`, {
      snapshot: { html: SCREEN, css: '', width: 800, height: 600, scene },
    });
    const first = await t.api<PrototypeRenderDto>('POST', `${API}/${id}/render`);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ cached: false, width: 800, height: 600 });
    const doc = renderer.calls.at(-1)!.document;
    expect(doc).toContain('<body style="margin:0;width:800px;height:600px;position:relative');
    expect(doc).toContain(`data:image/png;base64,${b64(fakePng(100, 20, 1))}`);
    expect(doc).toContain('>Olá</div>');
    expect(doc).not.toContain('data-ec=');

    expect((await t.api<PrototypeRenderDto>('POST', `${API}/${id}/render`)).json.cached).toBe(true);
    const edited: PrototypeScene = {
      ...scene,
      layers: scene.layers.map((l) => ({ ...l, visible: l.type !== 'text' })),
    };
    await t.api('PUT', `${API}/${id}`, {
      snapshot: { html: SCREEN, css: '', width: 800, height: 600, scene: edited },
    });
    const second = await t.api<PrototypeRenderDto>('POST', `${API}/${id}/render`);
    expect(second.json.cached).toBe(false);
    expect(renderer.calls.at(-1)!.document).not.toContain('>Olá</div>');
  });
});
