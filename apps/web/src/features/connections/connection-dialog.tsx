import { notify } from '../../lib/notify';
import { useQueryClient } from '@tanstack/react-query';
import type { ConnectionDto, ProviderDto } from '@thinkflow/shared';
import { ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Field, Input, Select, Switch } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { keys } from '../../lib/queries';

export function ConnectionDialog({
  open,
  onClose,
  providers,
  editing,
}: {
  open: boolean;
  onClose(): void;
  providers: ProviderDto[];
  editing: ConnectionDto | null;
}) {
  const queryClient = useQueryClient();
  const [providerId, setProviderId] = useState('');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [priority, setPriority] = useState(10);
  const [enabled, setEnabled] = useState(true);
  const [defaultModel, setDefaultModel] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset the form only when the dialog opens (not on background refetches).
  useEffect(() => {
    if (!open) return;
    setProviderId(editing?.providerId ?? '');
    setName(editing?.name ?? '');
    setApiKey('');
    setBaseUrl(editing?.baseUrl ?? '');
    setPriority(editing?.priority ?? 10);
    setEnabled(editing?.enabled ?? true);
    setDefaultModel(editing?.defaultModel ?? '');
  }, [open, editing]);

  useEffect(() => {
    if (open && !providerId && providers[0]) setProviderId(providers[0].id);
  }, [open, providerId, providers]);

  const provider = useMemo(
    () => providers.find((p) => p.id === providerId),
    [providers, providerId],
  );

  const submit = async () => {
    setSaving(true);
    try {
      const body = {
        name: name || provider?.name || providerId,
        baseUrl,
        priority,
        enabled,
        defaultModel,
        ...(apiKey || !editing ? { apiKey } : {}),
      };
      if (editing) await api.put(`/api/connections/${editing.id}`, body);
      else await api.post('/api/connections', { ...body, providerId });
      notify.success(editing ? 'Conexão atualizada' : 'Conexão criada');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.connections }),
        queryClient.invalidateQueries({ queryKey: keys.models }),
      ]);
      onClose();
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Editar conexão' : 'Nova conexão'}
      description="Cadastre uma chave de um provider. Várias chaves do mesmo provider são revezadas e usadas como fallback."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            Salvar
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
        <Field label="Provider" htmlFor="provider">
          <Select
            id="provider"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            disabled={!!editing}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.freeTier ? ' — plano gratuito' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {provider && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted">
            <span className="flex-1">{provider.description}</span>
            {provider.freeTier && <Badge tone="success">grátis</Badge>}
            <Badge>{provider.format === 'anthropic' ? 'Anthropic API' : 'OpenAI API'}</Badge>
            {provider.keyUrl && (
              <a
                href={provider.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent-text underline"
              >
                Obter chave <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
        <Field label="Nome" htmlFor="conn-name" hint="Ex.: Groq pessoal, OpenRouter conta 2">
          <Input
            id="conn-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={provider?.name}
          />
        </Field>
        <Field
          label="API key"
          htmlFor="conn-key"
          hint={
            editing
              ? `Atual: ${editing.apiKeyPreview || '(vazia)'} — deixe em branco para manter`
              : provider?.requiresApiKey
                ? 'Obrigatória'
                : 'Opcional'
          }
        >
          <Input
            id="conn-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>
        <Field
          label="Base URL"
          htmlFor="conn-url"
          hint={
            provider?.requiresBaseUrl
              ? 'Obrigatória para este provider'
              : `Opcional — padrão: ${provider?.baseUrl ?? ''}`
          }
        >
          <Input
            id="conn-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider?.baseUrl || 'https://…'}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Prioridade"
            htmlFor="conn-priority"
            hint="Menor = usada primeiro. Iguais se revezam."
          >
            <Input
              id="conn-priority"
              type="number"
              min={0}
              max={1000}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </Field>
          <Field
            label="Modelo padrão"
            htmlFor="conn-model"
            hint="Aparece na lista de modelos do chat"
          >
            <Input
              id="conn-model"
              list="conn-model-suggestions"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              placeholder={provider?.suggestedModels[0]?.id ?? 'id-do-modelo'}
            />
            <datalist id="conn-model-suggestions">
              {provider?.suggestedModels.map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
          </Field>
        </div>
        <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2.5">
          <span className="text-sm">Conexão ativa</span>
          <Switch checked={enabled} onChange={setEnabled} label="Conexão ativa" />
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}
