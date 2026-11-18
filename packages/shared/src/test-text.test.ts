import { describe, expect, it } from 'vitest';
import { generatedStepTitle, stepTitle } from './test-text';
import { stepSchema, type TestDefinition, type TestStep } from './tests';

const def = { parameters: [], dataSets: [] } as unknown as TestDefinition;
const base = {
  id: 's1',
  at: 1,
  kind: 'goto',
  url: 'https://a.b/',
  comment: null,
} as const;

describe('stepTitle', () => {
  it('uses the generated title unless a custom one is set', () => {
    const plain = stepSchema.parse(base) as TestStep;
    expect(stepTitle(def, plain)).toBe('Abrir https://a.b/');
    const custom = stepSchema.parse({ ...base, title: '  Abrir o portal ' }) as TestStep;
    expect(stepTitle(def, custom)).toBe('Abrir o portal');
    expect(generatedStepTitle(def, custom)).toBe('Abrir https://a.b/');
    expect(stepTitle(def, stepSchema.parse({ ...base, title: null }) as TestStep)).toBe(
      'Abrir https://a.b/',
    );
  });
});
