import { describe, expect, it } from 'vitest';
import {
  emptyDraft,
  newSection,
  nextSectionId,
  undeclaredVariables,
  validateDraft,
} from './template-draft';

describe('template draft helpers', () => {
  it('starts with one valid-looking section', () => {
    const d = emptyDraft('prd');
    expect(d.kind).toBe('prd');
    expect(d.spec.sections).toHaveLength(1);
    expect(d.spec.layout.theme).toBe('thinkflow');
  });

  it('generates unique section ids', () => {
    expect(nextSectionId([{ id: 'secao-1' }, { id: 'secao-3' }])).toBe('secao-2');
    expect(newSection([{ id: 'secao-1' }]).id).toBe('secao-2');
  });

  it('finds undeclared placeholders', () => {
    const d = emptyDraft();
    d.spec.persona = 'Fala de {{x}} e {{y}}';
    d.spec.variables = [
      { name: 'x', label: 'X', description: '', required: false, example: '', defaultValue: '' },
    ];
    expect(undeclaredVariables(d.spec)).toEqual(['y']);
  });

  it('validates with field-level errors keyed by path', () => {
    const d = emptyDraft();
    d.spec.sections = [{ ...d.spec.sections[0]!, title: '' }];
    const result = validateDraft(d);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors['name']).toBe('Informe o nome do modelo');
    expect(result.errors['spec.sections.0.title']).toBe('Informe o título da seção');
    expect(result.messages).toContain('Informe o nome do modelo');
  });

  it('accepts a complete draft', () => {
    const d = emptyDraft();
    d.name = 'Ok';
    expect(validateDraft(d).ok).toBe(true);
  });
});
