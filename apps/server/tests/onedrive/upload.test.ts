import { describe, expect, it } from 'vitest';
import { CHUNK_UNIT } from '../../src/contexts/onedrive/domain/constants';
import { driveItem, folderItem, jsonResponse } from './fake-microsoft';
import { connect, setup } from './harness';

const NAME = 'CT 893.687 - Login.docx';
const bytes = (n: number) => new Uint8Array(n).fill(7);
const conflict = () => jsonResponse(409, { error: { code: 'nameAlreadyExists' } });
const UPLOAD_URL = 'https://sn3302.up.1drv.com/up/session-1';

describe('uploadNewDocument - simple upload', () => {
  it('PUTs the content to the default folder with conflictBehavior=fail and returns the link', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('GET', /\/me\/drive\/items\/F1\?/, folderItem('F1', 'Testes'));
    await ctx.service.setDefaultFolder('F1');
    ctx.fake.on('PUT', /\/me\/drive\/items\/F1:\//, () =>
      jsonResponse(201, driveItem({ id: 'NEW', name: NAME })),
    );

    const out = await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(1000) });
    expect(out).toEqual({ id: 'NEW', webUrl: 'https://1drv.ms/w/s!abc', name: NAME });

    const [put] = ctx.fake.callsTo('PUT', /\/content/);
    expect(put?.url).toBe(
      `https://graph.microsoft.com/v1.0/me/drive/items/F1:/${encodeURIComponent(NAME)}:/content?@microsoft.graph.conflictBehavior=fail`,
    );
    expect(put?.headers.authorization).toBe('Bearer AT-1');
    expect(put?.headers['content-type']).toContain('wordprocessingml.document');
    expect(put?.bytes).toBe(1000);
  });

  it('uses an explicit folder id over the default and the root when nothing is set', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('PUT', /\/content/, () => jsonResponse(201, driveItem()));

    await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(10) });
    await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(10), folderId: 'F9' });
    const urls = ctx.fake.callsTo('PUT', /\/content/).map((c) => c.url);
    expect(urls[0]).toContain('/me/drive/root:/');
    expect(urls[1]).toContain('/me/drive/items/F9:/');
  });

  it('resolves a folder path', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('GET', /\/me\/drive\/root:\/Testes\/2026\?/, folderItem('F26', '2026'));
    ctx.fake.on('PUT', /\/content/, () => jsonResponse(201, driveItem()));

    await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(10), path: '/Testes/2026' });
    expect(ctx.fake.callsTo('PUT', /\/content/)[0]?.url).toContain('/items/F26:/');
  });

  it('never replaces: renames to " (2)" and " (3)" on name conflicts', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('PUT', /\/content/, (_call, n) =>
      n < 3 ? conflict() : jsonResponse(201, driveItem({ name: 'CT 893.687 - Login (3).docx' })),
    );

    const out = await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(10) });
    expect(out.name).toBe('CT 893.687 - Login (3).docx');
    const urls = ctx.fake.callsTo('PUT', /\/content/).map((c) => decodeURIComponent(c.url));
    expect(urls).toHaveLength(3);
    expect(urls[1]).toContain('CT 893.687 - Login (2).docx');
    expect(urls[2]).toContain('CT 893.687 - Login (3).docx');
    for (const u of urls) {
      expect(u).toContain('conflictBehavior=fail');
      expect(u).not.toMatch(/replace/);
    }
  });

  it('gives up after too many conflicts', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('PUT', /\/content/, conflict);
    await expect(
      ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(10) }),
    ).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('sanitizes the file name', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('PUT', /\/content/, () => jsonResponse(201, driveItem()));
    await ctx.service.uploadNewDocument({ fileName: 'CT 1 - a/b: c?.docx', bytes: bytes(10) });
    expect(decodeURIComponent(ctx.fake.callsTo('PUT', /\/content/)[0]?.url ?? '')).toContain(
      '/CT 1 - a-b- c-.docx:/content',
    );
  });

  it('fetches webUrl when the response omits it', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('PUT', /\/content/, () =>
      jsonResponse(201, driveItem({ id: 'NEW', webUrl: undefined })),
    );
    ctx.fake.on(
      'GET',
      /\/me\/drive\/items\/NEW\?/,
      driveItem({ id: 'NEW', webUrl: 'https://1drv.ms/w/final' }),
    );
    const out = await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(10) });
    expect(out.webUrl).toBe('https://1drv.ms/w/final');
  });

  it('explains a missing default folder and maps 403', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('GET', /\/me\/drive\/items\/F1\?/, folderItem('F1', 'Testes'));
    await ctx.service.setDefaultFolder('F1');
    ctx.fake.on('PUT', /\/content/, () => jsonResponse(404, { error: { code: 'itemNotFound' } }));
    await expect(
      ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(10) }),
    ).rejects.toThrowError(/pasta padrão/);

    ctx.fake.on('PUT', /\/content/, () => jsonResponse(403, { error: { code: 'accessDenied' } }));
    await expect(
      ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(10) }),
    ).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });
});

describe('uploadNewDocument - upload session', () => {
  const total = CHUNK_UNIT * 4 + 1000; // 2 x 320 KiB chunks + a short tail -> 3 PUTs
  const limit = CHUNK_UNIT; // anything >= 320 KiB goes through a session in these tests

  function session(ctx: ReturnType<typeof setup>, finalStatus = 201) {
    ctx.fake.on('POST', /createUploadSession/, { uploadUrl: UPLOAD_URL });
    ctx.fake.on('PUT', /up\.1drv\.com/, (call) => {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(call.headers['content-range'] ?? '');
      const end = Number(m?.[2]);
      const size = Number(m?.[3]);
      return end + 1 >= size
        ? jsonResponse(finalStatus, driveItem({ id: 'BIG', name: NAME }))
        : jsonResponse(202, { nextExpectedRanges: [`${end + 1}-`] });
    });
  }

  it('creates the session with conflictBehavior=fail and sends 320 KiB-multiple fragments without the bearer token', async () => {
    const ctx = setup({ smallUploadLimit: limit });
    await connect(ctx);
    session(ctx);

    const out = await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(total) });
    expect(out).toMatchObject({ id: 'BIG', name: NAME, webUrl: 'https://1drv.ms/w/s!abc' });

    const [create] = ctx.fake.callsTo('POST', /createUploadSession/);
    expect(create?.url).toBe(
      `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURIComponent(NAME)}:/createUploadSession`,
    );
    expect(JSON.parse(create?.text ?? '{}')).toEqual({
      item: { '@microsoft.graph.conflictBehavior': 'fail', name: NAME },
    });
    expect(create?.headers.authorization).toBe('Bearer AT-1');

    const puts = ctx.fake.callsTo('PUT', /up\.1drv\.com/);
    expect(puts.map((p) => p.headers['content-range'])).toEqual([
      `bytes 0-${CHUNK_UNIT * 2 - 1}/${total}`,
      `bytes ${CHUNK_UNIT * 2}-${CHUNK_UNIT * 4 - 1}/${total}`,
      `bytes ${CHUNK_UNIT * 4}-${total - 1}/${total}`,
    ]);
    expect(puts.map((p) => p.bytes)).toEqual([CHUNK_UNIT * 2, CHUNK_UNIT * 2, 1000]);
    for (const p of puts) {
      expect(p.headers.authorization).toBeUndefined();
    }
  });

  it('uses a session from 4 MiB by default', async () => {
    const ctx = setup(); // default limit
    await connect(ctx);
    session(ctx);
    ctx.fake.on('PUT', /\/content/, () => jsonResponse(201, driveItem()));
    await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(4 * 1024 * 1024 - 1) });
    expect(ctx.fake.callsTo('POST', /createUploadSession/)).toHaveLength(0);
    await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(4 * 1024 * 1024) });
    expect(ctx.fake.callsTo('POST', /createUploadSession/)).toHaveLength(1);
  });

  it('renames when the session creation reports a conflict', async () => {
    const ctx = setup({ smallUploadLimit: limit });
    await connect(ctx);
    session(ctx);
    ctx.fake.on('POST', /createUploadSession/, (_call, n) =>
      n === 1 ? conflict() : jsonResponse(200, { uploadUrl: UPLOAD_URL }),
    );
    await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(total) });
    const creates = ctx.fake.callsTo('POST', /createUploadSession/);
    expect(JSON.parse(creates[1]?.text ?? '{}').item.name).toBe('CT 893.687 - Login (2).docx');
  });

  it('cancels the session and renames when the last fragment hits a conflict', async () => {
    const ctx = setup({ smallUploadLimit: limit });
    await connect(ctx);
    session(ctx);
    let lastFragments = 0;
    ctx.fake.on('PUT', /up\.1drv\.com/, (call) => {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(call.headers['content-range'] ?? '');
      const end = Number(m?.[2]);
      if (end + 1 < Number(m?.[3]))
        return jsonResponse(202, { nextExpectedRanges: [`${end + 1}-`] });
      return ++lastFragments === 1
        ? conflict()
        : jsonResponse(201, driveItem({ id: 'BIG', name: 'x (2).docx' }));
    });
    ctx.fake.on('DELETE', /up\.1drv\.com/, new Response(null, { status: 204 }));

    const out = await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(total) });
    expect(out.name).toBe('x (2).docx');
    expect(ctx.fake.callsTo('DELETE', /up\.1drv\.com/)).toHaveLength(1);
    expect(ctx.fake.callsTo('POST', /createUploadSession/)).toHaveLength(2);
  });

  it('honors Retry-After on a throttled fragment and retries the same range', async () => {
    const ctx = setup({ smallUploadLimit: limit });
    await connect(ctx);
    session(ctx);
    let first = true;
    ctx.fake.on('PUT', /up\.1drv\.com/, (call) => {
      if (first) {
        first = false;
        return jsonResponse(429, { error: { code: 'TooManyRequests' } }, { 'retry-after': '3' });
      }
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(call.headers['content-range'] ?? '');
      const end = Number(m?.[2]);
      return end + 1 >= Number(m?.[3])
        ? jsonResponse(201, driveItem({ id: 'BIG', name: NAME }))
        : jsonResponse(202, { nextExpectedRanges: [`${end + 1}-`] });
    });

    await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(total) });
    expect(ctx.sleeps).toEqual([3000]);
    const ranges = ctx.fake.callsTo('PUT', /up\.1drv\.com/).map((c) => c.headers['content-range']);
    expect(ranges[0]).toBe(ranges[1]);
  });

  it('resumes from what the service expects after a 416', async () => {
    const ctx = setup({ smallUploadLimit: limit });
    await connect(ctx);
    session(ctx);
    let first = true;
    ctx.fake.on('PUT', /up\.1drv\.com/, (call) => {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(call.headers['content-range'] ?? '');
      const start = Number(m?.[1]);
      const end = Number(m?.[2]);
      if (first) {
        first = false;
        return jsonResponse(416, { error: { code: 'invalidRange' } });
      }
      return end + 1 >= Number(m?.[3]) && start > 0
        ? jsonResponse(201, driveItem({ id: 'BIG', name: NAME }))
        : jsonResponse(202, { nextExpectedRanges: [`${end + 1}-`] });
    });
    ctx.fake.on('GET', /up\.1drv\.com/, { nextExpectedRanges: [`${CHUNK_UNIT * 2}-`] });

    const out = await ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(total) });
    expect(out.id).toBe('BIG');
    const ranges = ctx.fake.callsTo('PUT', /up\.1drv\.com/).map((c) => c.headers['content-range']);
    expect(ranges[1]).toBe(`bytes ${CHUNK_UNIT * 2}-${CHUNK_UNIT * 4 - 1}/${total}`);
  });

  it('gives up with a clear error after repeated server failures and cancels the session', async () => {
    const ctx = setup({ smallUploadLimit: limit });
    await connect(ctx);
    session(ctx);
    ctx.fake.on('PUT', /up\.1drv\.com/, () => jsonResponse(503, {}));
    ctx.fake.on('DELETE', /up\.1drv\.com/, new Response(null, { status: 204 }));
    await expect(
      ctx.service.uploadNewDocument({ fileName: NAME, bytes: bytes(total) }),
    ).rejects.toMatchObject({
      kind: 'upstream',
    });
    expect(ctx.fake.callsTo('PUT', /up\.1drv\.com/)).toHaveLength(3);
    expect(ctx.fake.callsTo('DELETE', /up\.1drv\.com/)).toHaveLength(1);
  });
});

describe('PDF conversion', () => {
  it('downloads the PDF rendition through ?format=pdf', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on(
      'GET',
      /\/items\/ITEM1\/content\?format=pdf/,
      () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }),
    );
    const pdf = await ctx.service.downloadPdf('ITEM1');
    expect(Array.from(pdf)).toEqual([37, 80, 68, 70]);
    expect(ctx.fake.callsTo('GET', /format=pdf/)[0]?.headers.authorization).toBe('Bearer AT-1');
  });
});
