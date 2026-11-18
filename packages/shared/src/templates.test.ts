import { describe, expect, it } from 'vitest';
import {
  placeholdersIn,
  templateInputSchema,
  templateSpecSchema,
  templateVariableSchema,
  type TemplateSpecInput,
} from './templates';

const minimal = (over: Partial<TemplateSpecInput> = {}): TemplateSpecInput => ({
  sections: [{ id: 's1', title: 'Resumo' }],
  ...over,
});

const issues = (input: unknown) => {
  const r = templateSpecSchema.safeParse(input);
  return r.success ? [] : r.error.issues;
};

describe('templateSpecSchema', () => {
  it('fills defaults from a minimal spec', () => {
    const spec = templateSpecSchema.parse(minimal());
    expect(spec.research).toMatchObject({
      useMcp: false,
      mcpServers: [],
      useLibrary: true,
      maxSteps: 6,
    });
    expect(spec.layout).toMatchObject({
      theme: 'thinkflow',
      cover: true,
      toc: true,
      pageSize: 'A4',
      sectionPageBreak: false,
      logo: null,
    });
    expect(spec.sections[0]).toMatchObject({ diagram: 'none', table: 'none', maxWords: null });
    expect(spec.variables).toEqual([]);
  });

  it('requires at least one and at most 30 sections', () => {
    expect(issues(minimal({ sections: [] })).length).toBeGreaterThan(0);
    const many = Array.from({ length: 31 }, (_, i) => ({ id: `s${i}`, title: `S${i}` }));
    expect(issues(minimal({ sections: many })).length).toBeGreaterThan(0);
  });

  it('flags a placeholder that is used but not declared (path: variables)', () => {
    const found = issues(
      minimal({ sections: [{ id: 'a', title: 'A', requirements: 'veja {{x}} e {{ y }}' }] }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toEqual(['variables']);
    expect(found[0]!.message).toContain('{{x}}');
    expect(found[0]!.message).toContain('{{y}}');
  });

  it('checks placeholders in every text field', () => {
    const fields: TemplateSpecInput[] = [
      minimal({ persona: '{{a}}' }),
      minimal({ objective: '{{a}}' }),
      minimal({ audience: '{{a}}' }),
      minimal({ titlePattern: '{{a}}' }),
      minimal({ research: { directives: ['{{a}}'] } }),
      minimal({ style: { tone: '{{a}}' } }),
      minimal({ style: { rules: ['{{a}}'] } }),
      minimal({ intakeQuestions: ['{{a}}'] }),
      minimal({ layout: { footerText: '{{a}}' } }),
    ];
    for (const f of fields) expect(issues(f), JSON.stringify(f)).toHaveLength(1);
    expect(
      issues(minimal({ persona: '{{a}}', variables: [{ name: 'a', label: 'A' }] })),
    ).toHaveLength(0);
  });

  it('rejects duplicate variable names and section ids', () => {
    const dupVar = issues(
      minimal({
        variables: [
          { name: 'a', label: 'A' },
          { name: 'a', label: 'B' },
        ],
      }),
    );
    expect(dupVar[0]!.path).toEqual(['variables', 1, 'name']);
    const dupSection = issues(
      minimal({
        sections: [
          { id: 'a', title: 'A' },
          { id: 'a', title: 'B' },
        ],
      }),
    );
    expect(dupSection[0]!.path).toEqual(['sections', 1, 'id']);
  });

  it('validates layout colors and logos', () => {
    expect(issues(minimal({ layout: { primaryColor: '#12345' } }))).not.toHaveLength(0);
    expect(issues(minimal({ layout: { accentColor: '#AbC123' } }))).toHaveLength(0);
    expect(
      issues(minimal({ layout: { logo: 'data:image/png;base64,iVBORw0KGgo=' } })),
    ).toHaveLength(0);
    expect(issues(minimal({ layout: { logo: 'data:image/jpeg;base64,/9j/4AAQ' } }))).toHaveLength(
      0,
    );
    expect(
      issues(minimal({ layout: { logo: 'data:image/svg+xml;base64,PHN2Zz4=' } })),
    ).not.toHaveLength(0);
    expect(issues(minimal({ layout: { logo: 'https://x.test/logo.png' } }))).not.toHaveLength(0);
    const huge = `data:image/png;base64,${'A'.repeat(300_000)}`;
    expect(issues(minimal({ layout: { logo: huge } }))).not.toHaveLength(0);
  });

  it('limits variables, directives and word counts', () => {
    const vars = Array.from({ length: 21 }, (_, i) => ({ name: `v${i}`, label: 'V' }));
    expect(issues(minimal({ variables: vars })).length).toBeGreaterThan(0);
    const directives = Array.from({ length: 31 }, () => 'x');
    expect(issues(minimal({ research: { directives } })).length).toBeGreaterThan(0);
    expect(
      issues(minimal({ sections: [{ id: 'a', title: 'A', maxWords: 10 }] })).length,
    ).toBeGreaterThan(0);
  });
});

describe('templateVariableSchema', () => {
  it('accepts identifiers only', () => {
    const ok = (name: string) => templateVariableSchema.safeParse({ name, label: 'L' }).success;
    expect(ok('funcao')).toBe(true);
    expect(ok('_x1')).toBe(true);
    expect(ok('1x')).toBe(false);
    expect(ok('a-b')).toBe(false);
    expect(ok('a'.repeat(41))).toBe(false);
  });
});

describe('templateInputSchema', () => {
  it('trims the name and defaults the description', () => {
    const input = templateInputSchema.parse({ name: '  Meu  ', kind: 'prd', spec: minimal() });
    expect(input).toMatchObject({ name: 'Meu', description: '', kind: 'prd' });
    expect(templateInputSchema.safeParse({ name: '', kind: 'prd', spec: minimal() }).success).toBe(
      false,
    );
    expect(
      templateInputSchema.safeParse({ name: 'x', kind: 'nope', spec: minimal() }).success,
    ).toBe(false);
  });
});

describe('placeholdersIn', () => {
  it('returns unique names', () => {
    expect(placeholdersIn('{{a}} {{ b }} {{a}} {x} {{9}}')).toEqual(['a', 'b']);
  });
});
