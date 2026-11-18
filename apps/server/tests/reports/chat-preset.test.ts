import { describe, expect, it } from 'vitest';
import { templateSpecSchema } from '@thinkflow/shared';
import {
  GENERATE_TOOL_NAME,
  buildIntakeMessages,
  buildPresetSystemNote,
  generateToolParameters,
  normalizeGenerateArgs,
  parseGenerateDirective,
  parseIntakeAnswer,
  stripGenerateDirective,
} from '../../src/contexts/reports/domain/chat-preset';
import type { ReportTemplate } from '../../src/contexts/reports/domain/template';

const template: ReportTemplate = {
  id: 't1',
  name: 'Análise de função',
  kind: 'report',
  description: '',
  builtIn: false,
  builtInVersion: null,
  createdAt: 1,
  updatedAt: 1,
  spec: templateSpecSchema.parse({
    persona: 'Arquiteto',
    objective: 'Documentar a função {{funcao}} para {{publico}}.',
    audience: 'analistas',
    titlePattern: 'Guia: {{funcao}}',
    sections: [{ id: 'resumo', title: 'Resumo', requirements: 'Sobre {{funcao}}.' }],
    variables: [
      {
        name: 'funcao',
        label: 'Função PL/pgSQL',
        description: 'Nome da função',
        required: true,
        example: 'fc_calcula',
      },
      { name: 'publico', label: 'Público', defaultValue: 'analistas' },
    ],
    intakeQuestions: ['Qual o foco da análise?'],
  }),
};

describe('buildPresetSystemNote', () => {
  const note = buildPresetSystemNote(template);

  it('describes the mode, the variables and the interview rules in pt-BR', () => {
    expect(note).toContain('Modo de documento: «Relatório» com o modelo «Análise de função»');
    expect(note).toContain('ENTREVISTA');
    expect(note).toContain('{{funcao}} — Função PL/pgSQL (obrigatório)');
    expect(note).toContain('Ex.: fc_calcula');
    expect(note).toContain('{{publico}} — Público (opcional)');
    expect(note).toContain('Se não informado, usa «analistas»');
    expect(note).toContain('Qual o foco da análise?');
    expect(note).toContain('no máximo 3 itens por vez');
    expect(note).toContain(`chame a ferramenta ${GENERATE_TOOL_NAME}`);
    expect(note).toContain('<gerar_documento>');
  });
});

describe('generateToolParameters', () => {
  it('exposes one string property per variable and requires the ones without default', () => {
    const params = generateToolParameters(template) as {
      properties: { variaveis: { properties: Record<string, unknown>; required: string[] } };
      required: string[];
    };
    expect(Object.keys(params.properties.variaveis.properties)).toEqual(['funcao', 'publico']);
    expect(params.properties.variaveis.required).toEqual(['funcao']);
    expect(params.required).toEqual(['variaveis']);
  });
});

describe('normalizeGenerateArgs', () => {
  it('keeps trimmed string values and accepts English aliases', () => {
    expect(
      normalizeGenerateArgs({
        variaveis: { funcao: '  fc_calcula ', n: 3, ok: true, obj: { a: 1 } },
        escopo: ' juros ',
        titulo: ' ',
      }),
    ).toEqual({
      variables: { funcao: 'fc_calcula', n: '3', ok: 'true' },
      brief: 'juros',
      title: null,
    });
    expect(normalizeGenerateArgs({ variables: { a: 'b' }, scope: 'x', title: 'T' })).toEqual({
      variables: { a: 'b' },
      brief: 'x',
      title: 'T',
    });
  });

  it('survives garbage', () => {
    for (const raw of [null, 'x', 42, [], { variaveis: 'oops' }])
      expect(normalizeGenerateArgs(raw)).toEqual({ variables: {}, brief: '', title: null });
  });
});

describe('text-tag fallback', () => {
  const tag = '<gerar_documento>{"variaveis":{"funcao":"fc_x"},"escopo":"juros"}</gerar_documento>';

  it('parses a tag between prose and strips it', () => {
    const parsed = parseGenerateDirective(`Certo!\n\n${tag}\n\nIniciando.`)!;
    expect(parsed.args).toEqual({ variables: { funcao: 'fc_x' }, brief: 'juros', title: null });
    expect(parsed.stripped).toBe('Certo!\n\nIniciando.');
  });

  it('tolerates fenced JSON and a tag cut off by the token limit', () => {
    expect(
      parseGenerateDirective(
        '<gerar_documento>```json\n{"variaveis":{"a":"b"}}\n```</gerar_documento>',
      )!.args?.variables,
    ).toEqual({ a: 'b' });
    const cut = parseGenerateDirective('Ok <gerar_documento>{"variaveis":{"a":"b"},"escopo":"x')!;
    expect(cut.args?.variables).toEqual({ a: 'b' });
    expect(cut.stripped).toBe('Ok');
  });

  it('returns null args for an unreadable tag and null when there is no tag', () => {
    expect(parseGenerateDirective('<gerar_documento>nada</gerar_documento>')).toMatchObject({
      args: null,
      stripped: '',
    });
    expect(parseGenerateDirective('sem tag')).toBeNull();
    expect(stripGenerateDirective('a <gerar_documento>{"x":1}')).toBe('a');
  });
});

describe('intake', () => {
  it('builds messages that forbid inventing values and parses the answer', () => {
    const [system, user] = buildIntakeMessages(
      template,
      '<contexto_anterior>x</contexto_anterior>',
    );
    expect(system!.content).toContain('Nunca invente');
    expect(user!.content).toContain('- funcao: Função PL/pgSQL (obrigatório)');
    expect(user!.content).toContain('<contexto_anterior>');
    expect(parseIntakeAnswer('```json\n{"variaveis":{"funcao":"fc_x"},"escopo":"s"}\n```')).toEqual(
      {
        variables: { funcao: 'fc_x' },
        brief: 's',
        title: null,
      },
    );
    expect(parseIntakeAnswer('não sei')).toBeNull();
  });
});
