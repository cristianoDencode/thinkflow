import type {
  ReportTemplateDto,
  ReportTemplateSummaryDto,
  TemplateInputPayload,
} from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES } from '../../src/contexts/reports/domain/builtin-templates';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp;
afterEach(async () => t?.close());

const draft = (over: Partial<TemplateInputPayload> = {}): TemplateInputPayload => ({
  name: 'Meu modelo',
  kind: 'report',
  description: 'Descrição',
  spec: {
    persona: 'Analista',
    titlePattern: 'Relatório de {{tema}}',
    sections: [
      { id: 's1', title: 'Resumo', requirements: 'Resuma {{tema}}' },
      { id: 's2', title: 'Fluxo', diagram: 'required' },
    ],
    variables: [{ name: 'tema', label: 'Tema', required: true }],
  },
  ...over,
});

describe('report templates API', () => {
  it('requires a session', async () => {
    t = await createTestApp();
    for (const [method, url] of [
      ['GET', '/api/report-templates'],
      ['POST', '/api/report-templates'],
      ['GET', '/api/report-templates/x'],
      ['PUT', '/api/report-templates/x'],
      ['DELETE', '/api/report-templates/x'],
      ['POST', '/api/report-templates/x/duplicate'],
    ] as const) {
      const res = await t.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('seeds the built-in templates at boot and filters by kind', async () => {
    t = await createTestApp();
    const all = await t.api<ReportTemplateSummaryDto[]>('GET', '/api/report-templates');
    expect(all.status).toBe(200);
    expect(all.json.map((x) => x.id).sort()).toEqual(BUILTIN_TEMPLATES.map((x) => x.id).sort());
    expect(all.json.every((x) => x.builtIn)).toBe(true);
    expect(all.json.find((x) => x.id === 'builtin-ecidade-fc-calcula')).toMatchObject({
      kind: 'report',
      sectionCount: 12,
      variableCount: 1,
      usesMcp: true,
    });

    const prd = await t.api<ReportTemplateSummaryDto[]>('GET', '/api/report-templates?kind=prd');
    expect(prd.json.map((x) => x.name)).toEqual(['PRD de funcionalidade']);
    expect((await t.api('GET', '/api/report-templates?kind=nope')).status).toBe(400);

    const full = await t.api<ReportTemplateDto>(
      'GET',
      '/api/report-templates/builtin-ecidade-fc-calcula',
    );
    expect(full.json.spec.sections).toHaveLength(12);
    expect(full.json.spec.variables[0]).toMatchObject({
      name: 'funcao',
      defaultValue: 'fc_calcula',
    });
  });

  it('creates, reads, updates and deletes a template', async () => {
    t = await createTestApp();
    const created = await t.api<ReportTemplateDto>('POST', '/api/report-templates', draft());
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: 'Meu modelo', kind: 'report', builtIn: false });
    expect(created.json.spec.layout.theme).toBe('thinkflow');
    const id = created.json.id;

    const read = await t.api<ReportTemplateDto>('GET', `/api/report-templates/${id}`);
    expect(read.json.spec.sections.map((s) => s.id)).toEqual(['s1', 's2']);

    const updated = await t.api<ReportTemplateDto>(
      'PUT',
      `/api/report-templates/${id}`,
      draft({ name: 'Renomeado', kind: 'summary' }),
    );
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ id, name: 'Renomeado', kind: 'summary' });

    expect((await t.api('DELETE', `/api/report-templates/${id}`)).status).toBe(200);
    expect((await t.api('GET', `/api/report-templates/${id}`)).status).toBe(404);
    expect((await t.api('DELETE', `/api/report-templates/${id}`)).status).toBe(404);
    expect((await t.api('PUT', `/api/report-templates/${id}`, draft())).status).toBe(404);
  });

  it('keeps built-in templates read-only', async () => {
    t = await createTestApp();
    const put = await t.api<{ error: { code: string } }>(
      'PUT',
      '/api/report-templates/builtin-prd',
      draft({ name: 'Outro' }),
    );
    expect(put.status).toBe(400);
    expect(put.json.error.code).toBe('builtin_template');
    const del = await t.api<{ error: { code: string } }>(
      'DELETE',
      '/api/report-templates/builtin-prd',
    );
    expect(del.status).toBe(400);
    expect(del.json.error.code).toBe('builtin_template');
    expect((await t.api('GET', '/api/report-templates/builtin-prd')).status).toBe(200);
  });

  it('rejects a duplicate (kind, name) with 409 but allows the same name in another kind', async () => {
    t = await createTestApp();
    expect((await t.api('POST', '/api/report-templates', draft())).status).toBe(201);
    expect((await t.api('POST', '/api/report-templates', draft())).status).toBe(409);
    expect((await t.api('POST', '/api/report-templates', draft({ kind: 'prd' }))).status).toBe(201);
    // taking a built-in's name is a conflict too
    const clash = await t.api(
      'POST',
      '/api/report-templates',
      draft({ name: 'PRD de funcionalidade', kind: 'prd' }),
    );
    expect(clash.status).toBe(409);

    const other = await t.api<ReportTemplateDto>(
      'POST',
      '/api/report-templates',
      draft({ name: 'B' }),
    );
    const rename = await t.api(
      'PUT',
      `/api/report-templates/${other.json.id}`,
      draft({ name: 'Meu modelo' }),
    );
    expect(rename.status).toBe(409);
    // saving a template under its own name is fine
    expect(
      (await t.api('PUT', `/api/report-templates/${other.json.id}`, draft({ name: 'B' }))).status,
    ).toBe(200);
  });

  it('validates the spec: undeclared variables, duplicate ids, empty sections, bad colors/logo', async () => {
    t = await createTestApp();
    const post = (body: unknown) =>
      t.api<{ error: { message: string } }>('POST', '/api/report-templates', body);

    const undeclared = await post(
      draft({
        spec: { sections: [{ id: 'a', title: 'A', requirements: 'Use {{nao_declarada}}' }] },
      }),
    );
    expect(undeclared.status).toBe(400);
    expect(undeclared.json.error.message).toContain('{{nao_declarada}}');
    expect(undeclared.json.error.message).toContain('variables');

    const dupIds = await post(
      draft({
        spec: {
          sections: [
            { id: 'a', title: 'A' },
            { id: 'a', title: 'B' },
          ],
        },
      }),
    );
    expect(dupIds.status).toBe(400);

    expect((await post(draft({ spec: { sections: [] } }))).status).toBe(400);
    expect((await post(draft({ name: '   ' }))).status).toBe(400);
    expect((await post(draft({ kind: 'nope' as never }))).status).toBe(400);
    expect(
      (
        await post(
          draft({ spec: { sections: [{ id: 'a', title: 'A' }], layout: { primaryColor: 'red' } } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          draft({
            spec: {
              sections: [{ id: 'a', title: 'A' }],
              layout: { logo: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
            },
          }),
        )
      ).status,
    ).toBe(400);
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(
      (
        await post(
          draft({
            name: 'Com logo',
            spec: { sections: [{ id: 'a', title: 'A' }], layout: { logo: png } },
          }),
        )
      ).status,
    ).toBe(201);
  });

  it('duplicates a built-in into an editable copy, deduplicating the name', async () => {
    t = await createTestApp();
    const first = await t.api<ReportTemplateDto>(
      'POST',
      '/api/report-templates/builtin-prd/duplicate',
    );
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({
      name: 'PRD de funcionalidade (cópia)',
      kind: 'prd',
      builtIn: false,
      builtInVersion: null,
    });
    expect(first.json.id).not.toBe('builtin-prd');
    const second = await t.api<ReportTemplateDto>(
      'POST',
      '/api/report-templates/builtin-prd/duplicate',
    );
    expect(second.json.name).toBe('PRD de funcionalidade (cópia 2)');
    const third = await t.api<ReportTemplateDto>(
      'POST',
      `/api/report-templates/${first.json.id}/duplicate`,
    );
    expect(third.json.name).toBe('PRD de funcionalidade (cópia 3)');

    // the copy is editable
    const edited = await t.api<ReportTemplateDto>(
      'PUT',
      `/api/report-templates/${first.json.id}`,
      draft({ name: 'PRD editado', kind: 'prd' }),
    );
    expect(edited.status).toBe(200);
    expect((await t.api('POST', '/api/report-templates/nope/duplicate')).status).toBe(404);
  });
});
