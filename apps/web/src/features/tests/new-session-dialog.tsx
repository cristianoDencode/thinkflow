import { useQueryClient } from '@tanstack/react-query';
import type { TestSessionDto } from '@thinkflow/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Switch } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys } from '../../lib/queries';

export function NewTestSessionDialog({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [startUrl, setStartUrl] = useState('https://');
  const [autoThumbnails, setAutoThumbnails] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await api.post<TestSessionDto>('/api/tests/sessions', {
        name: name.trim() || 'Sessão de teste',
        startUrl: startUrl.trim(),
        autoThumbnails,
      });
      await queryClient.invalidateQueries({ queryKey: keys.tests });
      onClose();
      navigate(`/tests/${session.id}`);
    } catch (err) {
      setError(errorMessage(err));
      notify.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Nova sessão de teste"
      description="Uma janela do navegador abre nessa URL. Ao iniciar você escolhe: gravar passos (cada ação vira um passo com print) ou só tirar prints."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Criar sessão
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Nome" htmlFor="test-name" hint="Ex.: Cadastro de contribuinte — demanda 1234">
          <Input
            id="test-name"
            value={name}
            maxLength={200}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="URL inicial" htmlFor="test-url" error={error}>
          <Input
            id="test-url"
            type="url"
            value={startUrl}
            onChange={(e) => setStartUrl(e.target.value)}
          />
        </Field>
        <div className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
          <div>
            <p className="text-sm font-medium">Print automático a cada passo</p>
            <p className="text-xs text-muted">
              Ao gravar passos, tira um print da tela depois de cada ação; você escolhe quais entram
              no documento.
            </p>
          </div>
          <Switch
            checked={autoThumbnails}
            onChange={setAutoThumbnails}
            label="Print automático a cada passo"
          />
        </div>
      </form>
    </Dialog>
  );
}
