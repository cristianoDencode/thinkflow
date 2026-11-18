import {
  CT_PRIORITY_SUGGESTIONS,
  CT_USE_CASE_STATUS_SUGGESTIONS,
  type CtFieldsDto,
} from '@thinkflow/shared';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Field, Input, Textarea } from '../../components/ui/form';
import { newVersionRow, type CtForm } from './ct-state';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

/** Left side of the Documento tab: header, análise, use-case statuses and the version table. */
export function CtFormFields({
  form,
  onChange,
  disabled,
}: {
  form: CtForm;
  onChange(next: CtForm): void;
  disabled: boolean;
}) {
  const { fields, useCases } = form;
  const setField = <K extends keyof CtFieldsDto>(key: K, value: CtFieldsDto[K]) =>
    onChange({ ...form, fields: { ...fields, [key]: value } });
  const setVersion = (index: number, patch: Partial<CtFieldsDto['versions'][number]>) =>
    setField(
      'versions',
      fields.versions.map((v, i) => (i === index ? { ...v, ...patch } : v)),
    );

  return (
    <div className="flex flex-col gap-4">
      <Section title="1. Cabeçalho">
        <Field label="Título" htmlFor="ct-title">
          <Input
            id="ct-title"
            value={fields.title}
            maxLength={300}
            disabled={disabled}
            onChange={(e) => setField('title', e.target.value)}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="ID/Código do Chamado" htmlFor="ct-ticket">
            <Input
              id="ct-ticket"
              value={fields.ticketId}
              maxLength={300}
              disabled={disabled}
              onChange={(e) => setField('ticketId', e.target.value)}
            />
          </Field>
          <Field label="Prioridade" htmlFor="ct-priority">
            <Input
              id="ct-priority"
              list="ct-priority-options"
              value={fields.priority}
              maxLength={300}
              disabled={disabled}
              onChange={(e) => setField('priority', e.target.value)}
            />
            <datalist id="ct-priority-options">
              {CT_PRIORITY_SUGGESTIONS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field
          label="Sistema / Módulo Afetado"
          htmlFor="ct-module"
          hint="Uma linha por sistema/módulo."
        >
          <Textarea
            id="ct-module"
            rows={2}
            value={fields.systemModule}
            maxLength={900}
            disabled={disabled}
            onChange={(e) => setField('systemModule', e.target.value)}
          />
        </Field>
        <Field label="Responsável pela Documentação" htmlFor="ct-author">
          <Input
            id="ct-author"
            value={fields.author}
            maxLength={300}
            disabled={disabled}
            onChange={(e) => setField('author', e.target.value)}
          />
        </Field>
      </Section>

      <Section title="2. Análise">
        <Field
          label="Título da seção"
          htmlFor="ct-analysis"
          hint="Ex.: Análise, Descrição da Demanda."
        >
          <Input
            id="ct-analysis"
            value={fields.analysisTitle}
            maxLength={300}
            disabled={disabled}
            onChange={(e) => setField('analysisTitle', e.target.value)}
          />
        </Field>
        <Field label="2.1. Contexto" htmlFor="ct-context">
          <Textarea
            id="ct-context"
            rows={6}
            value={fields.context}
            maxLength={20000}
            disabled={disabled}
            onChange={(e) => setField('context', e.target.value)}
          />
        </Field>
      </Section>

      <Section title="3. Plano de Teste: casos de uso">
        {useCases.length === 0 ? (
          <p className="text-sm text-muted">
            Nenhum caso de uso ainda: os passos (comentários e prints) da aba Passos viram os casos
            de uso do documento.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted">
              Os casos de uso vêm dos passos. Para dividir, reordenar ou remover, use a aba Passos.
            </p>
            <ul className="flex flex-col gap-2">
              {useCases.map((uc, i) => (
                <li key={uc.stepId ?? 'first'} className="grid gap-2 sm:grid-cols-[1fr_9rem]">
                  <Input
                    aria-label={`Título do caso de uso ${i + 1}`}
                    value={uc.title}
                    placeholder={uc.defaultTitle}
                    maxLength={300}
                    disabled={disabled}
                    onChange={(e) =>
                      onChange({
                        ...form,
                        useCases: useCases.map((x, j) =>
                          j === i ? { ...x, title: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label={`Status do caso de uso ${i + 1}`}
                    list="ct-status-options"
                    value={uc.status}
                    maxLength={300}
                    disabled={disabled}
                    onChange={(e) =>
                      onChange({
                        ...form,
                        useCases: useCases.map((x, j) =>
                          j === i ? { ...x, status: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </li>
              ))}
            </ul>
            <datalist id="ct-status-options">
              {CT_USE_CASE_STATUS_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </>
        )}
      </Section>

      <Section title="Controle de versões do documento">
        <ul className="flex flex-col gap-3">
          {fields.versions.map((v, i) => (
            <li
              key={i}
              className="grid grid-cols-[5rem_7rem_1fr_auto] items-start gap-2 max-sm:grid-cols-2"
            >
              <Input
                aria-label={`Versão da linha ${i + 1}`}
                value={v.version}
                maxLength={300}
                disabled={disabled}
                onChange={(e) => setVersion(i, { version: e.target.value })}
              />
              <Input
                aria-label={`Data da linha ${i + 1}`}
                value={v.date}
                maxLength={300}
                disabled={disabled}
                onChange={(e) => setVersion(i, { date: e.target.value })}
              />
              <Input
                aria-label={`Descrição da linha ${i + 1}`}
                value={v.description}
                placeholder="Descrição da alteração"
                maxLength={300}
                disabled={disabled}
                onChange={(e) => setVersion(i, { description: e.target.value })}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remover versão da linha ${i + 1}`}
                disabled={disabled || fields.versions.length <= 1}
                onClick={() =>
                  setField(
                    'versions',
                    fields.versions.filter((_, j) => j !== i),
                  )
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <Input
                aria-label={`Responsável da linha ${i + 1}`}
                className="col-span-full"
                value={v.author}
                placeholder="Responsável"
                maxLength={300}
                disabled={disabled}
                onChange={(e) => setVersion(i, { author: e.target.value })}
              />
            </li>
          ))}
        </ul>
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => setField('versions', [...fields.versions, newVersionRow(fields)])}
          >
            <Plus className="h-4 w-4" /> Adicionar versão
          </Button>
        </div>
      </Section>
    </div>
  );
}
