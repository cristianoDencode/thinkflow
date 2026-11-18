import JSZip from 'jszip';
import type { TestSessionDto, TestStepImageDto } from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buttonFacts,
  fieldFacts,
  FakeRecorderBrowser,
  instantSettler,
} from '../testing/fake-recorder';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BASE = '/api/tests/sessions';

/** goto, fill, fill(secret), click — each with its automatic print; the print of step 2 is left out. */
async function recordedWithPrints() {
  const recorder = new FakeRecorderBrowser();
  t = await createTestApp({ tests: { recorder, settler: instantSettler } });
  const { json } = await t.api<TestSessionDto>('POST', BASE, {
    name: 'Login do sistema',
    startUrl: 'https://a.b/login',
  });
  const id = json.id;
  await t.api('POST', `${BASE}/${id}/record/start`);
  recorder.emit({ type: 'fill', facts: fieldFacts('E-mail'), value: 'ana@x.com', at: 1 });
  recorder.emit({
    type: 'fill',
    facts: fieldFacts('Senha', { secret: true, role: null }),
    value: 'segredo-123',
    at: 2,
  });
  recorder.emit({ type: 'click', facts: buttonFacts('Entrar'), at: 3 });
  await t.container.tests.recording.whenIdle();
  await t.api('POST', `${BASE}/${id}/record/stop`);
  const s = (await t.api<TestSessionDto>('GET', `${BASE}/${id}`)).json;
  const [, email, , click] = s.definition.steps;
  // automatic prints start out of the document: the person turns on what goes in (all but one here)
  for (const image of Object.values(s.images)) {
    await t.api('PATCH', `${BASE}/${id}/evidences/${image.id}`, {
      include: image.stepId !== email!.id,
    });
  }
  const last = s.images[click!.id]!;
  await t.api<TestStepImageDto>('PATCH', `${BASE}/${id}/evidences/${last.id}`, {
    comment: 'Painel aberto',
  });
  return { id, evidenceId: last.id };
}

const download = (url: string) =>
  t!.app.inject({ method: 'GET', url, headers: { cookie: t!.cookie } });

describe('evidence document', () => {
  it('renders HTML for the clipboard with embedded images and no secrets', async () => {
    const { id } = await recordedWithPrints();
    const res = await download(`${BASE}/${id}/document?format=html`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.body).toContain('<h1>Evidência de teste — Login do sistema</h1>');
    expect(res.body).toContain('Preencher campo &quot;Senha&quot; com &quot;••••••&quot;');
    expect(res.body).toContain('<i>Painel aberto</i>');
    // the prints set to be included are embedded (3 of 4: one was left out), all PNG
    expect(res.body.match(/src="data:image\/png;base64,/g)).toHaveLength(3);
    expect(res.body).toContain(
      '<td style="border:1px solid #cbd5e1;padding:4px 8px;text-align:left;vertical-align:top">Prints</td><td style="border:1px solid #cbd5e1;padding:4px 8px;text-align:left;vertical-align:top">3</td>',
    );
    expect(res.body).not.toContain('segredo-123');
  });

  it('copies markdown with data URIs, or downloads it with relative images', async () => {
    const { id } = await recordedWithPrints();
    const inline = await download(`${BASE}/${id}/document?format=md&inline=1`);
    expect(inline.headers['content-disposition']).toBeUndefined();
    expect(inline.body).toContain('](data:image/png;base64,');
    const file = await download(`${BASE}/${id}/document?format=md`);
    expect(file.headers['content-disposition']).toBe('attachment; filename="login-do-sistema.md"');
    expect(file.body).toContain('![Passo 1](imagens/passo-01.png)');
    expect(file.body).not.toContain('imagens/passo-02.png'); // left out
    expect(file.body).toContain('![Passo 4](imagens/passo-04.png)');
  });

  it('zips markdown, html and the images', async () => {
    const { id } = await recordedWithPrints();
    const res = await download(`${BASE}/${id}/document?format=zip`);
    expect(res.headers['content-type']).toBe('application/zip');
    const zip = await JSZip.loadAsync(res.rawPayload);
    expect(Object.keys(zip.files).sort()).toEqual([
      'imagens/',
      'imagens/passo-01.png',
      'imagens/passo-03.png',
      'imagens/passo-04.png',
      'login-do-sistema.html',
      'login-do-sistema.md',
    ]);
    const md = await zip.file('login-do-sistema.md')!.async('string');
    expect(md).toContain('*Painel aberto*');
    expect(md).not.toContain('segredo-123');
  });

  it('exports the Playwright spec with the secret from an environment variable', async () => {
    const { id } = await recordedWithPrints();
    const res = await download(`${BASE}/${id}/document?format=spec`);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="login-do-sistema.spec.ts"',
    );
    expect(res.body).toContain("import { expect, test } from '@playwright/test';");
    expect(res.body).toContain('senha: process.env.TF_SENHA');
    expect(res.body).not.toContain('segredo-123');
  });

  it('leaves out images that are gone from the storage', async () => {
    const { id, evidenceId } = await recordedWithPrints();
    await t!.store.delete(`tests/${id}/evidences/${evidenceId}/original.png`);
    const res = await download(`${BASE}/${id}/document?format=md`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('passo-04.png');
    expect(res.body).toContain('passo-03.png');
    expect((await download(`${BASE}/missing/document`)).statusCode).toBe(404);
    expect((await download(`${BASE}/${id}/document?format=pdf`)).statusCode).toBe(400);
  });
});
