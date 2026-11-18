import type { TemplateAssistResultDto } from '@thinkflow/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { HEURISTIC_WARNING } from '../../src/contexts/reports/application/template-assistant';
import { fakeFetch, openAIFrames, sseResponse } from '../helpers';
import { ECIDADE_PROMPT } from '../reports/ecidade-prompt';
import { createTestApp, type TestApp } from './test-app';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';

type Body = { messages: { role: string; content: string }[] };

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** `replies` are consumed in order; the last one repeats. */
async function setup(replies: string[]) {
  const bodies: Body[] = [];
  const fetch = fakeFetch([
    {
      match: (url, body) => {
        if (url !== GROQ) return false;
        bodies.push(body as unknown as Body);
        return true;
      },
      respond: () =>
        sseResponse(openAIFrames(replies[Math.min(bodies.length, replies.length) - 1]!)),
    },
  ]);
  t = await createTestApp({ fetchFn: fetch.fn });
  await t.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
  return { app: t, bodies };
}

const importBody = { mode: 'import', model: 'groq/llama', text: ECIDADE_PROMPT };

const llmDraft = {
  name: 'Guia do Analista (e-Cidade)',
  kind: 'report',
  description: 'Importado',
  spec: {
    persona: 'Arquiteto de Sistemas Especialista no e-Cidade',
    titlePattern: 'Guia do Analista ({{funcao}})',
    research: { useMcp: true, directives: ['Obtenha o código de {{funcao}}'] },
    sections: [
      { title: 'Resumo', requirements: 'Resuma {{funcao}}', table: 'required' },
      { title: 'Fluxo', diagram: 'required' },
    ],
    variables: [{ name: 'funcao', label: 'Função', required: true, defaultValue: 'fc_calcula' }],
  },
};

describe('POST /api/report-templates/assist', () => {
  it('requires a session and validates the body', async () => {
    const { app } = await setup(['{}']);
    const anon = await app.app.inject({ method: 'POST', url: '/api/report-templates/assist' });
    expect(anon.statusCode).toBe(401);
    expect((await app.api('POST', '/api/report-templates/assist', { mode: 'import' })).status).toBe(
      400,
    );
    expect(
      (await app.api('POST', '/api/report-templates/assist', { ...importBody, text: 'curto' }))
        .status,
    ).toBe(400);
  });

  it('import: returns the model draft (fenced JSON) and records the usage source', async () => {
    const { app, bodies } = await setup([
      'Aqui está:\n```json\n' + JSON.stringify(llmDraft) + '\n```',
    ]);
    const res = await app.api<TemplateAssistResultDto>(
      'POST',
      '/api/report-templates/assist',
      importBody,
    );
    expect(res.status).toBe(200);
    expect(res.json.kind).toBe('draft');
    if (res.json.kind !== 'draft') return;
    expect(res.json.warnings).toEqual([]);
    expect(res.json.draft.spec.sections.map((s) => s.id)).toEqual(['resumo', 'fluxo']);
    expect(res.json.draft.spec.variables[0]).toMatchObject({ name: 'funcao', required: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.messages[1]!.content).toContain('fc_calcula');
    expect(bodies[0]!.messages[1]!.content).toContain('Seções detectadas (12)');
    // nothing was saved
    const list = await app.api<unknown[]>('GET', '/api/report-templates');
    expect(list.json).toHaveLength(5);
    const usage = await app.api('GET', '/api/usage');
    expect(JSON.stringify(usage.json)).toContain('template-assist');
  });

  it('import: retries once with the validation issues, then accepts the corrected JSON', async () => {
    const { app, bodies } = await setup([
      '{"name":"x","spec":{"sections":[]}}',
      JSON.stringify(llmDraft),
    ]);
    const res = await app.api<TemplateAssistResultDto>(
      'POST',
      '/api/report-templates/assist',
      importBody,
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.messages.at(-1)!.content).toContain('inválida');
    expect(res.json).toMatchObject({ kind: 'draft', warnings: [] });
  });

  it('import: invalid twice falls back to the structure detected in the text', async () => {
    const { app, bodies } = await setup(['isto não é json']);
    const res = await app.api<TemplateAssistResultDto>(
      'POST',
      '/api/report-templates/assist',
      importBody,
    );
    expect(res.status).toBe(200);
    expect(bodies).toHaveLength(2);
    if (res.json.kind !== 'draft') throw new Error('expected a draft');
    expect(res.json.warnings).toContain(HEURISTIC_WARNING);
    expect(res.json.draft.spec.sections).toHaveLength(12);
    expect(res.json.draft.spec.variables[0]).toMatchObject({ name: 'funcao' });
    expect(res.json.draft.spec.research.useMcp).toBe(true);
  });

  it('import: falls back when the provider fails', async () => {
    const fetch = fakeFetch([
      { match: (url) => url === GROQ, respond: () => new Response('boom', { status: 500 }) },
    ]);
    t = await createTestApp({ fetchFn: fetch.fn });
    await t.api('POST', '/api/connections', { providerId: 'groq', name: 'g', apiKey: 'k' });
    const res = await t.api<TemplateAssistResultDto>(
      'POST',
      '/api/report-templates/assist',
      importBody,
    );
    expect(res.status).toBe(200);
    if (res.json.kind !== 'draft') throw new Error('expected a draft');
    expect(res.json.draft.spec.sections).toHaveLength(12);
    expect(res.json.warnings.join(' ')).toContain('Falha ao consultar a IA');
    expect(res.json.warnings).toContain(HEURISTIC_WARNING);
  });

  it('interview: asks questions, then builds the draft from the answers', async () => {
    const { app, bodies } = await setup([
      '{"perguntas":["Quem lê?","Quais seções?"]}',
      JSON.stringify({ modelo: llmDraft }),
    ]);
    const first = await app.api<TemplateAssistResultDto>('POST', '/api/report-templates/assist', {
      mode: 'interview',
      model: 'groq/llama',
      goal: 'Guia de cálculo de débitos',
      kind: 'report',
    });
    expect(first.json).toEqual({ kind: 'questions', questions: ['Quem lê?', 'Quais seções?'] });

    const second = await app.api<TemplateAssistResultDto>('POST', '/api/report-templates/assist', {
      mode: 'interview',
      model: 'groq/llama',
      goal: 'Guia de cálculo de débitos',
      kind: 'report',
      round: 1,
      answers: [{ question: 'Quem lê?', answer: 'Analistas' }],
    });
    expect(second.json.kind).toBe('draft');
    expect(bodies[1]!.messages[1]!.content).toContain('R: Analistas');
  });

  it('interview: unusable question JSON gives the default questions; the draft is forced after 2 rounds', async () => {
    const { app, bodies } = await setup(['sem json', '{"perguntas":["mais uma?"]}']);
    const first = await app.api<TemplateAssistResultDto>('POST', '/api/report-templates/assist', {
      mode: 'interview',
      model: 'groq/llama',
      goal: 'Resumo de atas',
      kind: 'summary',
    });
    expect(first.json.kind).toBe('questions');
    if (first.json.kind === 'questions')
      expect(first.json.questions.length).toBeGreaterThanOrEqual(3);

    const forced = await app.api<TemplateAssistResultDto>('POST', '/api/report-templates/assist', {
      mode: 'interview',
      model: 'groq/llama',
      goal: 'Resumo de atas',
      kind: 'summary',
      round: 2,
      answers: [{ question: 'a?', answer: 'b' }],
    });
    // the model still asked questions, but after 2 rounds only a draft is acceptable
    expect(bodies[1]!.messages[0]!.content).not.toContain('perguntas novas');
    if (forced.json.kind !== 'draft') throw new Error('expected a draft');
    expect(forced.json.draft.kind).toBe('summary');
    expect(forced.json.warnings.join(' ')).toContain('modelo padrão');
  });
});
