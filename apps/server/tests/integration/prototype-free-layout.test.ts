import {
  AUTOSAVE_MERGE_MS,
  AUTOSAVE_NOTE,
  FREE_SOURCE_ATTR,
  FREE_WRAPPER_ATTR,
  type PrototypeDetailDto,
  type PrototypeFreeLayoutDto,
  type PrototypeRenderDto,
} from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/shared/kernel/clock';
import { FakePrototypeRenderer } from '../prototypes/fake-renderer';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const API = '/api/prototypes';

const SCREEN = `<body style="margin:0"><div data-ec="window-title"><span data-ec-part="title">Consulta</span></div>
  <fieldset data-ec="fieldset"><legend data-ec-part="legend">Filtros</legend>
    <table><tr data-ec="lookup"><td data-ec-part="label">Reduzido:</td><td><input data-ec-part="input"></td></tr></table>
  </fieldset><input type="button" value="Limpar"></body>`;

async function setup(html = SCREEN) {
  const renderer = new FakePrototypeRenderer();
  const clock = new FakeClock();
  t = await createTestApp({
    clock,
    prototypes: { renderer, thumbnailDebounceMs: 3_600_000 },
  });
  const created = await t.api<PrototypeDetailDto>('POST', API, {
    name: 'Tela X',
    snapshot: { html, css: 'body{font:11px Arial}', width: 800, height: 600 },
  });
  return { t, renderer, clock, id: created.json.id, created: created.json };
}

describe('POST /api/prototypes/:id/free-layout', () => {
  it('converts the CURRENT version without saving anything', async () => {
    const { t, renderer, id, created } = await setup();
    const res = await t.api<PrototypeFreeLayoutDto>('POST', `${API}/${id}/free-layout`);
    expect(res.status).toBe(200);
    expect(res.json.html).toContain(`${FREE_WRAPPER_ATTR}="1"`);
    expect(res.json.css).toBe('body{font:11px Arial}');

    // the renderer got the full document with the layers marked, at the prototype's size
    expect(renderer.freeLayoutCalls).toHaveLength(1);
    const call = renderer.freeLayoutCalls[0]!;
    expect(call).toMatchObject({ width: 800, height: 600 });
    expect(call.document).toContain('<style>body{font:11px Arial}</style>');
    expect(call.document).toContain('data-tf-layer="1"');
    expect(call.document).toContain('data-tf-container="0"');

    // not a version: the prototype is untouched
    const after = await t.api<PrototypeDetailDto>('GET', `${API}/${id}`);
    expect(after.json.versionId).toBe(created.versionId);
    expect(after.json.versions).toHaveLength(1);
    expect(after.json.html).not.toContain(FREE_WRAPPER_ATTR);
  });

  it('is idempotent: a screen that already has wrappers comes back as it is', async () => {
    const html = `<body><div ${FREE_SOURCE_ATTR}="1" style="visibility:hidden"><input></div><div ${FREE_WRAPPER_ATTR}="1" style="position:absolute;left:1px;top:2px"><input data-ec-part="input"></div></body>`;
    const { t, renderer, id } = await setup(html);
    const res = await t.api<PrototypeFreeLayoutDto>('POST', `${API}/${id}/free-layout`);
    expect(res.status).toBe(200);
    expect(res.json.html).toBe(html);
    expect(renderer.freeLayoutCalls).toHaveLength(0);
  });

  it('does not take data-tf-free-src alone for a free layout', async () => {
    const { t, renderer, id } = await setup(
      `<body><div ${FREE_SOURCE_ATTR}="1"><input type="button" value="a"></div></body>`,
    );
    await t.api('POST', `${API}/${id}/free-layout`);
    expect(renderer.freeLayoutCalls).toHaveLength(1);
  });

  it('returns a screen with nothing to move as it is', async () => {
    const { t, renderer, id } = await setup('<body><p>texto</p></body>');
    const res = await t.api<PrototypeFreeLayoutDto>('POST', `${API}/${id}/free-layout`);
    expect(res.json.html).toBe('<body><p>texto</p></body>');
    expect(renderer.freeLayoutCalls).toHaveLength(0);
  });

  it('cleans what the page produced exactly like a saved snapshot (no scripts, handlers, javascript: URLs)', async () => {
    const { t, renderer, id } = await setup();
    renderer.freeLayoutHtml = () =>
      `<body><div ${FREE_WRAPPER_ATTR}="1" onclick="x()" style="position:absolute;left:1px;top:2px"><script>alert(1)</script><a href="javascript:alert(2)">a</a><input value="ok"></div></body>`;
    const res = await t.api<PrototypeFreeLayoutDto>('POST', `${API}/${id}/free-layout`);
    expect(res.status).toBe(200);
    expect(res.json.html).not.toMatch(/<script|onclick|javascript:|alert/i);
    expect(res.json.html).toContain(`${FREE_WRAPPER_ATTR}="1"`);
    expect(res.json.html).toContain('<input value="ok">');
  });

  it('404 for an unknown prototype; 503 without Chromium; 502 when the conversion fails', async () => {
    const { t, renderer, id } = await setup();
    expect((await t.api('POST', `${API}/nope/free-layout`)).status).toBe(404);
    renderer.failWith = { error: 'boom', unavailable: true };
    const unavailable = await t.api<{ error: string }>('POST', `${API}/${id}/free-layout`);
    expect(unavailable.status).toBe(503);
    renderer.failWith = { error: 'boom', unavailable: false };
    expect((await t.api('POST', `${API}/${id}/free-layout`)).status).toBe(502);
  });
});

describe('auto-save', () => {
  const snapshot = (text: string) => ({
    html: `<body><p>${text}</p></body>`,
    css: '',
    width: 800,
    height: 600,
  });
  const put = (id: string, text: string, extra: object = {}) =>
    t!.api<PrototypeDetailDto>('PUT', `${API}/${id}`, { snapshot: snapshot(text), ...extra });

  it('two auto-saves in the window are ONE "Auto-save" version holding the last content', async () => {
    const { id, clock, created } = await setup();
    clock.advance(1000);
    const first = await put(id, 'um', { autosave: true, note: 'ignorada' });
    expect(first.status).toBe(200);
    expect(first.json.versions.map((v) => v.note)).toEqual([AUTOSAVE_NOTE, 'Importado']);
    expect(first.json.versionId).not.toBe(created.versionId);

    clock.advance(30_000);
    const second = await put(id, 'dois', { autosave: true });
    expect(second.json.versionId).toBe(first.json.versionId);
    expect(second.json.versions).toHaveLength(2);
    expect(second.json.versionCount).toBe(2);
    expect(second.json.html).toBe('<body><p>dois</p></body>');
    expect(second.json.versions[0]).toMatchObject({
      id: first.json.versionId,
      note: AUTOSAVE_NOTE,
      createdAt: clock.now(),
    });
    // the stored file of that version was overwritten (and no stray file is left)
    const keys: string[] = [];
    for await (const o of t!.store.list(`prototypes/${id}/`)) keys.push(o.key);
    expect(keys.sort()).toEqual(
      [
        `prototypes/${id}/${created.versionId}.json`,
        `prototypes/${id}/${first.json.versionId}.json`,
      ].sort(),
    );
    const version = await t!.api<{ html: string }>(
      'GET',
      `${API}/${id}/versions/${first.json.versionId}`,
    );
    expect(version.json.html).toBe('<body><p>dois</p></body>');
  });

  it('keeps sliding: each auto-save restarts the window of the same version', async () => {
    const { id, clock } = await setup();
    const first = await put(id, 'a', { autosave: true });
    for (let i = 0; i < 5; i++) {
      clock.advance(AUTOSAVE_MERGE_MS - 1000);
      const next = await put(id, `b${i}`, { autosave: true });
      expect(next.json.versionId).toBe(first.json.versionId);
    }
    expect((await t!.api<PrototypeDetailDto>('GET', `${API}/${id}`)).json.versions).toHaveLength(2);
  });

  it('after a normal save ("Edição") the next auto-save is a new version', async () => {
    const { id, clock } = await setup();
    const auto = await put(id, 'a', { autosave: true });
    clock.advance(1000);
    const manual = await put(id, 'b'); // Ctrl+S
    expect(manual.json.versions[0]!.note).toBe('Edição');
    expect(manual.json.versionId).not.toBe(auto.json.versionId);
    clock.advance(1000);
    const next = await put(id, 'c', { autosave: true });
    expect(next.json.versionId).not.toBe(manual.json.versionId);
    expect(next.json.versions.map((v) => v.note).slice(0, 3)).toEqual([
      AUTOSAVE_NOTE,
      'Edição',
      AUTOSAVE_NOTE,
    ]);
    // and the manual save never replaces an auto-save
    const again = await put(id, 'd');
    expect(again.json.versions[0]!.note).toBe('Edição');
    expect(again.json.versions).toHaveLength(5);
  });

  it('after the window (10 min) a new "Auto-save" version is created', async () => {
    const { id, clock } = await setup();
    const first = await put(id, 'a', { autosave: true });
    clock.advance(AUTOSAVE_MERGE_MS);
    const late = await put(id, 'b', { autosave: true });
    expect(late.json.versionId).not.toBe(first.json.versionId);
    expect(late.json.versions.map((v) => v.note).slice(0, 2)).toEqual([
      AUTOSAVE_NOTE,
      AUTOSAVE_NOTE,
    ]);
    expect(late.json.versions).toHaveLength(3);
  });

  it('a merge invalidates the rendered PNG: the next render draws the new content', async () => {
    const { id, clock, renderer } = await setup();
    await put(id, 'a', { autosave: true });
    const r1 = await t!.api<PrototypeRenderDto>('POST', `${API}/${id}/render`);
    expect(r1.json.cached).toBe(false);
    expect((await t!.api<PrototypeRenderDto>('POST', `${API}/${id}/render`)).json.cached).toBe(
      true,
    );

    clock.advance(1000);
    const merged = await put(id, 'b', { autosave: true });
    expect(merged.json.versionId).toBe(r1.json.renderedVersionId); // same version id…
    const r2 = await t!.api<PrototypeRenderDto>('POST', `${API}/${id}/render`);
    expect(r2.json.cached).toBe(false); // …but drawn again
    expect(renderer.calls.at(-1)!.document).toContain('<p>b</p>');
    expect((await t!.api<PrototypeRenderDto>('POST', `${API}/${id}/render`)).json.cached).toBe(
      true,
    );
  });

  it('keeps sentTo and the name/session patch consistent on a merge', async () => {
    const { id, clock } = await setup();
    await put(id, 'a', { autosave: true });
    clock.advance(1000);
    const merged = await put(id, 'b', { autosave: true, name: 'Outro nome' });
    expect(merged.json.name).toBe('Outro nome');
    expect(merged.json.sentTo).toEqual([]);
    expect(merged.json.updatedAt).toBe(clock.now());
  });

  it('autosave on the very first save of a prototype that is not an auto-save creates the version', async () => {
    const { id } = await setup();
    const res = await put(id, 'a', { autosave: true });
    expect(res.json.versions).toHaveLength(2);
    expect(res.json.versions[0]!.note).toBe(AUTOSAVE_NOTE);
  });
});
