import type { TestSessionDto, TestStepImageDto } from '@thinkflow/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buttonFacts,
  FakeRecorderBrowser,
  instantSettler,
  TINY_PNG,
} from '../testing/fake-recorder';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BASE = '/api/tests/sessions';

async function form(fields: { data?: unknown; image?: Uint8Array }) {
  const f = new FormData();
  if (fields.data !== undefined) f.append('data', JSON.stringify(fields.data));
  if (fields.image)
    f.append('image', new Blob([Buffer.from(fields.image)], { type: 'image/png' }), 'x.png');
  const res = new Response(f);
  return {
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { 'content-type': res.headers.get('content-type') ?? '' },
  };
}

async function send<T>(
  method: 'POST' | 'PUT',
  url: string,
  fields: { data?: unknown; image?: Uint8Array },
) {
  const body = await form(fields);
  const res = await t!.app.inject({
    method,
    url,
    headers: { cookie: t!.cookie, ...body.headers },
    payload: body.payload,
  });
  return { status: res.statusCode, json: JSON.parse(res.body) as T };
}

/** A session in "Só prints" with one print taken. */
async function capturing() {
  const recorder = new FakeRecorderBrowser();
  t = await createTestApp({ tests: { recorder, settler: instantSettler } });
  const { json } = await t.api<TestSessionDto>('POST', BASE, {
    name: 'Login',
    startUrl: 'https://a.b/login',
  });
  await t.api('POST', `${BASE}/${json.id}/record/start`, { mode: 'capture' });
  const shot = await t.api<TestStepImageDto>('POST', `${BASE}/${json.id}/capture`);
  return { recorder, id: json.id, image: shot.json };
}

const session = (id: string) => t!.api<TestSessionDto>('GET', `${BASE}/${id}`).then((r) => r.json);

describe('step images', () => {
  it('captures the page as a capture step with a PNG image, from the app and from the toolbar', async () => {
    const { recorder, id, image } = await capturing();
    const first = (await session(id)).definition.steps[0]!;
    expect(first).toMatchObject({ kind: 'capture', page: { url: 'https://a.b/login' } });
    expect(image).toMatchObject({
      seq: 1,
      stepId: first.id,
      width: 1366,
      height: 768,
      annotated: false,
      include: true,
      comment: '',
    });
    expect(recorder.screenshots).toHaveLength(1);
    expect(await t!.store.head(`tests/${id}/evidences/${image.id}/original.png`)).not.toBeNull();

    // Ctrl+Shift+S inside the browser
    recorder.requestCapture();
    await vi.waitFor(async () => expect((await session(id)).imageCount).toBe(2));
    const s = await session(id);
    expect(s.definition.steps.map((x) => x.kind)).toEqual(['capture', 'capture']);
    expect(Object.values(s.images).map((e) => e.seq)).toEqual([1, 2]);
    expect(s.imageCount).toBe(2);
  });

  it('refuses to capture without a recording, or while the storage is down', async () => {
    const { id } = await capturing();
    t!.store.fail('MinIO fora do ar');
    await t!.container.storage.monitor.refresh();
    const down = await t!.api<{ error: { message: string } }>('POST', `${BASE}/${id}/capture`);
    expect(down.status).toBe(503);
    expect(down.json.error.message).toContain('indisponível');
    t!.store.fail(null);
    await t!.container.storage.monitor.refresh();
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    expect((await t!.api('POST', `${BASE}/${id}/capture`)).status).toBe(409);
  });

  it('saves annotations, the flattened image and the comment; clears them again', async () => {
    const { id, image: ev } = await capturing();
    const annotations = [
      { type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.1, color: '#ef4444' },
      { type: 'badge', x: 0.5, y: 0.5, n: 1, color: '#ef4444' },
      { type: 'arrow', points: [0.1, 0.1, 0.4, 0.4], color: '#ef4444' },
    ];
    const saved = await send<TestStepImageDto>(
      'PUT',
      `${BASE}/${id}/evidences/${ev.id}/annotated`,
      {
        data: { annotations, comment: '  Mensagem de erro exibida  ' },
        image: TINY_PNG,
      },
    );
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({
      annotated: true,
      comment: 'Mensagem de erro exibida',
      annotations,
      stepId: ev.stepId,
    });
    expect(saved.json.imageUrl).toContain('annotated.png');
    expect(saved.json.originalUrl).toContain('original.png');
    const img = await t!.app.inject({
      method: 'GET',
      url: saved.json.imageUrl,
      headers: { cookie: t!.cookie },
    });
    expect(img.statusCode).toBe(200);

    const bad = await send('PUT', `${BASE}/${id}/evidences/${ev.id}/annotated`, {
      data: { annotations },
      image: new Uint8Array([1, 2, 3]),
    });
    expect(bad.status).toBe(400);

    const cleared = await send<TestStepImageDto>(
      'PUT',
      `${BASE}/${id}/evidences/${ev.id}/annotated`,
      {
        data: { annotations: [] },
      },
    );
    expect(cleared.json).toMatchObject({ annotated: false, annotations: [] });
    expect(await t!.store.head(`tests/${id}/evidences/${ev.id}/annotated.png`)).toBeNull();

    // only a selected area (no shapes): the cropped image is still the print
    const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.4 };
    const cropped = await send<TestStepImageDto>(
      'PUT',
      `${BASE}/${id}/evidences/${ev.id}/annotated`,
      { data: { annotations: [], crop }, image: TINY_PNG },
    );
    expect(cropped.json).toMatchObject({ annotated: true, annotations: [], crop });
    const reread = await t!.api<TestSessionDto>('GET', `${BASE}/${id}`);
    expect(reread.json.images[ev.stepId]?.crop).toEqual(crop);

    const badCrop = await send('PUT', `${BASE}/${id}/evidences/${ev.id}/annotated`, {
      data: { crop: { x: 0, y: 0, w: 0, h: 1 } },
    });
    expect(badCrop.status).toBe(400);

    const whole = await send<TestStepImageDto>(
      'PUT',
      `${BASE}/${id}/evidences/${ev.id}/annotated`,
      {
        data: { annotations: [], crop: null },
      },
    );
    expect(whole.json).toMatchObject({ annotated: false, crop: null });
    expect(await t!.store.head(`tests/${id}/evidences/${ev.id}/annotated.png`)).toBeNull();
  });

  it('toggles inclusion, cannot be moved to another step, and is removed with its files', async () => {
    const { id, image } = await capturing();
    await send('PUT', `${BASE}/${id}/evidences/${image.id}/annotated`, {
      data: { annotations: [{ type: 'rect', x: 0, y: 0, w: 0.1, h: 0.1, color: '#f00' }] },
      image: TINY_PNG,
    });
    const patched = await t!.api<TestStepImageDto>('PATCH', `${BASE}/${id}/evidences/${image.id}`, {
      include: false,
      comment: 'Tela do sistema legado',
    });
    expect(patched.json).toMatchObject({
      include: false,
      comment: 'Tela do sistema legado',
      stepId: image.stepId,
    });
    // a step is not re-linkable: the field is simply not part of the contract
    const moved = await t!.api<TestStepImageDto>('PATCH', `${BASE}/${id}/evidences/${image.id}`, {
      stepId: 'outro',
    });
    expect(moved.json.stepId).toBe(image.stepId);

    expect((await t!.api('DELETE', `${BASE}/${id}/evidences/${image.id}`)).status).toBe(200);
    expect(await t!.store.head(`tests/${id}/evidences/${image.id}/original.png`)).toBeNull();
    expect(await t!.store.head(`tests/${id}/evidences/${image.id}/annotated.png`)).toBeNull();
    const s = await session(id);
    expect(s.imageCount).toBe(0);
    expect(s.images).toEqual({});
    // the capture step stays, just without its print
    expect(s.definition.steps).toHaveLength(1);
  });

  it('keeps one image per step: an automatic print replaces the previous one', async () => {
    const recorder = new FakeRecorderBrowser();
    t = await createTestApp({ tests: { recorder, settler: instantSettler } });
    const { json } = await t.api<TestSessionDto>('POST', BASE, {
      name: 'Login',
      startUrl: 'https://a.b/login',
    });
    await t.api('POST', `${BASE}/${json.id}/record/start`);
    recorder.emit({ type: 'click', facts: buttonFacts('Entrar'), at: 1 });
    await t.container.tests.recording.whenIdle();
    const s = await session(json.id);
    expect(s.imageCount).toBe(2);
    const rows = await t.container.tests.repo.evidences(json.id);
    expect(new Set(rows.map((r) => r.stepId)).size).toBe(rows.length);
  });

  it('turns an uploaded PNG into a capture step, only while idle', async () => {
    t = await createTestApp();
    const { json: s } = await t.api<TestSessionDto>('POST', BASE, {
      name: 'a',
      startUrl: 'https://a.b',
    });
    const up = await send<TestStepImageDto>('POST', `${BASE}/${s.id}/steps/captures`, {
      image: TINY_PNG,
    });
    expect(up.status).toBe(201);
    expect(up.json).toMatchObject({ width: 1, height: 1, include: true });
    const after = await session(s.id);
    expect(after.definition.steps).toMatchObject([{ id: up.json.stepId, kind: 'capture' }]);
    expect(after.mode).toBe('capture');
    expect(after.images[up.json.stepId]!.id).toBe(up.json.id);

    const jpeg = await send<{ error: { message: string } }>(
      'POST',
      `${BASE}/${s.id}/steps/captures`,
      { image: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]) },
    );
    expect(jpeg.status).toBe(400);
    expect(jpeg.json.error.message).toContain('PNG');
    expect((await session(s.id)).definition.steps).toHaveLength(1);

    await t.api('POST', `${BASE}/${s.id}/record/start`);
    const busy = await send('POST', `${BASE}/${s.id}/steps/captures`, { image: TINY_PNG });
    expect(busy.status).toBe(409);
  });

  it('never touches the image of another session', async () => {
    const { image } = await capturing();
    const { json: b } = await t!.api<TestSessionDto>('POST', BASE, {
      name: 'b',
      startUrl: 'https://a.b',
    });
    expect((await t!.api('DELETE', `${BASE}/${b.id}/evidences/${image.id}`)).status).toBe(404);
    expect(
      (await t!.api('PATCH', `${BASE}/${b.id}/evidences/${image.id}`, { include: false })).status,
    ).toBe(404);
  });
});
