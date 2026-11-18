import { describe, expect, it } from 'vitest';
import { driveItem, folderItem, jsonResponse } from './fake-microsoft';
import { connect, REDIRECT, setup } from './harness';

describe('OneDrive folders', () => {
  it('lists only the subfolders of the root, sorted, following pages', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on(
      'GET',
      /\/me\/drive\/root\/children\?/,
      jsonResponse(200, {
        value: [folderItem('B', 'Testes', 3), driveItem({ id: 'F', name: 'a.docx' })],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=2',
      }),
    );
    ctx.fake.on('GET', /skiptoken=2/, { value: [folderItem('A', 'Arquivos', 0)] });

    const listing = await ctx.service.listFolder(null);
    expect(listing.parent).toEqual({ id: 'root', name: 'OneDrive', path: '/', parentId: null });
    expect(listing.folders).toEqual([
      { id: 'A', name: 'Arquivos', childCount: 0 },
      { id: 'B', name: 'Testes', childCount: 3 },
    ]);
    expect(ctx.fake.callsTo('GET', /\/children/)[0]?.url).toContain('/me/drive/root/children');
  });

  it('lists a subfolder through /me/drive/items/{id}/children and reports its path', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('GET', /\/me\/drive\/items\/F1\/children/, {
      value: [folderItem('F2', '2026', 1)],
    });
    ctx.fake.on('GET', /\/me\/drive\/items\/F1\?/, {
      ...folderItem('F1', 'Testes'),
      parentReference: { id: 'ROOT', path: '/drive/root:/Documentos' },
    });

    const listing = await ctx.service.listFolder('F1');
    expect(listing.parent).toMatchObject({
      id: 'F1',
      name: 'Testes',
      path: '/Documentos/Testes',
      parentId: 'ROOT',
    });
    expect(listing.folders).toHaveLength(1);
  });

  it('stores the default folder after checking it exists, and clears it', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('GET', /\/me\/drive\/items\/F1\?/, {
      ...folderItem('F1', 'Testes'),
      parentReference: { id: 'ROOT', path: '/drive/root:' },
    });
    ctx.fake.on('GET', /\/me\/drive\/items\/FILE\?/, driveItem({ id: 'FILE' }));

    await ctx.service.setDefaultFolder('F1');
    expect(ctx.service.status(REDIRECT).defaultFolder).toEqual({
      id: 'F1',
      name: 'Testes',
      path: '/Testes',
    });
    await expect(ctx.service.setDefaultFolder('FILE')).rejects.toThrowError(/não é uma pasta/);
    expect(ctx.service.status(REDIRECT).defaultFolder?.id).toBe('F1');

    await ctx.service.setDefaultFolder(null);
    expect(ctx.service.status(REDIRECT).defaultFolder).toBeNull();
  });

  it('maps 403 and 429 (with Retry-After) from Graph', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.fake.on('GET', /\/me\/drive\/root\?/, folderItem('root', 'root'));
    ctx.fake.on(
      'GET',
      /\/me\/drive\/root\/children/,
      jsonResponse(403, { error: { code: 'accessDenied' } }),
    );
    await expect(ctx.service.listFolder(null)).rejects.toMatchObject({
      kind: 'forbidden',
      httpStatus: 403,
      code: 'onedrive_forbidden',
    });

    ctx.fake.on('GET', /\/me\/drive\/root\/children/, () =>
      jsonResponse(429, { error: { code: 'TooManyRequests' } }, { 'retry-after': '17' }),
    );
    const err = await ctx.service.listFolder(null).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate_limited', httpStatus: 429, retryAfterSec: 17 });
    expect((err as Error).message).toContain('17 s');
  });
});
