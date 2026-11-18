import {
  ASSERTION_LABELS,
  type TestAssertion,
  type TestAssertionType,
  type TestDefinition,
  type TestStep,
} from '@thinkflow/shared';
import { Field, Input, Select } from '../../components/ui/form';

/** Types that make sense for the step (element checks need an element). */
export function assertionTypes(step: TestStep): TestAssertionType[] {
  const page: TestAssertionType[] = ['textVisible', 'urlContains', 'title'];
  return step.target ? ['visible', 'value', ...page] : page;
}

/** A sensible starting value when the type changes. */
export function convertAssertion(
  current: TestAssertion,
  type: TestAssertionType,
  def: TestDefinition,
): TestAssertion {
  const text = 'text' in current ? current.text : '';
  switch (type) {
    case 'visible':
      return { type };
    case 'value':
      return current.type === 'value'
        ? current
        : { type, value: def.parameters[0] ? { param: def.parameters[0].id } : { literal: text } };
    default:
      return { type, text: text || 'texto esperado' };
  }
}

export function AssertionFields({
  def,
  step,
  value,
  onChange,
  idPrefix,
}: {
  def: TestDefinition;
  step: TestStep;
  value: TestAssertion;
  onChange(next: TestAssertion): void;
  idPrefix: string;
}) {
  const types = assertionTypes(step);
  return (
    <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
      <Field label="Tipo de verificação" htmlFor={`${idPrefix}-type`}>
        <Select
          id={`${idPrefix}-type`}
          value={value.type}
          onChange={(e) =>
            onChange(convertAssertion(value, e.target.value as TestAssertionType, def))
          }
        >
          {types.map((t) => (
            <option key={t} value={t}>
              {ASSERTION_LABELS[t]}
            </option>
          ))}
        </Select>
      </Field>
      {'text' in value && (
        <Field label="Texto esperado" htmlFor={`${idPrefix}-text`}>
          <Input
            id={`${idPrefix}-text`}
            value={value.text}
            maxLength={1000}
            onChange={(e) => onChange({ ...value, text: e.target.value })}
          />
        </Field>
      )}
      {value.type === 'value' && (
        <Field label="Valor esperado" htmlFor={`${idPrefix}-value`}>
          <div className="flex gap-2">
            <Select
              id={`${idPrefix}-value`}
              aria-label="Origem do valor"
              className="w-48"
              value={'param' in value.value ? value.value.param : ''}
              onChange={(e) =>
                onChange({
                  type: 'value',
                  value: e.target.value ? { param: e.target.value } : { literal: '' },
                })
              }
            >
              <option value="">Valor fixo</option>
              {def.parameters.map((p) => (
                <option key={p.id} value={p.id}>
                  Dado: {p.label}
                </option>
              ))}
            </Select>
            {'literal' in value.value && (
              <Input
                aria-label="Valor fixo esperado"
                value={value.value.literal}
                maxLength={10000}
                onChange={(e) => onChange({ type: 'value', value: { literal: e.target.value } })}
              />
            )}
          </div>
        </Field>
      )}
    </div>
  );
}
