import {
  PROTOTYPE_LIMITS,
  type PrototypeCaptureResultDto,
  type PrototypeDetailDto,
} from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const IMPORT = '/api/prototypes/import';
const HTML =
  '<body><label>Código</label><input value="123"><table><tr><th>Nº</th></tr><tr><td>2026/9</td></tr></table><div>Usuário 52998224725</div></body>';

const payload = (over: Record<string, unknown> = {}) => ({
  formatVersion: 1,
  name: 'Consulta de empenho',
  snapshot: { html: HTML, css: 'label{color:#111}', width: 1100, height: 650 },
  source: {
    url: 'https://erp.example/w/emp_consulta.php?e=1#x',
    title: 'Consulta',
    menuPath: 'Empenho > Consulta',
    system: 'ecidade',
  },
  ...over,
});

describe('POST /api/prototypes/import (mapper contract, formatVersion 1)', () => {
  it('requires a session', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'POST', url: IMPORT, payload: payload() });
    expect(res.statusCode).toBe(401);
  });

  it('treats the screen like an in-app capture: sanitized, scrubbed and annotated', async () => {
    t = await createTestApp();
    const res = await t.api<PrototypeCaptureResultDto>('POST', IMPORT, {
      ...payload(),
      snapshot: {
        html: HTML.replace('<body>', '<body onload="x()"><script>alert(1)</script>'),
        css: 'label{color:#111}',
        width: 1100,
        height: 650,
      },
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      name: 'Consulta de empenho',
      scrubbed: true,
      sessionId: null,
      width: 1100,
      height: 650,
      versionCount: 1,
      components: { field: 1, grid: 1 },
      source: { url: 'https://erp.example/w/emp_consulta.php', file: 'emp_consulta.php' },
      warnings: [],
    });
    const detail = await t.api<PrototypeDetailDto>('GET', `/api/prototypes/${res.json.id}`);
    expect(detail.json.html).not.toContain('<script');
    expect(detail.json.html).not.toContain('onload');
    expect(detail.json.html).not.toContain('123');
    expect(detail.json.html).toContain('Usuário 00000000000');
    expect(detail.json.html).toContain('data-ec="grid"');
    expect(detail.json.css).toBe('label{color:#111}');
    expect(detail.json.versions[0]!.note).toBe('Captura importada');
  });

  it('keepData keeps values and cells', async () => {
    t = await createTestApp();
    const res = await t.api<PrototypeCaptureResultDto>('POST', IMPORT, payload({ keepData: true }));
    expect(res.status).toBe(201);
    expect(res.json.scrubbed).toBe(false);
    const detail = await t.api<PrototypeDetailDto>('GET', `/api/prototypes/${res.json.id}`);
    expect(detail.json.html).toContain('value="123"');
    expect(detail.json.html).toContain('2026/9');
  });

  it('keeps markers the mapper already wrote', async () => {
    t = await createTestApp();
    const res = await t.api<PrototypeCaptureResultDto>(
      'POST',
      IMPORT,
      payload({
        snapshot: {
          html: '<body><div data-ec="message"><span data-ec-part="text">Atenção</span></div></body>',
          css: '',
          width: 800,
          height: 600,
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.json.components).toEqual({ message: 1 });
    const detail = await t.api<PrototypeDetailDto>('GET', `/api/prototypes/${res.json.id}`);
    expect(detail.json.html).toContain('data-ec="message"');
  });

  it('works for another system: generic heuristics, an explicit file name and a warning', async () => {
    t = await createTestApp();
    const res = await t.api<PrototypeCaptureResultDto>(
      'POST',
      IMPORT,
      payload({
        source: {
          url: 'https://hr.example/app/Employees.aspx',
          system: 'folha-x',
          file: 'Employees.aspx',
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.json.source).toMatchObject({ file: 'Employees.aspx' });
    expect(res.json.warnings).toEqual([expect.stringContaining('folha-x')]);
  });

  it('clamps tiny and huge sizes like a capture', async () => {
    t = await createTestApp();
    const res = await t.api<PrototypeCaptureResultDto>(
      'POST',
      IMPORT,
      payload({
        snapshot: { html: HTML, css: '', width: 50, height: PROTOTYPE_LIMITS.maxHeight * 2 },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.json.width).toBe(PROTOTYPE_LIMITS.minSize);
    expect(res.json.height).toBe(PROTOTYPE_LIMITS.maxHeight);
  });

  it('rejects an unsupported or missing formatVersion', async () => {
    t = await createTestApp();
    for (const body of [payload({ formatVersion: 2 }), payload({ formatVersion: undefined })]) {
      const res = await t.api<{ error: { code: string; message: string } }>('POST', IMPORT, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('validation_error');
      expect(res.json.error.message).toContain('formatVersion');
    }
  });

  it('rejects an invalid payload', async () => {
    t = await createTestApp();
    for (const body of [
      payload({ name: '   ' }),
      payload({ snapshot: { html: '', css: '', width: 800, height: 600 } }),
      payload({ snapshot: { html: HTML, css: '', width: 'x', height: 600 } }),
    ]) {
      expect((await t.api('POST', IMPORT, body)).status).toBe(400);
    }
  });

  it('refuses a snapshot over the size limit', async () => {
    t = await createTestApp();
    const big = `<body>${'a'.repeat(PROTOTYPE_LIMITS.maxSnapshotBytes + 10)}</body>`;
    const res = await t.api<{ error: { code: string } }>(
      'POST',
      IMPORT,
      payload({ snapshot: { html: big, css: '', width: 800, height: 600 } }),
    );
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('prototype_too_large');
  });
});
