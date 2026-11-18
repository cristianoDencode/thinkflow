import {
  ECIDADE_WINDOW_TEMPLATE_ID,
  type PrototypeBlockDto,
  type PrototypeDetailDto,
  type PrototypeDto,
  type PrototypeTemplateDto,
} from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FakePrototypeRenderer } from '../prototypes/fake-renderer';
import { FakeRecorderBrowser, instantSettler } from '../testing/fake-recorder';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const API = '/api/prototypes';

async function setup() {
  const renderer = new FakePrototypeRenderer();
  t = await createTestApp({
    tests: { recorder: new FakeRecorderBrowser(), settler: instantSettler },
    prototypes: { renderer, thumbnailDebounceMs: 10 },
  });
  return { t, renderer };
}

describe('template routes', () => {
  it('require a session', async () => {
    const { t } = await setup();
    for (const [method, url] of [
      ['GET', `${API}/templates`],
      ['GET', `${API}/templates/${ECIDADE_WINDOW_TEMPLATE_ID}/thumbnail`],
      ['POST', `${API}/x/save-as-template`],
      ['PUT', `${API}/blocks/x`],
    ] as const) {
      const res = await t.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('save-as-template, list by kind, create from a template, rename and delete', async () => {
    const { t } = await setup();
    const proto = await t.api<PrototypeDetailDto>('POST', API, {
      name: 'Consulta',
      snapshot: { html: '<body><p>oi</p></body>', css: '', width: 900, height: 600 },
    });
    const saved = await t.api<PrototypeDetailDto>(
      'POST',
      `${API}/${proto.json.id}/save-as-template`,
      {
        name: 'Meu modelo',
      },
    );
    expect(saved.status).toBe(201);
    expect(saved.json).toMatchObject({ kind: 'template', name: 'Meu modelo', width: 900 });

    expect((await t.api<PrototypeDto[]>('GET', API)).json.map((p) => p.id)).toEqual([
      proto.json.id,
    ]);
    expect(
      (await t.api<PrototypeDto[]>('GET', `${API}?kind=template`)).json.map((p) => p.id),
    ).toEqual([saved.json.id]);
    expect((await t.api<PrototypeDto[]>('GET', `${API}?kind=all`)).json).toHaveLength(2);
    expect((await t.api('GET', `${API}?kind=bogus`)).status).toBe(400);

    const templates = await t.api<PrototypeTemplateDto[]>('GET', `${API}/templates`);
    expect(templates.json.map((x) => [x.id, x.builtin])).toEqual([
      [ECIDADE_WINDOW_TEMPLATE_ID, true],
      [saved.json.id, false],
    ]);

    const fromUser = await t.api<PrototypeDetailDto>('POST', API, {
      name: 'Da minha',
      fromTemplateId: saved.json.id,
    });
    expect(fromUser.status).toBe(201);
    expect(fromUser.json).toMatchObject({ kind: 'prototype', html: '<body><p>oi</p></body>' });

    const fromBuiltin = await t.api<PrototypeDetailDto>('POST', API, {
      name: 'Nova rotina',
      fromTemplateId: ECIDADE_WINDOW_TEMPLATE_ID,
      width: 1920,
      height: 1080,
    });
    expect(fromBuiltin.status).toBe(201);
    expect(fromBuiltin.json).toMatchObject({ kind: 'prototype', width: 1920, height: 1080 });
    expect(fromBuiltin.json.html).toContain('data-ec="window-title"');

    expect((await t.api('POST', API, { name: 'X', fromTemplateId: 'builtin:nada' })).status).toBe(
      404,
    );
    expect(
      (
        await t.api('POST', API, {
          name: 'X',
          fromTemplateId: ECIDADE_WINDOW_TEMPLATE_ID,
          snapshot: { html: '<p/>', css: '', width: 800, height: 600 },
        })
      ).status,
    ).toBe(400);

    const renamed = await t.api<PrototypeDetailDto>('PUT', `${API}/${saved.json.id}`, {
      name: 'Modelo renomeado',
    });
    expect(renamed.json).toMatchObject({ name: 'Modelo renomeado', kind: 'template' });
    expect((await t.api('DELETE', `${API}/${saved.json.id}`)).status).toBe(204);
    expect((await t.api<PrototypeTemplateDto[]>('GET', `${API}/templates`)).json).toHaveLength(1);
  });

  it('built-in templates are read-only: they are not prototypes, so they cannot be changed or deleted', async () => {
    const { t } = await setup();
    const id = encodeURIComponent(ECIDADE_WINDOW_TEMPLATE_ID);
    expect((await t.api('GET', `${API}/${id}`)).status).toBe(404);
    expect((await t.api('PUT', `${API}/${id}`, { name: 'X' })).status).toBe(404);
    expect((await t.api('DELETE', `${API}/${id}`)).status).toBe(404);
    expect((await t.api('POST', `${API}/${id}/save-as-template`, { name: 'X' })).status).toBe(404);
    // and the list still has it untouched
    expect((await t.api<PrototypeTemplateDto[]>('GET', `${API}/templates`)).json[0]).toMatchObject({
      builtin: true,
      name: 'Tela de sistema — perfil e-Cidade',
    });
  });

  it('renders the preview of a built-in template once (PNG) and 404s for unknown ones', async () => {
    const { t, renderer } = await setup();
    const url = `${API}/templates/${encodeURIComponent(ECIDADE_WINDOW_TEMPLATE_ID)}/thumbnail`;
    const first = await t.app.inject({ method: 'GET', url, headers: { cookie: t.cookie } });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/png');
    await t.app.inject({ method: 'GET', url, headers: { cookie: t.cookie } });
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0]).toMatchObject({ width: 1366, height: 768, scale: 1 });
    expect(renderer.calls[0]!.document).toContain('Módulo &gt; Nova rotina');
    const missing = await t.app.inject({
      method: 'GET',
      url: `${API}/templates/${encodeURIComponent('builtin:nada')}/thumbnail`,
      headers: { cookie: t.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('PUT /blocks/:id renames a block and changes its category', async () => {
    const { t } = await setup();
    const block = await t.api<PrototypeBlockDto>('POST', `${API}/blocks`, {
      name: 'Lookup',
      category: 'e-Cidade',
      html: '<div data-ec="lookup">x</div>',
      css: 'td{a:b}',
      source: 'Favorito de Consulta',
    });
    expect(block.json).toMatchObject({ category: 'e-Cidade', source: 'Favorito de Consulta' });
    const put = await t.api<PrototypeBlockDto>('PUT', `${API}/blocks/${block.json.id}`, {
      name: 'Lookup de empenho',
    });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({
      name: 'Lookup de empenho',
      category: 'e-Cidade',
      css: 'td{a:b}',
    });
    const moved = await t.api<PrototypeBlockDto>('PUT', `${API}/blocks/${block.json.id}`, {
      category: 'Meus blocos',
    });
    expect(moved.json.category).toBe('Meus blocos');
    expect((await t.api('PUT', `${API}/blocks/${block.json.id}`, {})).status).toBe(400);
    expect((await t.api('PUT', `${API}/blocks/nao-existe`, { name: 'x' })).status).toBe(404);
    expect((await t.api<PrototypeBlockDto[]>('GET', `${API}/blocks`)).json[0]).toMatchObject({
      name: 'Lookup de empenho',
      category: 'Meus blocos',
    });
  });
});
