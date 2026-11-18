import type { TestDownloadDto, TestRunDto, TestSessionDto } from '@thinkflow/shared';
import { TEST_LIMITS } from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buttonFacts,
  fakeDownload,
  fieldFacts,
  FakeRecorderBrowser,
  FakeRunner,
  instantSettler,
} from '../testing/fake-recorder';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BASE = '/api/tests/sessions';
const get = (id: string) => t!.api<TestSessionDto>('GET', `${BASE}/${id}`).then((r) => r.json);
const list = (id: string, query = '') =>
  t!.api<TestDownloadDto[]>('GET', `${BASE}/${id}/downloads${query}`).then((r) => r.json);
const idle = () => t!.container.tests.recording.whenIdle();
const storedFiles = async () => {
  const keys: string[] = [];
  for await (const o of t!.store.list('')) if (o.key.includes('/downloads/')) keys.push(o.key);
  return keys;
};

/** A session recorded with a fill (at 1) and a click (at 3) on page-1; the window stays open. */
async function recording(runner = new FakeRunner()) {
  const recorder = new FakeRecorderBrowser();
  t = await createTestApp({ tests: { recorder, runner, settler: instantSettler } });
  const { json } = await t.api<TestSessionDto>('POST', BASE, {
    name: 'Exportar',
    startUrl: 'https://a.b/login',
  });
  await t.api('POST', `${BASE}/${json.id}/record/start`);
  recorder.emit({ type: 'fill', facts: fieldFacts('E-mail'), value: 'ana@x.com', at: 1 });
  recorder.emit({ type: 'click', facts: buttonFacts('Exportar'), at: 3 });
  await idle();
  const session = await get(json.id);
  const click = session.definition.steps.find((s) => s.kind === 'click')!;
  const fill = session.definition.steps.find((s) => s.kind === 'fill')!;
  return { recorder, runner, id: json.id, click, fill };
}

describe('downloads while recording', () => {
  it('stores the file, links it to the step that triggered it and serves it as an attachment', async () => {
    const { recorder, id, click } = await recording();
    recorder.download(
      fakeDownload({ fileName: 'Relatório Março.csv', at: 1500, url: 'https://a.b/exportar' }),
    );
    await idle();

    const [item] = await list(id);
    expect(item).toMatchObject({
      sessionId: id,
      stepId: click.id,
      runId: null,
      runSeq: null,
      source: 'recording',
      fileName: 'Relatório Março.csv',
      size: 8,
      contentType: 'text/csv',
      url: 'https://a.b/exportar',
      status: 'saved',
      reason: null,
    });
    expect(item!.fileUrl).toBe(`${BASE}/${id}/downloads/${item!.id}/file`);

    // the storage key is ASCII-only and scoped to the session; the real name stays in the row
    expect(await storedFiles()).toEqual([
      expect.stringMatching(
        new RegExp(`^tests/${id}/downloads/${item!.id}/relatorio-marco\\.csv$`),
      ),
    ]);

    const file = await t!.app.inject({
      method: 'GET',
      url: item!.fileUrl!,
      headers: { cookie: t!.cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('a;b\n1;2\n');
    expect(file.headers['content-type']).toBe('text/csv');
    expect(file.headers['content-length']).toBe('8');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="Relat_rio Mar_o.csv"; filename*=UTF-8''Relat%C3%B3rio%20Mar%C3%A7o.csv`,
    );

    // the steps list shows a chip for it; the count feeds the tab badge
    const session = await get(id);
    expect(session.downloadCount).toBe(1);
    expect(session.stepDownloads[click.id]).toEqual([
      { id: item!.id, fileName: 'Relatório Março.csv' },
    ]);
  });

  it('links to the most recent step of the page within the window, else to no step', async () => {
    const { recorder, id, click, fill } = await recording();
    // another page recorded a step later: it does not take the download of page-1
    recorder.emit(
      { type: 'click', facts: buttonFacts('Outra'), at: 4 },
      { url: 'https://a.b/x', title: 'X' },
      'page-2',
    );
    await idle();
    recorder.download(fakeDownload({ fileName: 'a.csv', at: 5 }), 'page-1');
    // 9 s after the click: still inside the 10 s window
    recorder.download(fakeDownload({ fileName: 'b.csv', at: 9_000 }), 'page-1');
    // 11 s after the last step of the page: no step
    recorder.download(fakeDownload({ fileName: 'c.csv', at: 14_000 }), 'page-1');
    await idle();
    const byName = Object.fromEntries((await list(id)).map((d) => [d.fileName, d.stepId]));
    expect(byName).toEqual({ 'a.csv': click.id, 'b.csv': click.id, 'c.csv': null });
    expect(fill.id).not.toBe(click.id);
  });

  it('links a download of a popup (no step of its own) to the step that opened it', async () => {
    const { recorder, id, click } = await recording();
    recorder.download(fakeDownload({ fileName: 'popup.pdf', at: 2000 }), 'page-popup');
    await idle();
    expect((await list(id))[0]).toMatchObject({ fileName: 'popup.pdf', stepId: click.id });
  });

  it('records failed and oversized downloads without a file', async () => {
    const { recorder, id } = await recording();
    recorder.download(
      fakeDownload({
        fileName: 'cancelado.zip',
        at: 100,
        file: { status: 'failed', reason: 'O download foi cancelado antes de terminar.' },
      }),
    );
    recorder.download(
      fakeDownload({
        fileName: 'enorme.zip',
        at: 100,
        file: { status: 'skipped', size: 300 * 1024 * 1024 },
      }),
    );
    // bytes over the limit that were read anyway are refused the same way
    recorder.download(
      fakeDownload({
        fileName: 'grande.bin',
        at: 100,
        bytes: new Uint8Array(TEST_LIMITS.maxDownloadBytes + 1),
      }),
    );
    await idle();
    const items = Object.fromEntries((await list(id)).map((d) => [d.fileName, d]));
    expect(items['cancelado.zip']).toMatchObject({
      status: 'failed',
      reason: 'O download foi cancelado antes de terminar.',
      fileUrl: null,
      size: 0,
    });
    expect(items['enorme.zip']).toMatchObject({
      status: 'skipped',
      size: 300 * 1024 * 1024,
      fileUrl: null,
    });
    expect(items['enorme.zip']!.reason).toContain('100 MB');
    expect(items['grande.bin']).toMatchObject({ status: 'skipped', fileUrl: null });
    expect(await storedFiles()).toEqual([]);

    // nothing to download: the file route says so
    const res = await t!.api<{ error: { code: string } }>(
      'GET',
      `${BASE}/${id}/downloads/${items['enorme.zip']!.id}/file`,
    );
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('download_not_saved');
    // still counted, but without a chip
    const session = await get(id);
    expect(session.downloadCount).toBe(3);
    expect(Object.keys(session.stepDownloads)).toEqual([]);
  });

  it('keeps a hostile file name out of the key', async () => {
    const { recorder, id } = await recording();
    recorder.download(fakeDownload({ fileName: '../../etc/passwd', at: 10 }));
    await idle();
    const [item] = await list(id);
    expect(item!.fileName).toBe('passwd');
    expect(await storedFiles()).toEqual([
      expect.stringMatching(new RegExp(`^tests/${id}/downloads/[0-9a-f-]+/passwd$`)),
    ]);
  });

  it('stops recording at the per-session limit with a warning, keeping what was saved', async () => {
    const { recorder, id } = await recording();
    for (let i = 0; i < TEST_LIMITS.maxDownloadsPerSession; i++) {
      await t!.container.tests.repo.saveDownload({
        id: `d${i}`,
        sessionId: id,
        stepId: null,
        runId: null,
        source: 'recording',
        fileName: `f${i}.txt`,
        size: 0,
        contentType: 'text/plain',
        url: '',
        status: 'failed',
        reason: 'x',
        objectKey: null,
        createdAt: i,
      });
    }
    recorder.download(fakeDownload({ at: 10 }));
    await idle();
    expect(await storedFiles()).toEqual([]);
    expect((await get(id)).warning).toContain(`${TEST_LIMITS.maxDownloadsPerSession} downloads`);
  });

  it('waits for downloads still in flight when the recording stops', async () => {
    const { recorder, id } = await recording();
    const bytes = new TextEncoder().encode('tarde');
    recorder.download({
      ...fakeDownload({ fileName: 'lento.txt', at: 10 }),
      file: new Promise((resolve) =>
        setTimeout(() => resolve({ status: 'ready', size: bytes.byteLength, bytes }), 80),
      ),
    });
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    expect(await list(id)).toMatchObject([{ fileName: 'lento.txt', status: 'saved' }]);
  });

  it('does not link anything in "Só prints" (no steps), but still keeps the file', async () => {
    const recorder = new FakeRecorderBrowser();
    t = await createTestApp({ tests: { recorder, settler: instantSettler } });
    const { json } = await t.api<TestSessionDto>('POST', BASE, {
      name: 'Prints',
      startUrl: 'https://a.b/login',
    });
    await t.api('POST', `${BASE}/${json.id}/record/start`, { mode: 'capture' });
    recorder.emit({ type: 'click', facts: buttonFacts('Baixar'), at: 1 });
    recorder.download(fakeDownload({ at: 2 }));
    await idle();
    expect(await list(json.id)).toMatchObject([{ stepId: null, status: 'saved' }]);
  });
});

describe('downloads API', () => {
  it('lists newest first, filters by source and run, deletes one file and its object', async () => {
    const { recorder, id } = await recording();
    recorder.download(fakeDownload({ fileName: 'um.csv', at: 10 }));
    await idle();
    recorder.download(fakeDownload({ fileName: 'dois.csv', at: 20 }));
    await idle();
    const all = await list(id);
    expect(all.map((d) => d.fileName).sort()).toEqual(['dois.csv', 'um.csv']);
    expect(all[0]!.createdAt).toBeGreaterThanOrEqual(all[1]!.createdAt);
    expect(await list(id, '?source=replay')).toEqual([]);
    expect(await list(id, '?source=recording')).toHaveLength(2);
    expect((await t!.api('GET', `${BASE}/${id}/downloads?source=nope`)).status).toBe(400);

    const gone = all[0]!;
    expect((await t!.api('DELETE', `${BASE}/${id}/downloads/${gone.id}`)).status).toBe(200);
    expect(await list(id)).toHaveLength(1);
    expect(await storedFiles()).toHaveLength(1);
    expect((await t!.api('GET', `${BASE}/${id}/downloads/${gone.id}/file`)).status).toBe(404);
    expect((await t!.api('DELETE', `${BASE}/${id}/downloads/${gone.id}`)).status).toBe(404);
  });

  it('refuses downloads of another session and anonymous requests', async () => {
    const { recorder, id } = await recording();
    recorder.download(fakeDownload({ at: 10 }));
    await idle();
    const [item] = await list(id);
    const other = await t!.api<TestSessionDto>('POST', BASE, {
      name: 'Outra',
      startUrl: 'https://a.b/x',
    });
    expect(
      (await t!.api('GET', `${BASE}/${other.json.id}/downloads/${item!.id}/file`)).status,
    ).toBe(404);
    expect((await t!.api('DELETE', `${BASE}/${other.json.id}/downloads/${item!.id}`)).status).toBe(
      404,
    );
    expect((await t!.api('GET', `${BASE}/nao-existe/downloads`)).status).toBe(404);
    for (const [method, url] of [
      ['GET', `${BASE}/${id}/downloads`],
      ['GET', item!.fileUrl!],
      ['DELETE', `${BASE}/${id}/downloads/${item!.id}`],
    ] as const) {
      const res = await t!.app.inject({ method, url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('deleting the session deletes its downloads, rows and objects', async () => {
    const { recorder, id } = await recording();
    recorder.download(fakeDownload({ at: 10 }));
    await idle();
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    expect(await storedFiles()).toHaveLength(1);
    expect((await t!.api('DELETE', `${BASE}/${id}`)).status).toBe(200);
    expect(await storedFiles()).toEqual([]);
    expect(await t!.container.tests.repo.countDownloads(id)).toBe(0);
  });

  it('keeps downloads out of the evidence document', async () => {
    const { recorder, id } = await recording();
    recorder.download(fakeDownload({ fileName: 'segredo-do-relatorio.csv', at: 10 }));
    await idle();
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    for (const format of ['md', 'html', 'zip', 'spec']) {
      const res = await t!.app.inject({
        method: 'GET',
        url: `${BASE}/${id}/document?format=${format}`,
        headers: { cookie: t!.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.toString('latin1')).not.toContain('segredo-do-relatorio');
    }
  });
});

describe('downloads while replaying', () => {
  it('stores the files of a replay linked to the run and to the running step', async () => {
    const runner = new FakeRunner();
    const { id, click, recorder } = await recording(runner);
    await t!.api('POST', `${BASE}/${id}/record/stop`);
    runner.downloads[click.id] = [fakeDownload({ fileName: 'replay.csv' })];
    void recorder;
    const [run] = (await t!.api<TestRunDto[]>('POST', `${BASE}/${id}/runs`, {})).json;
    await t!.container.tests.runs.whenIdle();

    const items = await list(id, `?runId=${run!.id}`);
    expect(items).toMatchObject([
      {
        source: 'replay',
        runId: run!.id,
        runSeq: 1,
        stepId: click.id,
        fileName: 'replay.csv',
        status: 'saved',
      },
    ]);
    expect(await list(id, '?source=recording')).toEqual([]);
    expect(await list(id, '?runId=outra')).toEqual([]);

    // a second run adds to the history instead of replacing it
    runner.downloads[click.id] = [fakeDownload({ fileName: 'replay2.csv' })];
    await t!.api('POST', `${BASE}/${id}/runs`, {});
    await t!.container.tests.runs.whenIdle();
    const history = await list(id, '?source=replay');
    expect(history.map((d) => [d.fileName, d.runSeq])).toEqual([
      ['replay2.csv', 2],
      ['replay.csv', 1],
    ]);
  });
});
