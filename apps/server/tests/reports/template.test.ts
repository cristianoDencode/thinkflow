import { placeholdersIn, templateInputSchema, templateSpecSchema } from '@thinkflow/shared';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATES,
  ECIDADE_FC_CALCULA_ID,
} from '../../src/contexts/reports/domain/builtin-templates';
import {
  copyName,
  missingVariables,
  referencedVariables,
  renderTemplateText,
  resolveTitle,
  resolveVariables,
  templateSummary,
  type ReportTemplate,
} from '../../src/contexts/reports/domain/template';

const spec = templateSpecSchema.parse({
  titlePattern: 'Guia ({{funcao}}) - {{autor}}',
  sections: [{ id: 's1', title: 'Resumo de {{funcao}}' }],
  variables: [
    { name: 'funcao', label: 'Função', required: true, defaultValue: 'fc_calcula' },
    { name: 'autor', label: 'Autor' },
    { name: 'obrigatoria', label: 'Obrigatória', required: true },
  ],
});

describe('renderTemplateText', () => {
  it('replaces known placeholders and keeps unknown ones', () => {
    expect(renderTemplateText('A {{x}} e {{ y }} e {{z}}', { x: '1', y: '2' })).toBe(
      'A 1 e 2 e {{z}}',
    );
  });
  it('replaces with an empty string when the value is empty', () => {
    expect(renderTemplateText('[{{x}}]', { x: '' })).toBe('[]');
  });
  it('does not treat object prototype names as variables', () => {
    expect(renderTemplateText('{{toString}}', {})).toBe('{{toString}}');
  });
});

describe('variables', () => {
  it('lists referenced variables in order of appearance', () => {
    expect(referencedVariables(spec)).toEqual(['funcao', 'autor']);
  });
  it('applies defaults and trims', () => {
    expect(resolveVariables(spec, { funcao: '  ', autor: ' Ana ' })).toEqual({
      funcao: 'fc_calcula',
      autor: 'Ana',
      obrigatoria: '',
    });
  });
  it('reports required variables without value or default', () => {
    expect(missingVariables(spec, {})).toEqual(['obrigatoria']);
    expect(missingVariables(spec, { obrigatoria: 'x' })).toEqual([]);
  });
  it('resolves the title, falling back to the template name', () => {
    expect(resolveTitle(spec, { funcao: 'fc_x', autor: 'Ana' }, 'Modelo')).toBe(
      'Guia (fc_x) - Ana',
    );
    const bare = templateSpecSchema.parse({ sections: [{ id: 'a', title: 'A' }] });
    expect(resolveTitle(bare, {}, 'Modelo')).toBe('Modelo');
  });
});

describe('copyName', () => {
  it('adds and increments the copy suffix', () => {
    const taken = new Set(['Modelo (cópia)']);
    expect(copyName('Modelo', (n) => taken.has(n))).toBe('Modelo (cópia 2)');
    expect(copyName('Modelo (cópia)', (n) => taken.has(n))).toBe('Modelo (cópia 2)');
    expect(copyName('Outro', (n) => taken.has(n))).toBe('Outro (cópia)');
  });
  it('keeps names within 120 characters', () => {
    expect(copyName('x'.repeat(120), () => false).length).toBeLessThanOrEqual(120);
  });
});

describe('built-in templates', () => {
  it('has unique ids and (kind, name) pairs', () => {
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size).toBe(BUILTIN_TEMPLATES.length);
    expect(new Set(BUILTIN_TEMPLATES.map((t) => `${t.kind}/${t.name}`)).size).toBe(
      BUILTIN_TEMPLATES.length,
    );
  });
  it('covers the four kinds', () => {
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.kind))).toEqual(
      new Set(['report', 'summary', 'prd', 'prototype']),
    );
  });
  it.each(BUILTIN_TEMPLATES.map((t) => [t.name, t] as const))(
    '%s parses with the schema',
    (_n, t) => {
      expect(
        templateInputSchema.safeParse({
          name: t.name,
          kind: t.kind,
          description: t.description,
          spec: t.spec,
        }).success,
      ).toBe(true);
      // round trip through JSON, as the repository does
      expect(templateSpecSchema.parse(JSON.parse(JSON.stringify(t.spec)))).toEqual(t.spec);
    },
  );
  it('declares every variable its texts use', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const declared = new Set(t.spec.variables.map((v) => v.name));
      for (const name of referencedVariables(t.spec))
        expect(declared.has(name), `${t.id}:${name}`).toBe(true);
    }
  });
  it('has the e-Cidade acceptance example', () => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === ECIDADE_FC_CALCULA_ID)!;
    expect(t.kind).toBe('report');
    expect(t.spec.sections).toHaveLength(12);
    expect(t.spec.sections[2]).toMatchObject({ title: 'Fluxo', diagram: 'required' });
    expect(t.spec.variables).toEqual([
      expect.objectContaining({ name: 'funcao', required: true, defaultValue: 'fc_calcula' }),
    ]);
    expect(t.spec.research.useMcp).toBe(true);
    expect(t.spec.persona).toContain('Arquiteto de Sistemas Especialista no e-Cidade');
    expect(resolveTitle(t.spec, resolveVariables(t.spec, {}), t.name)).toBe(
      'Guia do Analista: como o sistema calcula correção, juros, multa e desconto de um débito (fc_calcula)',
    );
    expect(t.spec.style.rules.join(' ')).toContain('Itens não resolvidos');
  });
  it('has the generic technical-analysis report with 8 sections', () => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === 'builtin-report-tecnico')!;
    expect(t.spec.sections.map((s) => s.title)).toEqual([
      'Resumo executivo',
      'Contexto e escopo',
      'Como funciona',
      'Detalhamento',
      'Dados, tabelas e integrações',
      'Riscos e pontos de atenção',
      'Recomendações e próximos passos',
      'Itens não resolvidos e limites',
    ]);
    expect(missingVariables(t.spec, {})).toEqual(['assunto']);
  });
  it('requires a diagram in the PRD flow and in the prototype navigation map', () => {
    const prd = BUILTIN_TEMPLATES.find((x) => x.id === 'builtin-prd')!;
    const proto = BUILTIN_TEMPLATES.find((x) => x.id === 'builtin-prototype')!;
    expect(prd.spec.sections.find((s) => s.title === 'Fluxo do usuário')?.diagram).toBe('required');
    expect(proto.spec.sections.find((s) => s.title === 'Mapa de navegação')?.diagram).toBe(
      'required',
    );
  });
});

describe('templateSummary', () => {
  it('summarizes a template for listings', () => {
    const t = BUILTIN_TEMPLATES[0]!;
    const full: ReportTemplate = {
      ...t,
      builtIn: true,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(templateSummary(full)).toMatchObject({
      id: t.id,
      builtIn: true,
      sectionCount: 8,
      variableCount: 2,
      usesMcp: true,
      theme: 'thinkflow',
    });
  });
});

describe('placeholdersIn', () => {
  it('finds names once', () => {
    expect(placeholdersIn('{{a}} {{b}} {{a}} {{1x}}')).toEqual(['a', 'b']);
  });
});
