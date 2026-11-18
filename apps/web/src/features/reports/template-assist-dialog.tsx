import {
  TEMPLATE_KIND_LABELS,
  TEMPLATE_KINDS,
  TEMPLATE_LIMITS,
  type TemplateAssistRequest,
  type TemplateAssistResultDto,
  type TemplateKind,
} from '@thinkflow/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { useModelOptions } from '../../lib/queries';
import type { TemplateDraft } from './template-draft';

export type AssistMode = 'import' | 'interview';

interface Answered {
  question: string;
  answer: string;
}

function ModelAndKind({
  model,
  onModel,
  kind,
  onKind,
}: {
  model: string;
  onModel(value: string): void;
  kind: TemplateKind;
  onKind(value: TemplateKind): void;
}) {
  const { data: models = [] } = useModelOptions();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Tipo de documento" htmlFor="assist-kind">
        <Select
          id="assist-kind"
          value={kind}
          onChange={(e) => onKind(e.target.value as TemplateKind)}
        >
          {TEMPLATE_KINDS.map((k) => (
            <option key={k} value={k}>
              {TEMPLATE_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Modelo de IA" htmlFor="assist-model">
        <Select id="assist-model" value={model} onChange={(e) => onModel(e.target.value)}>
          {models.length === 0 && <option value="">Nenhum modelo disponível</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

/** "Importar de prompt" and "Criar com IA": both end in the editor, pre-filled with a draft. */
export function TemplateAssistDialog({ mode, onClose }: { mode: AssistMode; onClose(): void }) {
  const navigate = useNavigate();
  const { data: models = [] } = useModelOptions();
  const [chosenModel, setChosenModel] = useState('');
  const model = chosenModel || models[0]?.id || '';
  const [kind, setKind] = useState<TemplateKind>('report');
  const [text, setText] = useState('');
  const [goal, setGoal] = useState('');
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [history, setHistory] = useState<Answered[]>([]);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);

  const finish = (result: Extract<TemplateAssistResultDto, { kind: 'draft' }>) => {
    result.warnings.forEach((w) => notify.warning(w));
    onClose();
    navigate('/reports/templates/new', { state: { draft: result.draft satisfies TemplateDraft } });
  };

  const run = async (body: TemplateAssistRequest, nextRound = 0) => {
    setBusy(true);
    try {
      const result = await api.post<TemplateAssistResultDto>('/api/report-templates/assist', body);
      if (result.kind === 'draft') return finish(result);
      setQuestions(result.questions);
      setAnswers(result.questions.map(() => ''));
      setRound(nextRound);
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitImport = () => void run({ mode: 'import', model, text, kind });
  const startInterview = () => void run({ mode: 'interview', model, goal, kind });
  const continueInterview = () => {
    const all = [
      ...history,
      ...questions.map((question, i) => ({ question, answer: answers[i] ?? '' })),
    ];
    setHistory(all);
    void run({ mode: 'interview', model, goal, kind, answers: all, round: round + 1 }, round + 1);
  };

  if (mode === 'import') {
    const tooLong = text.length > TEMPLATE_LIMITS.maxImportChars;
    return (
      <Dialog
        open
        size="lg"
        onClose={onClose}
        title="Importar de prompt"
        description="Cole o prompt que você usa hoje. A IA identifica as seções, a pesquisa e as variáveis e abre o editor para você revisar."
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              loading={busy}
              disabled={text.trim().length < 20 || tooLong || !model}
              onClick={submitImport}
            >
              Importar
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field
            label="Prompt"
            htmlFor="assist-text"
            error={tooLong ? `Máximo de ${TEMPLATE_LIMITS.maxImportChars} caracteres` : null}
            hint={`${text.length} de ${TEMPLATE_LIMITS.maxImportChars} caracteres`}
          >
            <Textarea
              id="assist-text"
              rows={12}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Cole aqui o prompt completo…"
            />
          </Field>
          <ModelAndKind model={model} onModel={setChosenModel} kind={kind} onKind={setKind} />
          <p className="text-xs text-muted">
            O modelo não é salvo automaticamente: você revisa no editor e salva.
          </p>
        </div>
      </Dialog>
    );
  }

  const asking = questions.length > 0;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title="Criar modelo com IA"
      description={
        asking
          ? 'Responda às perguntas para a IA montar o modelo. Respostas em branco são aceitas.'
          : 'Descreva o que o modelo deve produzir. A IA fará algumas perguntas e montará um rascunho.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          {asking ? (
            <Button loading={busy} onClick={continueInterview}>
              Continuar
            </Button>
          ) : (
            <Button
              loading={busy}
              disabled={goal.trim().length < 3 || !model}
              onClick={startInterview}
            >
              Começar
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {asking ? (
          questions.map((question, i) => (
            <Field key={`${round}-${i}`} label={question} htmlFor={`assist-answer-${i}`}>
              <Input
                id={`assist-answer-${i}`}
                value={answers[i] ?? ''}
                onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
              />
            </Field>
          ))
        ) : (
          <>
            <Field label="Objetivo do modelo" htmlFor="assist-goal">
              <Textarea
                id="assist-goal"
                rows={4}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="Ex.: guia para analistas explicando como uma função do sistema calcula juros e multa"
              />
            </Field>
            <ModelAndKind model={model} onModel={setChosenModel} kind={kind} onKind={setKind} />
          </>
        )}
      </div>
    </Dialog>
  );
}
