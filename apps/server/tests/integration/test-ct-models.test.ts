import JSZip from 'jszip';
import {
  CT_DEFAULT_MODEL_ID,
  type CtLayoutAssistResultDto,
  type CtModelDto,
  type CtStateDto,
  type TestSessionDto,
} from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { PdfOptions, PdfRenderer } from '../../src/contexts/reports/domain/render-ports';
import { fakeFetch, openAIFrames, sseResponse } from '../helpers';
import { customLayout } from '../testing/ct/ct-fixtures';
import { createTestApp, type TestApp } from './test-app';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BASE = '/api/tests/sessions';
const MODELS = '/api/tests/ct-models';
const GROQ = 'https://api.groq.com/openai/v1/chat/completions';

class FakePdf implements PdfRenderer {
  calls: { html: string; options: PdfOptions }[] = [];
  async status() {
    return { available: true } as never;
  }
  async pdf(html: string, options: PdfOptions) {
    this.calls.push({ html, options });
    return new TextEncoder().encode('%PDF-1.4 fake');
  }
}

async function setup(overrides: Parameters<typeof createTestApp>[0] = {}) {
  t = await createTestApp(overrides);
  const created = await t.api<TestSessionDto>('POST', BASE, {
    name: 'Cálculo da taxa',
    startUrl: 'https://a.b/login',
  });
  return created.json.id;
}

const get = (url: string) => t!.app.inject({ method: 'GET', url, headers: { cookie: t!.cookie } });
const input = (name: string, layout = customLayout()) => ({ name, layout });

describe('CT models: CRUD', () => {
  it('requires a session', async () => {
    await setup();
    expect((await t!.app.inject({ method: 'GET', url: MODELS })).statusCode).toBe(401);
  });

  it('lists the read-only "Padrão" first, then creates, updates, reads and deletes', async () => {
    await setup();
    const first = (await t!.api<CtModelDto[]>('GET', MODELS)).json;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: CT_DEFAULT_MODEL_ID, name: 'Padrão', builtIn: true });
    expect(first[0]!.layout.logo).toBeNull();

    const created = await t!.api<CtModelDto>('POST', MODELS, input('Acme'));
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: 'Acme', builtIn: false });
    expect(created.json.layout.primaryColor).toBe('#AA1122');
    const id = created.json.id;

    const list = (await t!.api<CtModelDto[]>('GET', MODELS)).json;
    expect(list.map((m) => m.name)).toEqual(['Padrão', 'Acme']);

    const updated = await t!.api<CtModelDto>(
      'PUT',
      `${MODELS}/${id}`,
      input('Acme 2', customLayout({ primaryColor: '#00AA00' })),
    );
    expect(updated.json).toMatchObject({ name: 'Acme 2' });
    expect(updated.json.layout.primaryColor).toBe('#00AA00');
    expect((await t!.api<CtModelDto>('GET', `${MODELS}/${id}`)).json.name).toBe('Acme 2');

    expect((await t!.api('DELETE', `${MODELS}/${id}`)).status).toBe(200);
    expect((await t!.api('GET', `${MODELS}/${id}`)).status).toBe(404);
    expect((await t!.api('DELETE', `${MODELS}/${id}`)).status).toBe(404);
  });

  it('protects the default, rejects invalid layouts and duplicate names', async () => {
    await setup();
    expect((await t!.api('PUT', `${MODELS}/default`, input('x'))).status).toBe(403);
    expect((await t!.api('DELETE', `${MODELS}/default`)).status).toBe(403);
    expect((await t!.api('GET', `${MODELS}/default`)).status).toBe(200);

    expect((await t!.api('POST', MODELS, input('Padrão'))).status).toBe(409);
    expect((await t!.api('POST', MODELS, input('Um'))).status).toBe(201);
    expect((await t!.api('POST', MODELS, input(' um '))).status).toBe(409);

    expect(
      (await t!.api('POST', MODELS, { name: 'Ruim', layout: { primaryColor: 'vermelho' } })).status,
    ).toBe(400);
    expect(
      (
        await t!.api('POST', MODELS, {
          name: 'Logo',
          layout: { logo: 'data:image/svg+xml;base64,AAAA' },
        })
      ).status,
    ).toBe(400);
    const huge = `data:image/png;base64,${'A'.repeat(300_000)}`;
    expect((await t!.api('POST', MODELS, { name: 'Grande', layout: { logo: huge } })).status).toBe(
      400,
    );
    expect((await t!.api('POST', MODELS, { name: '', layout: {} })).status).toBe(400);
  });

  it('previews a sample document with an unsaved look', async () => {
    await setup();
    const res = await t!.api<{ html: string }>('POST', `${MODELS}/preview`, {
      layout: customLayout(),
    });
    expect(res.status).toBe(200);
    expect(res.json.html).toContain('Relatório de Teste Acme');
    expect(res.json.html).toContain('#AA1122');
    expect(res.json.html).toContain('Exemplo de documento');
    expect(
      (await t!.api('POST', `${MODELS}/preview`, { layout: { fontFamily: 'x' } })).status,
    ).toBe(400);
  });
});

describe('CT models: a session uses its model', () => {
  it('defaults to "Padrão", then renders preview, .docx and PDF with the chosen model', async () => {
    const pdf = new FakePdf();
    const id = await setup({ reports: { pdfRenderer: pdf } });
    const state = (await t!.api<CtStateDto>('GET', `${BASE}/${id}/ct`)).json;
    expect(state.modelId).toBe(CT_DEFAULT_MODEL_ID);

    const model = (await t!.api<CtModelDto>('POST', MODELS, input('Acme'))).json;
    const chosen = await t!.api<CtStateDto>('PUT', `${BASE}/${id}/ct/model`, {
      modelId: model.id,
    });
    expect(chosen.json.modelId).toBe(model.id);

    const preview = await get(`${BASE}/${id}/ct/preview`);
    expect(preview.body).toContain('Relatório de Teste Acme');
    expect(preview.body).toContain('#AA1122');

    const docx = await get(`${BASE}/${id}/ct/docx`);
    const zip = await JSZip.loadAsync(docx.rawPayload);
    expect(Object.keys(zip.files).filter((n) => n.startsWith('word/media/'))).toHaveLength(1);
    const header = Object.keys(zip.files).find((n) => /^word\/header\d*\.xml$/.test(n))!;
    expect(await zip.file(header)!.async('string')).toContain('Acme Corp - Controle de Qualidade');

    await get(`${BASE}/${id}/ct/pdf`);
    expect(pdf.calls[0]!.options.headerTemplate).toContain('Acme Corp - Controle de Qualidade');
    expect(pdf.calls[0]!.options.footerTemplate).toContain('Uso restrito da Acme');

    // saving the form keeps the chosen model
    const fields = chosen.json.fields;
    const saved = await t!.api<CtStateDto>('PUT', `${BASE}/${id}/ct`, {
      ...fields,
      title: 'Outro título',
    });
    expect(saved.json.modelId).toBe(model.id);
  });

  it('falls back to the default model when the chosen one is deleted; refuses unknown ids', async () => {
    const id = await setup();
    const model = (await t!.api<CtModelDto>('POST', MODELS, input('Acme'))).json;
    await t!.api('PUT', `${BASE}/${id}/ct/model`, { modelId: model.id });
    expect((await t!.api('PUT', `${BASE}/${id}/ct/model`, { modelId: 'nao-existe' })).status).toBe(
      404,
    );
    await t!.api('DELETE', `${MODELS}/${model.id}`);

    const state = (await t!.api<CtStateDto>('GET', `${BASE}/${id}/ct`)).json;
    expect(state.modelId).toBe(CT_DEFAULT_MODEL_ID);
    const preview = await get(`${BASE}/${id}/ct/preview`);
    expect(preview.body).not.toContain('Acme Corp');
    expect(preview.body).toContain('<h1 class="title">Caso de Teste</h1>');
    expect((await get(`${BASE}/${id}/ct/docx`)).statusCode).toBe(200);
  });
});

describe('CT models: "Criar com IA"', () => {
  const answer = {
    name: 'Verde sóbrio',
    explanation: 'Verde com serifa.',
    layout: { primaryColor: '#1b5e20', accentColor: '#2e7d32', fontFamily: 'Georgia', logo: 'x' },
  };

  async function withAi(replies: string[]) {
    const bodies: unknown[] = [];
    const fetch = fakeFetch([
      {
        match: (url, body) => {
          if (url !== GROQ) return false;
          bodies.push(body);
          return true;
        },
        respond: () =>
          sseResponse(openAIFrames(replies[Math.min(bodies.length, replies.length) - 1]!)),
      },
    ]);
    await setup({ fetchFn: fetch.fn });
    await t!.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
    return bodies;
  }

  it('returns a validated draft and saves nothing', async () => {
    await withAi([JSON.stringify(answer)]);
    const res = await t!.api<CtLayoutAssistResultDto>('POST', `${MODELS}/assist`, {
      prompt: 'verde sóbrio com fonte serifada',
      model: 'groq/llama',
    });
    expect(res.status).toBe(200);
    expect(res.json.name).toBe('Verde sóbrio');
    expect(res.json.layout).toMatchObject({ fontFamily: 'Georgia', logo: null });
    expect((await t!.api<CtModelDto[]>('GET', MODELS)).json).toHaveLength(1);
  });

  it('keeps the logo of the layout being refined and validates the request', async () => {
    await withAi([JSON.stringify(answer)]);
    const base = customLayout();
    const res = await t!.api<CtLayoutAssistResultDto>('POST', `${MODELS}/assist`, {
      prompt: 'troque as cores',
      layout: base,
      model: 'groq/llama',
    });
    expect(res.json.layout.logo).toBe(base.logo);
    expect((await t!.api('POST', `${MODELS}/assist`, { prompt: '' })).status).toBe(400);
  });

  it('answers a friendly 502 when the model never returns a usable layout', async () => {
    await withAi(['desculpe, não consigo']);
    const res = await t!.api<{ error: { message: string } }>('POST', `${MODELS}/assist`, {
      prompt: 'verde',
      model: 'groq/llama',
    });
    expect(res.status).toBe(502);
    expect(res.json.error.message).toContain('não devolveu um modelo');
  });
});
