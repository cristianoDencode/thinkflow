import { TEMPLATE_LIMITS, type TemplateVariable } from '@thinkflow/shared';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Field, Input, Switch, Textarea } from '../../components/ui/form';
import { newVariable } from './template-draft';

export function TemplateVariablesEditor({
  variables,
  undeclared,
  onChange,
  errors,
  readOnly,
}: {
  variables: TemplateVariable[];
  /** Placeholders used in the texts but not declared yet. */
  undeclared: string[];
  onChange(variables: TemplateVariable[]): void;
  errors: Record<string, string>;
  readOnly: boolean;
}) {
  const update = (index: number, patch: Partial<TemplateVariable>) =>
    onChange(variables.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  const full = variables.length >= TEMPLATE_LIMITS.maxVariables;

  return (
    <div className="flex flex-col gap-3">
      {variables.length === 0 && (
        <p className="text-sm text-muted">
          Sem variáveis. Use <code className="font-mono">{'{{nome}}'}</code> nos textos do modelo e
          declare a variável aqui para que ela seja perguntada ao gerar o relatório.
        </p>
      )}
      {variables.map((v, i) => (
        <div key={i} className="rounded-xl border border-border bg-surface p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field
              label="Nome da variável"
              htmlFor={`var-name-${i}`}
              error={errors[`spec.variables.${i}.name`]}
              hint="Usado como {{nome}}"
            >
              <Input
                id={`var-name-${i}`}
                aria-label={`Nome da variável ${i + 1}`}
                value={v.name}
                className="font-mono"
                onChange={(e) => update(i, { name: e.target.value })}
              />
            </Field>
            <Field
              label="Rótulo"
              htmlFor={`var-label-${i}`}
              error={errors[`spec.variables.${i}.label`]}
            >
              <Input
                id={`var-label-${i}`}
                aria-label={`Rótulo da variável ${i + 1}`}
                value={v.label}
                onChange={(e) => update(i, { label: e.target.value })}
              />
            </Field>
            <div className="flex items-center gap-2 pb-2">
              <Switch
                checked={v.required}
                onChange={(required) => update(i, { required })}
                label={`Variável ${i + 1} obrigatória`}
              />
              <span className="text-sm">Obrigatória</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remover variável ${i + 1}`}
                disabled={readOnly}
                onClick={() => onChange(variables.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Valor padrão" htmlFor={`var-default-${i}`}>
              <Input
                id={`var-default-${i}`}
                value={v.defaultValue}
                onChange={(e) => update(i, { defaultValue: e.target.value })}
              />
            </Field>
            <Field label="Exemplo" htmlFor={`var-example-${i}`}>
              <Input
                id={`var-example-${i}`}
                value={v.example}
                onChange={(e) => update(i, { example: e.target.value })}
              />
            </Field>
            <Field label="Descrição" htmlFor={`var-desc-${i}`} className="sm:col-span-2">
              <Textarea
                id={`var-desc-${i}`}
                rows={2}
                value={v.description}
                onChange={(e) => update(i, { description: e.target.value })}
              />
            </Field>
          </div>
        </div>
      ))}
      {errors['spec.variables'] && (
        <p role="alert" className="text-xs text-danger">
          {errors['spec.variables']}
        </p>
      )}
      {undeclared.length > 0 && (
        <div className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
          <p>
            Variáveis usadas nos textos, mas ainda não declaradas:{' '}
            {undeclared.map((n) => (
              <code key={n} className="mr-1 font-mono">{`{{${n}}}`}</code>
            ))}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={
              readOnly || variables.length + undeclared.length > TEMPLATE_LIMITS.maxVariables
            }
            onClick={() => onChange([...variables, ...undeclared.map((n) => newVariable(n))])}
          >
            Declarar automaticamente
          </Button>
        </div>
      )}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={readOnly || full}
        onClick={() => onChange([...variables, newVariable()])}
      >
        <Plus className="h-4 w-4" /> Adicionar variável
      </Button>
    </div>
  );
}
