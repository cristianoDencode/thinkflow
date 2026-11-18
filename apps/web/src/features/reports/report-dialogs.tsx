import { useQueryClient } from '@tanstack/react-query';
import type { ReportDetailDto, ReportSectionDto } from '@thinkflow/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Select, Textarea } from '../../components/ui/form';
import { api, ApiError, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys, useLibraries, useModelOptions } from '../../lib/queries';

export function RegenerateSectionDialog({
  report,
  section,
  onClose,
}: {
  report: ReportDetailDto;
  section: ReportSectionDto;
  onClose(): void;
}) {
  const queryClient = useQueryClient();
  const { data: models = [] } = useModelOptions();
  const [instructions, setInstructions] = useState('');
  const [modelChoice, setModelChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const model = modelChoice || report.model;
  const options = models.some((m) => m.id === model)
    ? models
    : [...models, { id: model, label: model, kind: 'model' as const }];

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/api/reports/${report.id}/sections/${section.ordinal}/regenerate`, {
        instructions,
        model,
      });
      await queryClient.invalidateQueries({ queryKey: keys.reports });
      notify.info('Reescrevendo a seção…');
      onClose();
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Regenerar “${section.title}”`}
      description="Só esta seção é reescrita; o restante do documento é mantido."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Regenerar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Instruções (opcional)" htmlFor="rg-instructions">
          <Textarea
            id="rg-instructions"
            rows={4}
            maxLength={2000}
            value={instructions}
            placeholder="Ex.: seja mais objetivo e inclua uma tabela comparativa"
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>
        <Field label="Modelo de IA" htmlFor="rg-model">
          <Select id="rg-model" value={model} onChange={(e) => setModelChoice(e.target.value)}>
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

export function AddToLibraryDialog({
  report,
  onClose,
}: {
  report: ReportDetailDto;
  onClose(): void;
}) {
  const queryClient = useQueryClient();
  const { data: libraries = [], isLoading } = useLibraries();
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const libraryId = choice || libraries[0]?.id || '';

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/api/reports/${report.id}/library`, { libraryId });
      await queryClient.invalidateQueries({ queryKey: keys.reports });
      await queryClient.invalidateQueries({ queryKey: keys.libraries });
      notify.success('Relatório adicionado à Biblioteca');
      setAdded(libraryId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) notify.warning(err.message);
      else notify.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Adicionar à Biblioteca"
      description="O Markdown do relatório vira um documento da biblioteca escolhida, pronto para ser consultado no chat."
      footer={
        added ? (
          <>
            <Link to={`/library/${added}`} onClick={onClose}>
              <Button variant="outline" tabIndex={-1}>
                Abrir biblioteca
              </Button>
            </Link>
            <Button onClick={onClose}>Fechar</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button loading={busy} disabled={!libraryId} onClick={() => void submit()}>
              Adicionar
            </Button>
          </>
        )
      }
    >
      {added ? (
        <p role="status" className="text-sm">
          Documento adicionado. Ele será processado pela biblioteca em instantes.
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted">Carregando bibliotecas…</p>
      ) : libraries.length === 0 ? (
        <p className="text-sm text-muted">
          Você ainda não tem bibliotecas.{' '}
          <Link to="/library" className="text-accent-text underline" onClick={onClose}>
            Crie uma na Biblioteca
          </Link>
          .
        </p>
      ) : (
        <Field label="Biblioteca" htmlFor="lib-choice">
          <Select id="lib-choice" value={libraryId} onChange={(e) => setChoice(e.target.value)}>
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </Dialog>
  );
}
