import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  LibraryDetailDto,
  LibraryDto,
  LibraryDocumentTextDto,
  LibrarySearchResultDto,
  LibraryUploadResultDto,
} from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { multipartBody } from '../helpers';
import { makeDocx, makePdf, PNG_1X1 } from '../library/library-fixtures';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp;
afterEach(async () => t?.close());

async function upload(
  libraryId: string,
  files: Parameters<typeof multipartBody>[0],
  headers?: Record<string, string>,
) {
  const body = await multipartBody(files);
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/libraries/${libraryId}/documents`,
    headers: { cookie: t.cookie, ...body.headers, ...headers },
    payload: body.payload,
  });
  return { status: res.statusCode, json: JSON.parse(res.body) as never };
}

async function createLibrary(name = 'Regras do sistema'): Promise<LibraryDto> {
  const res = await t.api<LibraryDto>('POST', '/api/libraries', { name, description: 'Docs' });
  expect(res.status).toBe(201);
  return res.json;
}

describe('library API', () => {
  it('requires a session', async () => {
    t = await createTestApp();
    for (const [method, url] of [
      ['GET', '/api/libraries'],
      ['POST', '/api/libraries'],
      ['GET', '/api/library/settings'],
      ['POST', '/api/libraries/x/documents'],
    ] as const) {
      const res = await t.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('creates, lists, updates and deletes libraries', async () => {
    t = await createTestApp();
    const lib = await createLibrary();
    expect(lib).toMatchObject({ name: 'Regras do sistema', engine: 'local', documentCount: 0 });

    expect((await t.api('POST', '/api/libraries', { name: 'Regras do sistema' })).status).toBe(409);
    expect((await t.api('POST', '/api/libraries', { name: '' })).status).toBe(400);
    expect((await t.api('GET', '/api/libraries/nope')).status).toBe(404);
    expect((await t.api('DELETE', '/api/libraries/nope')).status).toBe(404);

    const other = await createLibrary('Outra');
    const clash = await t.api('PATCH', `/api/libraries/${other.id}`, { name: 'Regras do sistema' });
    expect(clash.status).toBe(409);
    const patched = await t.api<LibraryDto>('PATCH', `/api/libraries/${lib.id}`, {
      description: 'Nova descrição',
    });
    expect(patched.json.description).toBe('Nova descrição');
    expect((await t.api<LibraryDto[]>('GET', '/api/libraries')).json).toHaveLength(2);

    expect((await t.api('DELETE', `/api/libraries/${other.id}`)).status).toBe(200);
    expect((await t.api<LibraryDto[]>('GET', '/api/libraries')).json).toHaveLength(1);
  });

  it('refuses to create a NotebookLM library when the engine is not configured', async () => {
    t = await createTestApp();
    const res = await t.api<{ error: { code: string } }>('POST', '/api/libraries', {
      name: 'Remota',
      engine: 'notebooklm',
      acceptRemoteUpload: true,
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('notebooklm_not_configured');
  });

  it('uploads md, txt, pdf and docx, indexes them and searches', async () => {
    t = await createTestApp();
    const lib = await createLibrary();
    const pdf = await makePdf(['Capa do manual', 'Prazo de aprovação: 5 dias']);
    const docx = await makeDocx(['Política de reembolso', 'Reembolsos exigem nota fiscal.']);
    const res = await upload(lib.id, [
      { name: 'regras.md', bytes: '# Regras\n\nO acesso exige autenticação em dois fatores.' },
      { name: 'notas.txt', bytes: 'Anotações soltas sobre férias coletivas.' },
      { name: 'manual.pdf', bytes: pdf, type: 'application/pdf' },
      { name: 'politica.docx', bytes: docx },
    ]);
    expect(res.status).toBe(201);
    const result = res.json as LibraryUploadResultDto;
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(4);
    expect(result.accepted.every((d) => d.status === 'processing')).toBe(true);

    await t.container.library.whenIdle();
    const detail = (await t.api<LibraryDetailDto>('GET', `/api/libraries/${lib.id}`)).json;
    expect(detail.documentCount).toBe(4);
    expect(detail.readyCount).toBe(4);
    for (const d of detail.documents) {
      expect(d.status, d.name).toBe('ready');
      expect(d.chunkCount).toBeGreaterThan(0);
      expect(d.extraction).toBe('text');
    }
    expect(detail.documents.find((d) => d.name === 'manual.pdf')?.pageCount).toBe(2);
    expect(detail.totalChars).toBeGreaterThan(100);

    const search = (
      await t.api<LibrarySearchResultDto>(
        'GET',
        `/api/libraries/${lib.id}/search?q=${encodeURIComponent('aprovacao')}`,
      )
    ).json;
    expect(search.engine).toBe('local');
    expect(search.hits[0]).toMatchObject({ documentName: 'manual.pdf', pageFrom: 1, pageTo: 2 });
    expect(search.toolOutput).toContain('manual.pdf (p. 1-2)');
    expect(search.toolOutput).toContain('Prazo de aprovação: 5 dias');

    const docxSearch = (
      await t.api<LibrarySearchResultDto>('GET', `/api/libraries/${lib.id}/search?q=reembolsos`)
    ).json;
    expect(docxSearch.hits.map((h) => h.documentName)).toEqual(['politica.docx']);

    const none = (
      await t.api<LibrarySearchResultDto>('GET', `/api/libraries/${lib.id}/search?q=zzzxyz`)
    ).json;
    expect(none.hits).toEqual([]);
    expect(none.toolOutput).toContain('Nenhum trecho relevante');
    expect((await t.api('GET', `/api/libraries/${lib.id}/search`)).status).toBe(400);
  });

  it('previews extracted text with pagination', async () => {
    t = await createTestApp();
    const lib = await createLibrary();
    const up = await upload(lib.id, [{ name: 'a.txt', bytes: 'abcdefghij '.repeat(100) }]);
    const docId = (up.json as LibraryUploadResultDto).accepted[0]!.id;
    await t.container.library.whenIdle();
    const page = (
      await t.api<LibraryDocumentTextDto>(
        'GET',
        `/api/libraries/${lib.id}/documents/${docId}/text?offset=0&limit=50`,
      )
    ).json;
    expect(page.text).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBeGreaterThan(1000);
    expect((await t.api('GET', `/api/libraries/${lib.id}/documents/nope/text`)).status).toBe(404);
  });

  it('rejects duplicates, unsupported types, legacy .doc and empty files', async () => {
    t = await createTestApp();
    const lib = await createLibrary();
    await upload(lib.id, [{ name: 'a.txt', bytes: 'conteúdo igual' }]);
    const res = await upload(lib.id, [
      { name: 'copia.txt', bytes: 'conteúdo igual' },
      { name: 'programa.exe', bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]) },
      { name: 'antigo.doc', bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) },
      { name: 'vazio.txt', bytes: '' },
      { name: 'b.txt', bytes: 'outro conteúdo' },
    ]);
    expect(res.status).toBe(201);
    const result = res.json as LibraryUploadResultDto;
    expect(result.accepted.map((d) => d.name)).toEqual(['b.txt']);
    const reasons = Object.fromEntries(result.rejected.map((r) => [r.name, r.reason]));
    expect(reasons['copia.txt']).toBe('Documento já existe nesta biblioteca (a.txt)');
    expect(reasons['programa.exe']).toMatch(/Tipo não suportado/);
    expect(reasons['antigo.doc']).toMatch(/salve como \.docx/);
    expect(reasons['vazio.txt']).toBeDefined();

    const sameBatch = await upload(lib.id, [
      { name: 'x.txt', bytes: 'repetido no lote' },
      { name: 'y.txt', bytes: 'repetido no lote' },
    ]);
    expect((sameBatch.json as LibraryUploadResultDto).rejected[0]!.reason).toMatch(/x\.txt/);
  });

  it('rejects non-multipart requests, files over 20 MB and unknown libraries', async () => {
    t = await createTestApp();
    const lib = await createLibrary();
    const plain = await t.api('POST', `/api/libraries/${lib.id}/documents`, { files: [] });
    expect(plain.status).toBe(400);

    const big = await upload(lib.id, [
      { name: 'grande.txt', bytes: new Uint8Array(21 * 1024 * 1024).fill(97) },
    ]);
    expect(big.status).toBe(413);
    expect((big.json as { error: { message: string } }).error.message).toBe(
      'Arquivo maior que 20 MB',
    );

    const missing = await upload('nope', [{ name: 'a.txt', bytes: 'x y z' }]);
    expect(missing.status).toBe(404);

    const tooMany = await upload(
      lib.id,
      Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, bytes: `texto ${i}` })),
    );
    expect(tooMany.status).toBe(413);
  });

  it('accepts more than 50 documents in a local library and exposes its limit', async () => {
    t = await createTestApp();
    const lib = await createLibrary();
    expect(lib.maxDocuments).toBe(1000);
    for (let batch = 0; batch < 5; batch++) {
      const res = await upload(
        lib.id,
        Array.from({ length: 10 }, (_, i) => ({
          name: `doc-${batch * 10 + i}.txt`,
          bytes: `texto único número ${batch * 10 + i}`,
        })),
      );
      expect((res.json as LibraryUploadResultDto).accepted).toHaveLength(10);
    }
    const res = await upload(lib.id, [{ name: 'extra.txt', bytes: 'o quinquagésimo primeiro' }]);
    const result = res.json as LibraryUploadResultDto;
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    const detail = (await t.api<LibraryDetailDto>('GET', `/api/libraries/${lib.id}`)).json;
    expect(detail.documentCount).toBe(51);
    expect(detail.maxDocuments).toBe(1000);
  });

  it('fails images while OCR is off, then indexes them once an OCR engine is on', async () => {
    t = await createTestApp();
    expect((await t.api('PUT', '/api/library/settings', { ocr: 'off' })).status).toBe(200);
    const lib = await createLibrary();
    const res = await upload(lib.id, [{ name: 'foto.png', bytes: PNG_1X1 }]);
    expect((res.json as LibraryUploadResultDto).accepted[0]).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
    });
    await t.container.library.whenIdle();
    let detail = (await t.api<LibraryDetailDto>('GET', `/api/libraries/${lib.id}`)).json;
    expect(detail.documents[0]).toMatchObject({ status: 'error' });
    expect(detail.documents[0]!.error).toBe('OCR desativado em Biblioteca → Configurações');
    await t.close();

    t = await createTestApp({
      ocrEngine: {
        method: 'ocr-local',
        recognize: async () => 'Texto da imagem: prazo de 10 dias',
      },
    });
    const lib2 = await createLibrary();
    await upload(lib2.id, [{ name: 'foto.png', bytes: PNG_1X1 }]);
    await t.container.library.whenIdle();
    detail = (await t.api<LibraryDetailDto>('GET', `/api/libraries/${lib2.id}`)).json;
    expect(detail.documents[0]).toMatchObject({ status: 'ready', extraction: 'ocr-local' });
    const search = (
      await t.api<LibrarySearchResultDto>('GET', `/api/libraries/${lib2.id}/search?q=prazo`)
    ).json;
    expect(search.hits[0]!.documentName).toBe('foto.png');
  });

  it('reindexes a document and removes deleted documents from search and disk', async () => {
    t = await createTestApp();
    const lib = await createLibrary();
    const up = await upload(lib.id, [{ name: 'a.md', bytes: 'Procedimento de backup semanal.' }]);
    const doc = (up.json as LibraryUploadResultDto).accepted[0]!;
    await t.container.library.whenIdle();

    // the original lives in the object store (library/ namespace), not on the local disk
    const key = `library/${lib.id}/${doc.id}.md`;
    expect(await t.store.head(key)).toMatchObject({ contentType: 'text/markdown' });
    expect(fs.readdirSync(t.libraryDir)).toEqual([]);

    const re = await t.api<{ status: string }>(
      'POST',
      `/api/libraries/${lib.id}/documents/${doc.id}/reindex`,
    );
    expect(re.status).toBe(202);
    expect(re.json.status).toBe('processing');
    await t.container.library.whenIdle();
    const detail = (await t.api<LibraryDetailDto>('GET', `/api/libraries/${lib.id}`)).json;
    expect(detail.documents[0]).toMatchObject({ status: 'ready', chunkCount: 1 });
    const hits = async () =>
      (await t.api<LibrarySearchResultDto>('GET', `/api/libraries/${lib.id}/search?q=backup`)).json
        .hits;
    expect(await hits()).toHaveLength(1);

    expect((await t.api('DELETE', `/api/libraries/${lib.id}/documents/${doc.id}`)).status).toBe(
      200,
    );
    expect(await hits()).toEqual([]);
    expect(await t.store.head(key)).toBeNull();
    expect((await t.api('DELETE', `/api/libraries/${lib.id}/documents/${doc.id}`)).status).toBe(
      404,
    );
    expect((await t.api('DELETE', `/api/libraries/other/documents/${doc.id}`)).status).toBe(404);
  });

  it('deletes the library with its files, documents and index', async () => {
    t = await createTestApp();
    const lib = await createLibrary();
    await upload(lib.id, [{ name: 'a.md', bytes: 'Texto sobre auditoria interna.' }]);
    await t.container.library.whenIdle();
    const keys = async () => {
      const out: string[] = [];
      for await (const info of t!.store.list(`library/${lib.id}/`)) out.push(info.key);
      return out;
    };
    expect(await keys()).toHaveLength(1);
    expect((await t.api('DELETE', `/api/libraries/${lib.id}`)).status).toBe(200);
    expect(await keys()).toEqual([]);
    expect((await t.api('GET', `/api/libraries/${lib.id}`)).status).toBe(404);
  });

  it('refuses uploads with a pt-BR 503 while the storage is down, and accepts them again later', async () => {
    t = await createTestApp();
    const lib = await createLibrary();
    t.store.fail('MinIO fora do ar');
    await t.container.storage.monitor.refresh();
    const down = await upload(lib.id, [{ name: 'a.md', bytes: 'Texto qualquer.' }]);
    expect(down.status).toBe(503);
    expect(JSON.stringify(down.json)).toContain('armazenamento de documentos está indisponível');
    expect(
      (await t.api<LibraryDetailDto>('GET', `/api/libraries/${lib.id}`)).json.documents,
    ).toEqual([]);

    t.store.fail(null);
    await t.container.storage.monitor.refresh();
    const up = await upload(lib.id, [{ name: 'a.md', bytes: 'Texto qualquer.' }]);
    expect((up.json as LibraryUploadResultDto).accepted).toHaveLength(1);
  });

  it('reads files left on disk by older versions and moves them into the store at boot', async () => {
    const libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkflow-legacy-lib-'));
    try {
      t = await createTestApp({ libraryDir });
      const lib = await createLibrary();
      const up = await upload(lib.id, [{ name: 'a.md', bytes: 'Política de senhas fortes.' }]);
      const doc = (up.json as LibraryUploadResultDto).accepted[0]!;
      await t.container.library.whenIdle();
      // simulate an upload made before the object store: the file only exists on disk
      const key = `${lib.id}/${doc.id}.md`;
      const bytes = (await t.store.getBytes(`library/${key}`))!;
      await t.store.delete(`library/${key}`);
      fs.mkdirSync(path.join(libraryDir, lib.id), { recursive: true });
      fs.writeFileSync(path.join(libraryDir, key), bytes);

      // still readable (fallback) before the migration runs
      const re = await t.api('POST', `/api/libraries/${lib.id}/documents/${doc.id}/reindex`);
      expect(re.status).toBe(202);
      await t.container.library.whenIdle();
      const detail = (await t.api<LibraryDetailDto>('GET', `/api/libraries/${lib.id}`)).json;
      expect(detail.documents[0]).toMatchObject({ status: 'ready' });

      const result = await t.container.library.migrateLegacyFiles();
      expect(result).toEqual({ migrated: 1, skipped: 0, failed: 0 });
      expect(await t.store.head(`library/${key}`)).toMatchObject({ size: bytes.byteLength });
      expect(fs.existsSync(path.join(libraryDir, key))).toBe(false);
      expect(await t.container.library.migrateLegacyFiles()).toEqual({
        migrated: 0,
        skipped: 0,
        failed: 0,
      });
    } finally {
      fs.rmSync(libraryDir, { recursive: true, force: true });
    }
  });

  it('builds a chat toolset that returns bounded excerpts', async () => {
    t = await createTestApp();
    const lib = await createLibrary();
    await upload(lib.id, [{ name: 'regras.md', bytes: 'O prazo de aprovação é de 5 dias úteis.' }]);
    await t.container.library.whenIdle();
    const tools = await t.container.library.service.chatTools(lib.id, { maxOutputChars: 6000 });
    expect(tools?.tools[0]?.name).toBe('buscar_na_biblioteca');
    const out = await tools!.call('buscar_na_biblioteca', { consulta: 'prazo aprovação' });
    expect(out.text).toContain('regras.md');
    expect(out.text).toContain('5 dias úteis');
    expect(
      await t.container.library.service.chatTools('missing', { maxOutputChars: 1 }),
    ).toBeNull();
  });

  it('reads and writes the OCR settings', async () => {
    t = await createTestApp();
    expect((await t.api('GET', '/api/library/settings')).json).toEqual({
      ocr: 'local',
      ocrModel: '',
      ocrLanguages: 'por+eng',
    });
    const put = await t.api('PUT', '/api/library/settings', {
      ocr: 'vision',
      ocrModel: 'gemini-2.0-flash',
      ocrLanguages: 'por',
    });
    expect(put.status).toBe(200);
    expect((await t.api<{ ocr: string }>('GET', '/api/library/settings')).json.ocr).toBe('vision');
    expect((await t.api('PUT', '/api/library/settings', { ocr: 'bogus' })).status).toBe(400);
  });
});
