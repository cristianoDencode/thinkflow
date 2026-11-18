import {
  ASSERTION_LABELS,
  STEP_KIND_LABELS,
  type TestDefinition,
  type TestStep,
  type TestStepValue,
} from './tests';

/** How a secret value shows up for people (screen, documents). */
export const SECRET_MASK = '••••••';

/** Value shown for people: the parameter's recorded value (secrets masked). */
export function valueText(def: TestDefinition, value: TestStepValue | undefined): string {
  if (!value) return '';
  if ('literal' in value) return value.literal;
  const param = def.parameters.find((p) => p.id === value.param);
  if (!param) return '';
  if (param.secret) return SECRET_MASK;
  const recorded = def.dataSets[0]?.values[param.id];
  return typeof recorded === 'string' ? recorded : '';
}

/** One line in pt-BR: "Preencher campo E-mail com ana@exemplo.com". */
export function stepTitle(def: TestDefinition, step: TestStep): string {
  return step.title?.trim() || generatedStepTitle(def, step);
}

/** The title built from the step itself, ignoring any custom title. */
export function generatedStepTitle(def: TestDefinition, step: TestStep): string {
  const target = step.target?.description ?? '';
  switch (step.kind) {
    case 'goto':
      return `Abrir ${step.url ?? ''}`;
    case 'fill':
      return `Preencher ${target} com "${valueText(def, step.value)}"`;
    case 'select':
      return `Selecionar "${valueText(def, step.value)}" em ${target}`;
    case 'press':
      return `Pressionar ${step.key ?? ''}${target ? ` em ${target}` : ''}`;
    case 'assert': {
      const a = step.assertion;
      if (!a) return 'Verificar';
      const label = ASSERTION_LABELS[a.type];
      if (a.type === 'visible') return `Verificar: ${target} visível`;
      if (a.type === 'value') return `Verificar: ${target} = "${valueText(def, a.value)}"`;
      return `Verificar: ${label.toLowerCase()} "${a.text}"`;
    }
    case 'note':
      return step.comment ?? 'Anotação';
    case 'usecase':
      return step.useCase?.title.trim() || STEP_KIND_LABELS.usecase;
    case 'checkpoint':
      return step.page?.title ? `Verificar: ${step.page.title}` : 'Verificar';
    case 'capture':
      return step.page?.title
        ? `${STEP_KIND_LABELS.capture}: ${step.page.title}`
        : STEP_KIND_LABELS.capture;
    default:
      return `${STEP_KIND_LABELS[step.kind]} ${target}`.trim();
  }
}
