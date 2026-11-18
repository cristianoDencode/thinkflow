import type {
  PrototypeDetailDto,
  PrototypeRenderDto,
  PrototypeSendResultDto,
  TestSessionDto,
  TestStepImageDto,
} from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRecorderBrowser, instantSettler } from '../testing/fake-recorder';
import { FakePrototypeRenderer } from '../prototypes/fake-renderer';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const API = '/api/prototypes';
const SESSIONS = '/api/tests/sessions';

async function setup() {
  const renderer = new FakePrototypeRenderer();
  const recorder = new FakeRecorderBrowser();
  t = await createTestApp({
    prototypes: { renderer },
    tests: { recorder, settler: instantSettler },
  });
  const session = await t.api<TestSessionDto>('POST', SESSIONS, {
    name: 'Consulta de empenho',
    startUrl: 'https://a.b/',
  });
  // three note steps to insert around
  for (const comment of ['um', 'dois', 'tres']) {
    await t.api('POST', `${SESSIONS}/${session.json.id}/steps/notes`, { comment });
  }
  const sessionId = session.json.id;
  const steps = (await t.api<TestSessionDto>('GET', `${SESSIONS}/${sessionId}`)).json.definition
    .steps;
  const proto = await t.api<PrototypeDetailDto>('POST', API, {
    name: 'Tela X',
    sessionId,
    snapshot: { html: '<body><p>oi</p></body>', css: '', width: 640, height: 480 },
  });
  return { t, renderer, recorder, sessionId, steps, protoId: proto.json.id };
}

const getSession = (id: string) =>
  t!.api<TestSessionDto>('GET', `${SESSIONS}/${id}`).then((r) => r.json);

describe('POST /api/prototypes/:id/render', () => {
  it('renders to the exact size, serves the PNG as the thumbnail and reuses it per version', async () => {
    const { renderer, protoId } = await setup();
    const first = await t!.api<PrototypeRenderDto>('POST', `${API}/${protoId}/render`);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ width: 640, height: 480, scale: 1, cached: false });
    expect(renderer.calls[0]).toMatchObject({ width: 640, height: 480, scale: 1 });
    expect(renderer.calls[0]!.document).toBe(
      '<!doctype html><meta charset=utf-8><style></style><body><p>oi</p></body>',
    );

    const detail = await t!.api<PrototypeDetailDto>('GET', `${API}/${protoId}`);
    expect(detail.json.thumbnailUrl).toBe(first.json.thumbnailUrl);
    expect(first.json.renderedVersionId).toBe(detail.json.versionId);
    const png = await t!.app.inject({
      method: 'GET',
      url: first.json.thumbnailUrl,
      headers: { cookie: t!.cookie },
    });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');

    const again = await t!.api<PrototypeRenderDto>('POST', `${API}/${protoId}/render`);
    expect(again.json).toMatchObject({ cached: true, width: 640, height: 480 });
    expect(renderer.calls).toHaveLength(1);

    // a new version, scale 2 and force all render again
    await t!.api('PUT', `${API}/${protoId}`, {
      snapshot: { html: '<body>2</body>', css: 'p{}', width: 700, height: 500 },
    });
    const edited = await t!.api<PrototypeRenderDto>('POST', `${API}/${protoId}/render`);
    expect(edited.json).toMatchObject({ cached: false, width: 700, height: 500 });
    const sharp = await t!.api<PrototypeRenderDto>('POST', `${API}/${protoId}/render?scale=2`);
    expect(sharp.json).toMatchObject({ cached: false, width: 1400, height: 1000, scale: 2 });
    const forced = await t!.api<PrototypeRenderDto>(
      'POST',
      `${API}/${protoId}/render?scale=2&force=true`,
    );
    expect(forced.json.cached).toBe(false);
    expect(renderer.calls).toHaveLength(4);
    expect(renderer.calls[3]).toMatchObject({ scale: 2, width: 700, height: 500 });
  });

  it('reports the blocked requests, rejects a bad scale and 404s an unknown prototype', async () => {
    const { renderer, protoId } = await setup();
    renderer.blockedRequests = 3;
    const res = await t!.api<PrototypeRenderDto>('POST', `${API}/${protoId}/render`);
    expect(res.json.blockedRequests).toBe(3);
    expect((await t!.api('POST', `${API}/${protoId}/render?scale=3`)).status).toBe(400);
    expect((await t!.api('POST', `${API}/nao-existe/render`)).status).toBe(404);
  });

  it('answers 503 in pt-BR when Chromium is unavailable and 502 for another failure', async () => {
    const { renderer, protoId } = await setup();
    renderer.failWith = { error: 'Chromium não encontrado', unavailable: true };
    const down = await t!.api<{ error: { code: string; message: string } }>(
      'POST',
      `${API}/${protoId}/render`,
    );
    expect(down.status).toBe(503);
    expect(down.json.error).toMatchObject({ code: 'renderer_unavailable' });
    expect(down.json.error.message).toMatch(/Não foi possível gerar a imagem/);
    renderer.failWith = { error: 'Tempo esgotado', unavailable: false };
    expect((await t!.api('POST', `${API}/${protoId}/render`)).status).toBe(502);
    expect((await t!.api<PrototypeDetailDto>('GET', `${API}/${protoId}`)).json.thumbnailUrl).toBe(
      null,
    );
  });
});

describe('POST /api/prototypes/:id/send-to-session', () => {
  it('adds a capture step at the end of the linked session, included, and records sentTo', async () => {
    const { renderer, sessionId, protoId } = await setup();
    const res = await t!.api<PrototypeSendResultDto>('POST', `${API}/${protoId}/send-to-session`, {
      target: 'newStep',
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ sessionId, target: 'newStep' });
    expect(res.json.render).toMatchObject({ width: 640, height: 480 });

    const s = await getSession(sessionId);
    const steps = s.definition.steps;
    expect(steps).toHaveLength(4);
    const added = steps.at(-1)!;
    expect(added).toMatchObject({
      id: res.json.stepId,
      kind: 'capture',
      title: 'Protótipo: Tela X',
    });
    expect(s.images[added.id]).toMatchObject({ width: 640, height: 480, include: true });
    const img = await t!.app.inject({
      method: 'GET',
      url: s.images[added.id]!.imageUrl,
      headers: { cookie: t!.cookie },
    });
    expect(img.statusCode).toBe(200);
    expect(img.rawPayload.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    const detail = await t!.api<PrototypeDetailDto>('GET', `${API}/${protoId}`);
    expect(detail.json.sentTo).toEqual([
      { sessionId, stepId: added.id, at: expect.any(Number) as number },
    ]);

    // the render is reused by the next send
    await t!.api('POST', `${API}/${protoId}/send-to-session`, { target: 'newStep' });
    expect(renderer.calls).toHaveLength(1);
    expect((await getSession(sessionId)).definition.steps).toHaveLength(5);
    expect((await t!.api<PrototypeDetailDto>('GET', `${API}/${protoId}`)).json.sentTo).toHaveLength(
      2,
    );
  });

  it('inserts after a step with a custom title and can leave the image out of the document', async () => {
    const { sessionId, steps, protoId } = await setup();
    const res = await t!.api<PrototypeSendResultDto>('POST', `${API}/${protoId}/send-to-session`, {
      target: 'newStep',
      afterStepId: steps[0]!.id,
      title: 'Tela de consulta',
      include: false,
    });
    expect(res.status).toBe(200);
    const s = await getSession(sessionId);
    expect(s.definition.steps.map((x) => x.id)).toEqual([
      steps[0]!.id,
      res.json.stepId,
      steps[1]!.id,
      steps[2]!.id,
    ]);
    expect(s.definition.steps[1]).toMatchObject({ kind: 'capture', title: 'Tela de consulta' });
    expect(s.images[res.json.stepId]!.include).toBe(false);
  });

  it('replaces the image of a step, dropping its annotations, and keeps the include choice', async () => {
    const { t, recorder, protoId } = await setup();
    // a session with a real print, annotated and left out of the document
    const other = await t.api<TestSessionDto>('POST', SESSIONS, {
      name: 'Prints',
      startUrl: 'https://a.b/',
    });
    const id = other.json.id;
    await t.api('POST', `${SESSIONS}/${id}/record/start`, { mode: 'capture' });
    const shot = await t.api<TestStepImageDto>('POST', `${SESSIONS}/${id}/capture`);
    await t.api('POST', `${SESSIONS}/${id}/record/stop`);
    expect(recorder.screenshots).toHaveLength(1);
    await t.api('PATCH', `${SESSIONS}/${id}/evidences/${shot.json.id}`, {
      annotations: [{ type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.1, color: '#ef4444' }],
      comment: 'antes',
      include: false,
    });
    const before = await getSession(id);
    expect(before.images[shot.json.stepId]!.annotations).toHaveLength(1);

    const res = await t.api<PrototypeSendResultDto>('POST', `${API}/${protoId}/send-to-session`, {
      sessionId: id,
      target: 'replaceStepImage',
      stepId: shot.json.stepId,
    });
    expect(res.status).toBe(200);
    expect(res.json.stepId).toBe(shot.json.stepId);
    const after = await getSession(id);
    expect(after.definition.steps).toHaveLength(1);
    expect(after.images[shot.json.stepId]).toMatchObject({
      width: 640,
      height: 480,
      annotations: [],
      annotated: false,
      include: false,
    });
    expect(after.images[shot.json.stepId]!.id).not.toBe(shot.json.id);
    const detail = await t.api<PrototypeDetailDto>('GET', `${API}/${protoId}`);
    expect(detail.json.sentTo).toEqual([
      { sessionId: id, stepId: shot.json.stepId, at: expect.any(Number) as number },
    ]);

    // sending to the same step again refreshes the entry instead of repeating it
    await t.api('POST', `${API}/${protoId}/send-to-session`, {
      sessionId: id,
      target: 'replaceStepImage',
      stepId: shot.json.stepId,
      include: true,
    });
    expect((await getSession(id)).images[shot.json.stepId]!.include).toBe(true);
    expect((await t.api<PrototypeDetailDto>('GET', `${API}/${protoId}`)).json.sentTo).toHaveLength(
      1,
    );
  });

  it('is refused (409) while the session records, without rendering', async () => {
    const { t, renderer, sessionId, protoId } = await setup();
    await t.api('POST', `${SESSIONS}/${sessionId}/record/start`, { mode: 'capture' });
    const res = await t.api<{ error: { code: string } }>(
      'POST',
      `${API}/${protoId}/send-to-session`,
      { target: 'newStep' },
    );
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('test_session_busy');
    expect(renderer.calls).toHaveLength(0);
  });

  it('409 without a linked session, and uses an explicit sessionId instead', async () => {
    const { t, sessionId } = await setup();
    const loose = await t.api<PrototypeDetailDto>('POST', API, { name: 'Solto' });
    const refused = await t.api<{ error: { message: string } }>(
      'POST',
      `${API}/${loose.json.id}/send-to-session`,
      { target: 'newStep' },
    );
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toMatch(/não está vinculado/);

    const ok = await t.api<PrototypeSendResultDto>(
      'POST',
      `${API}/${loose.json.id}/send-to-session`,
      { target: 'newStep', sessionId },
    );
    expect(ok.status).toBe(200);
    expect((await getSession(sessionId)).definition.steps).toHaveLength(4);
    expect(
      (
        await t.api('POST', `${API}/${loose.json.id}/send-to-session`, {
          target: 'newStep',
          sessionId: 'nao-existe',
        })
      ).status,
    ).toBe(404);
  });

  it('validates the input and the steps', async () => {
    const { protoId } = await setup();
    const post = (body: unknown) => t!.api('POST', `${API}/${protoId}/send-to-session`, body);
    expect((await post({ target: 'replaceStepImage' })).status).toBe(400);
    expect((await post({ target: 'outro' })).status).toBe(400);
    expect((await post({ target: 'newStep', afterStepId: 'nao-existe' })).status).toBe(404);
    expect((await post({ target: 'replaceStepImage', stepId: 'nao-existe' })).status).toBe(404);
    expect(
      (await t!.api('POST', `${API}/nao-existe/send-to-session`, { target: 'newStep' })).status,
    ).toBe(404);
  });

  it('answers 503 and leaves the session untouched when Chromium is unavailable', async () => {
    const { renderer, sessionId, protoId } = await setup();
    renderer.failWith = { error: 'sem Chromium', unavailable: true };
    const res = await t!.api('POST', `${API}/${protoId}/send-to-session`, { target: 'newStep' });
    expect(res.status).toBe(503);
    expect((await getSession(sessionId)).definition.steps).toHaveLength(3);
  });

  it('requires a login', async () => {
    const { protoId } = await setup();
    const res = await t!.app.inject({ method: 'POST', url: `${API}/${protoId}/send-to-session` });
    expect(res.statusCode).toBe(401);
  });
});
