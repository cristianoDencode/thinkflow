import { describe, expect, it } from 'vitest';
import { splitUseCases, stepHasCtContent, useCaseDisplayTitle } from './ct';
import { stepSchema, type TestStep } from './tests';

const step = (id: string, comment: string | null = null): TestStep =>
  stepSchema.parse({ id, at: 1, kind: 'note', comment: comment ?? 'x' });
const plain = (id: string): TestStep =>
  stepSchema.parse({ id, at: 1, kind: 'goto', url: 'https://a.b/', target: null });
const divider = (id: string, title = '', status = 'Finalizado'): TestStep =>
  stepSchema.parse({ id, at: 1, kind: 'usecase', useCase: { title, status } });

describe('splitUseCases', () => {
  it('puts everything in an implicit first use case when there is no divider', () => {
    const segments = splitUseCases([plain('a'), plain('b')], () => false);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ stepId: null, status: 'Finalizado' });
    expect(segments[0]!.steps.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('has no use case without steps', () => {
    expect(splitUseCases([], () => false)).toEqual([]);
  });

  it('starts a use case at each divider and keeps its title and status', () => {
    const segments = splitUseCases(
      [plain('a'), divider('d1', 'Cálculo', 'Reprovado'), plain('b'), divider('d2'), plain('c')],
      () => true,
    );
    expect(segments.map((s) => [s.stepId, s.title, s.status, s.steps.map((x) => x.id)])).toEqual([
      [null, '', 'Finalizado', ['a']],
      ['d1', 'Cálculo', 'Reprovado', ['b']],
      ['d2', '', 'Finalizado', ['c']],
    ]);
  });

  it('drops an implicit first use case that reaches the document with nothing', () => {
    const steps = [plain('a'), plain('b'), divider('d1'), plain('c')];
    expect(splitUseCases(steps, () => false).map((s) => s.stepId)).toEqual(['d1']);
    expect(splitUseCases(steps, (s) => s.id === 'b').map((s) => s.stepId)).toEqual([null, 'd1']);
  });

  it('keeps an explicit divider with no steps and uses the stored first use case info', () => {
    const segments = splitUseCases([divider('d1')], () => false);
    expect(segments).toHaveLength(1);
    const first = splitUseCases([plain('a')], () => false, { title: 'Início', status: 'Pendente' });
    expect(first[0]).toMatchObject({ title: 'Início', status: 'Pendente' });
  });

  it('titles default to "Caso de Uso N"', () => {
    expect(useCaseDisplayTitle({ title: '' }, 1)).toBe('Caso de Uso 2');
    expect(useCaseDisplayTitle({ title: ' Cálculo ' }, 1)).toBe('Cálculo');
  });
});

describe('stepHasCtContent', () => {
  it('needs a comment or an included print', () => {
    expect(stepHasCtContent(plain('a'), undefined)).toBe(false);
    expect(stepHasCtContent(plain('a'), { include: false })).toBe(false);
    expect(stepHasCtContent(plain('a'), { include: true })).toBe(true);
    expect(stepHasCtContent(step('n', 'texto'), undefined)).toBe(true);
    expect(stepHasCtContent(divider('d'), { include: true })).toBe(false);
  });
});
