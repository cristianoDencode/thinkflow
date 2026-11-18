import { ECIDADE_WINDOW_TEMPLATE_ID } from '@thinkflow/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrototypeService } from '../../src/contexts/prototypes/application/prototype-service';
import { BUILTIN_TEMPLATES } from '../../src/contexts/prototypes/domain/builtin-templates';
import { ObjectPrototypeStore } from '../../src/contexts/prototypes/infrastructure/object-prototype-store';
import {
  SqlitePrototypeRepository,
  SqliteSessionLookup,
} from '../../src/contexts/prototypes/infrastructure/sqlite-prototype-repository';
import { FakeClock } from '../../src/shared/kernel/clock';
import { scopeObjectStore } from '../../src/shared/kernel/scoped-object-store';
import { openDatabase, type DbHandle } from '../../src/shared/infrastructure/db/client';
import { MemoryObjectStore } from '../../src/shared/infrastructure/storage/memory-object-store';
import { seqIds } from '../helpers';

let handle: DbHandle;
let clock: FakeClock;
let service: PrototypeService;

beforeEach(() => {
  handle = openDatabase(':memory:');
  clock = new FakeClock();
  service = new PrototypeService({
    repo: new SqlitePrototypeRepository(handle.db),
    files: new ObjectPrototypeStore(scopeObjectStore(new MemoryObjectStore(), '', 'prototypes')),
    sessions: new SqliteSessionLookup(handle.db),
    clock,
    ids: seqIds(),
  });
});
afterEach(() => handle.close());

const snap = (html: string, css = '') => ({ html, css, width: 800, height: 600 });

describe('the built-in "Tela de sistema — perfil e-Cidade"', () => {
  const [template] = BUILTIN_TEMPLATES;

  it('is a small static asset with the window parts marked for the editor', () => {
    expect(template!.id).toBe(ECIDADE_WINDOW_TEMPLATE_ID);
    const { html, css, width, height } = template!.snapshot;
    expect([width, height]).toEqual([1366, 768]);
    expect(template!.sizes).toEqual([
      { width: 1366, height: 768 },
      { width: 1920, height: 1080 },
    ]);
    expect(html.length + css.length).toBeLessThan(300 * 1024);
    for (const marker of ['data-ec="window-title"', 'data-ec="status-bar"', 'data-ec="fieldset"']) {
      expect(html).toContain(marker);
    }
    expect(html).toContain('Módulo &gt; Nova rotina');
    expect(html).toContain('MENU');
    expect(html).toContain('Instituição:');
    expect(html).toContain('Exercício:');
    // five window buttons, all as inlined images (the render has no network)
    expect(html.match(/ecw-btn/g)).toHaveLength(5 + 1); // + the settings modifier class
    expect(html).not.toMatch(/src="https?:/);
    expect(css).not.toMatch(/url\(["']?https?:/);
  });

  it('survives the sanitizer (images and gradients included)', async () => {
    const created = await service.create({
      name: 'Nova rotina',
      fromTemplateId: ECIDADE_WINDOW_TEMPLATE_ID,
    });
    expect(created.html).toContain('data-ec="window-title"');
    expect(created.html).toContain('src="data:image/png;base64,');
    expect(created.css).toContain('url(data:image/png;base64,');
    expect(created.css).toContain('linear-gradient');
  });
});

describe('PrototypeService: templates', () => {
  it('lists prototypes by default, templates with kind=template and everything with kind=all', async () => {
    const proto = await service.create({ name: 'Tela', snapshot: snap('<p>a</p>') });
    const template = await service.saveAsTemplate(proto.id, { name: 'Modelo A' });
    expect(template.kind).toBe('template');
    expect((await service.list()).map((p) => p.name)).toEqual(['Tela']);
    expect((await service.list({ kind: 'prototype' })).map((p) => p.kind)).toEqual(['prototype']);
    expect((await service.list({ kind: 'template' })).map((p) => p.name)).toEqual(['Modelo A']);
    expect(await service.list({ kind: 'all' })).toHaveLength(2);
  });

  it('save-as-template copies the current snapshot (it does not link to the original)', async () => {
    const proto = await service.create({
      name: 'Consulta',
      snapshot: snap('<p>um</p>', 'p{color:red}\n/* tf-edits */\np{margin:1px}'),
    });
    clock.advance(1000);
    const template = await service.saveAsTemplate(proto.id, { name: ' Meu modelo ' });
    expect(template).toMatchObject({
      name: 'Meu modelo',
      kind: 'template',
      html: '<p>um</p>',
      css: 'p{color:red}\n/* tf-edits */\np{margin:1px}',
      width: 800,
      height: 600,
      versionCount: 1,
      sessionId: null,
    });
    expect(template.id).not.toBe(proto.id);
    expect(template.versionId).not.toBe(proto.versionId);

    // editing the original afterwards leaves the template alone, and vice versa
    await service.update(proto.id, { snapshot: snap('<p>dois</p>') });
    expect((await service.get(template.id)).html).toBe('<p>um</p>');
    await service.update(template.id, { snapshot: snap('<p>modelo editado</p>') });
    expect((await service.get(proto.id)).html).toBe('<p>dois</p>');
    // deleting the original keeps the template
    await service.delete(proto.id);
    expect((await service.get(template.id)).html).toBe('<p>modelo editado</p>');
  });

  it('save-as-template requires a name and an existing prototype', async () => {
    const proto = await service.create({ name: 'A' });
    await expect(service.saveAsTemplate(proto.id, { name: '  ' })).rejects.toThrow();
    await expect(service.saveAsTemplate('nao-existe', { name: 'X' })).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it('creates a prototype from the built-in template, with the size asked for', async () => {
    const created = await service.create({
      name: 'Nova rotina',
      fromTemplateId: ECIDADE_WINDOW_TEMPLATE_ID,
    });
    expect(created).toMatchObject({ kind: 'prototype', width: 1366, height: 768, versionCount: 1 });
    expect(created.versions[0]?.note).toContain('Tela de sistema — perfil e-Cidade');
    const full = await service.create({
      name: 'Full HD',
      fromTemplateId: ECIDADE_WINDOW_TEMPLATE_ID,
      width: 1920,
      height: 1080,
    });
    expect([full.width, full.height]).toEqual([1920, 1080]);
    // the built-in is a copy: the new prototype is listed, the template is not
    expect((await service.list()).map((p) => p.name).sort()).toEqual(['Full HD', 'Nova rotina']);
  });

  it('creates a prototype from a user template (a copy of its current version)', async () => {
    const proto = await service.create({ name: 'Base', snapshot: snap('<p>base</p>', 'p{a:b}') });
    const template = await service.saveAsTemplate(proto.id, { name: 'Modelo' });
    await service.update(template.id, { snapshot: snap('<p>v2</p>', 'p{c:d}') });
    const created = await service.create({ name: 'Filha', fromTemplateId: template.id });
    expect(created).toMatchObject({ kind: 'prototype', html: '<p>v2</p>', css: 'p{c:d}' });
    expect(created.id).not.toBe(template.id);
    await service.update(created.id, { snapshot: snap('<p>filha</p>') });
    expect((await service.get(template.id)).html).toBe('<p>v2</p>');
  });

  it('refuses unknown templates, a prototype used as template, and template + snapshot together', async () => {
    const proto = await service.create({ name: 'Comum' });
    await expect(
      service.create({ name: 'X', fromTemplateId: 'builtin:nao-existe' }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    await expect(service.create({ name: 'X', fromTemplateId: 'nao-existe' })).rejects.toMatchObject(
      { httpStatus: 404 },
    );
    await expect(service.create({ name: 'X', fromTemplateId: proto.id })).rejects.toMatchObject({
      httpStatus: 404,
    });
    await expect(
      service.create({
        name: 'X',
        fromTemplateId: ECIDADE_WINDOW_TEMPLATE_ID,
        snapshot: snap('<p/>'),
      }),
    ).rejects.toThrow();
  });

  it('templates(): built-ins first, then the user templates (newest first)', async () => {
    const a = await service.create({ name: 'A' });
    await service.saveAsTemplate(a.id, { name: 'Primeiro' });
    clock.advance(1000);
    await service.saveAsTemplate(a.id, { name: 'Segundo' });
    const list = await service.templates();
    expect(list.map((t) => [t.name, t.builtin])).toEqual([
      ['Tela de sistema — perfil e-Cidade', true],
      ['Segundo', false],
      ['Primeiro', false],
    ]);
    expect(list[0]).toMatchObject({
      id: ECIDADE_WINDOW_TEMPLATE_ID,
      width: 1366,
      thumbnailUrl: expect.stringContaining('/thumbnail'),
    });
    expect(list[0]!.sizes).toHaveLength(2);
  });

  it('a template is edited, renamed and deleted like a prototype', async () => {
    const proto = await service.create({ name: 'A' });
    const template = await service.saveAsTemplate(proto.id, { name: 'Modelo' });
    const renamed = await service.update(template.id, { name: 'Modelo novo' });
    expect(renamed).toMatchObject({ name: 'Modelo novo', kind: 'template' });
    await service.delete(template.id);
    expect(await service.list({ kind: 'template' })).toEqual([]);
  });
});

describe('PrototypeService: block updates', () => {
  it('renames a block and moves it to another category, keeping its source', async () => {
    const block = await service.createBlock({
      name: 'Lookup',
      category: 'e-Cidade',
      html: '<div data-ec="lookup">x</div>',
      source: 'Favorito de Consulta Empenho',
    });
    expect(block.source).toBe('Favorito de Consulta Empenho');
    const renamed = await service.updateBlock(block.id, { name: ' Lookup de empenho ' });
    expect(renamed).toMatchObject({ name: 'Lookup de empenho', category: 'e-Cidade' });
    const moved = await service.updateBlock(block.id, { category: 'Meus blocos' });
    expect(moved).toMatchObject({
      name: 'Lookup de empenho',
      category: 'Meus blocos',
      source: 'Favorito de Consulta Empenho',
    });
    expect((await service.blocks())[0]).toMatchObject({ category: 'Meus blocos' });
  });

  it('refuses an empty update, a blank name and an unknown block', async () => {
    const block = await service.createBlock({ name: 'A', html: '<p/>' });
    await expect(service.updateBlock(block.id, {})).rejects.toThrow();
    await expect(service.updateBlock(block.id, { name: '  ' })).rejects.toThrow();
    await expect(service.updateBlock('nao-existe', { name: 'B' })).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});
