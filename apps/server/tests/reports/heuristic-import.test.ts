import { templateInputSchema } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import { extractJsonObject } from '../../src/contexts/reports/domain/json-extract';
import {
  coerceTemplateDraft,
  heuristicTemplateFromPrompt,
} from '../../src/contexts/reports/domain/template-import';
import { ECIDADE_PROMPT } from './ecidade-prompt';

describe('extractJsonObject', () => {
  it('reads plain, fenced and prose-wrapped JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('Claro!\n```json\n{"a": [1, 2]}\n```\nPronto.')).toEqual({
      a: [1, 2],
    });
    expect(extractJsonObject('Aqui: {"a":{"b":"}"}} fim')).toEqual({ a: { b: '}' } });
  });

  it('repairs trailing commas, comments and smart quotes', () => {
    expect(extractJsonObject('{"a": 1, "b": [1,2,],}')).toEqual({ a: 1, b: [1, 2] });
    expect(extractJsonObject('{\n// nota\n"a": 1\n}')).toEqual({ a: 1 });
    expect(extractJsonObject('{“a”: 1}')).toEqual({ a: 1 });
  });

  it('closes a truncated answer', () => {
    expect(extractJsonObject('{"a": {"b": ["x", "y')).toEqual({ a: { b: ['x', 'y'] } });
    expect(extractJsonObject('{"a": 1, "b": 2,')).toEqual({ a: 1, b: 2 });
  });

  it('returns null when there is no object', () => {
    expect(extractJsonObject('sem json')).toBeNull();
    expect(extractJsonObject('[1,2]')).toBeNull();
    expect(extractJsonObject('{"a": nope}')).toBeNull();
  });
});

describe('coerceTemplateDraft', () => {
  it('fills ids, slugs variables, declares used placeholders and clamps', () => {
    const result = coerceTemplateDraft({
      name: 'X'.repeat(300),
      kind: 'bogus',
      spec: {
        titlePattern: 'Guia de {{funcao}} no {{sistema}}',
        sections: [
          'Resumo',
          { title: 'Resumo', diagram: true, table: 'optional', maxWords: 3 },
          {},
        ],
        variables: [{ name: 'Função Principal!', required: true }, 'funcao', 'funcao'],
        research: { maxSteps: 99, directives: 'a\nb' },
        extra: 'ignored',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { draft } = result;
    expect(draft.name).toHaveLength(120);
    expect(draft.kind).toBe('report');
    expect(draft.spec.sections.map((s) => s.id)).toEqual(['resumo', 'resumo-2']);
    expect(draft.spec.sections[1]).toMatchObject({
      diagram: 'required',
      table: 'optional',
      maxWords: null,
    });
    expect(draft.spec.variables.map((v) => v.name)).toEqual([
      'Funcao_Principal',
      'funcao',
      'sistema',
    ]);
    expect(draft.spec.research).toMatchObject({ maxSteps: 20, directives: ['a', 'b'] });
    expect(templateInputSchema.safeParse(draft).success).toBe(true);
  });

  it('rejects an answer with no sections', () => {
    expect(coerceTemplateDraft({ spec: { persona: 'x' } }).ok).toBe(false);
    expect(coerceTemplateDraft('texto').ok).toBe(false);
  });
});

describe('heuristicTemplateFromPrompt (e-Cidade fc_calcula prompt)', () => {
  const draft = heuristicTemplateFromPrompt(ECIDADE_PROMPT);

  it('detects the 12 numbered sections, ignoring the nested list', () => {
    expect(draft.spec.sections.map((s) => s.title)).toEqual([
      'Resumo',
      'Entradas e saídas',
      'Fluxo',
      'Passo a passo',
      'Fórmulas',
      'Exemplo numérico',
      'Funções auxiliares',
      'Tabelas, campos e menus',
      'Gravação e códigos de retorno',
      'Quem chama',
      'Pontos de atenção e roteiro de validação',
      'Glossário e limites',
    ]);
    expect(draft.spec.sections[2]).toMatchObject({ id: 'fluxo', diagram: 'required' });
    expect(draft.spec.sections[0]!.table).toBe('required');
    expect(draft.spec.sections[11]!.requirements).not.toContain('Regras');
  });

  it('extracts persona, audience, directives, rules, tone and MCP use', () => {
    expect(draft.spec.persona).toMatch(/^Você é um Arquiteto de Sistemas Especialista no e-Cidade/);
    expect(draft.spec.audience).toMatch(/analistas de sistemas e de negócio/);
    expect(draft.spec.research.useMcp).toBe(true);
    expect(draft.spec.research.directives).toHaveLength(5);
    expect(draft.spec.style.rules).toHaveLength(3);
    expect(draft.spec.style.tone).toMatch(/^analítico e direto/i);
  });

  it('promotes the repeated function name to a variable', () => {
    expect(draft.spec.variables).toEqual([
      expect.objectContaining({ name: 'funcao', required: true, defaultValue: 'fc_calcula' }),
    ]);
    expect(draft.spec.titlePattern).toContain('({{funcao}})');
    expect(JSON.stringify({ ...draft.spec, variables: [] })).not.toContain('fc_calcula');
    expect(draft.spec.sections[1]!.requirements).not.toContain('fc_calcula');
    expect(templateInputSchema.safeParse(draft).success).toBe(true);
  });

  it('keeps existing {{placeholders}} as variables and does not promote identifiers', () => {
    const d = heuristicTemplateFromPrompt(
      'Escreva sobre {{tema}} usando foo_bar, foo_bar e foo_bar.\n\n1. Introdução\nTexto\n\n2. Conclusão\nFim',
    );
    expect(d.spec.variables.map((v) => v.name)).toEqual(['tema']);
    expect(d.spec.sections.map((s) => s.title)).toEqual(['Introdução', 'Conclusão']);
  });

  it('falls back to markdown headings, then to a single section', () => {
    const byHeading = heuristicTemplateFromPrompt(
      '# Meu guia\n\n## Contexto\nA\n\n## Riscos\nB',
      'prd',
    );
    expect(byHeading).toMatchObject({ name: 'Meu guia', kind: 'prd' });
    expect(byHeading.spec.sections.map((s) => s.title)).toEqual(['Contexto', 'Riscos']);
    const single = heuristicTemplateFromPrompt('Apenas um texto qualquer sem estrutura nenhuma.');
    expect(single.spec.sections).toHaveLength(1);
    expect(templateInputSchema.safeParse(single).success).toBe(true);
  });
});
