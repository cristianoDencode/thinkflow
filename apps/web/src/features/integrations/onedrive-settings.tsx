import { useQueryClient } from '@tanstack/react-query';
import type { OneDriveStatusDto } from '@thinkflow/shared';
import { ArrowUp, Check, Copy, Folder, FolderOpen, Link2, Link2Off } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/card';
import { Field, Input } from '../../components/ui/form';
import { errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import {
  onedriveKey,
  startOneDriveConnect,
  useDisconnectOneDrive,
  useOneDriveFolders,
  useOneDriveStatus,
  useSaveOneDriveSettings,
  useSetOneDriveFolder,
} from './onedrive-queries';

/** Steps to register the app at Microsoft (personal accounts). Mirrored in the README. */
export const ONEDRIVE_SETUP_STEPS: readonly string[] = [
  'Entre em https://entra.microsoft.com (ou portal.azure.com) com uma conta Microsoft (pode ser a mesma do OneDrive; se pedir, aceite criar o diretório gratuito padrão). Não é preciso assinatura paga do Azure.',
  'Vá em Entra ID > Registros de aplicativo (App registrations) > Novo registro (New registration) e dê um nome, por exemplo "Thinkflow OneDrive".',
  'Em Tipos de conta com suporte (Supported account types) escolha "Somente contas Microsoft pessoais" (Personal accounts only). A opção "Qualquer diretório + contas pessoais" também funciona.',
  'Em URI de redirecionamento (Redirect URI) escolha a plataforma "Aplicativos móveis e de desktop" (Mobile and desktop applications), cole a URI mostrada acima e clique em Registrar. Não use "Aplicativo de página única (SPA)".',
  'Na página Visão geral (Overview), copie o "ID do aplicativo (cliente)" (Application (client) ID) e cole no campo acima.',
  'Em Autenticação (Authentication) > Configurações avançadas, ative "Permitir fluxos de cliente público" (Allow public client flows) = Sim e salve. Assim o aplicativo funciona sem segredo.',
  'Em Permissões de API (API permissions) confirme Microsoft Graph > Delegadas: Files.ReadWrite, offline_access e User.Read (adicione o que faltar). Não precisa de consentimento do administrador: a conta pessoal aceita ao entrar.',
  'Volte aqui, clique em Salvar e depois em Conectar; entre com a conta do OneDrive e aceite o acesso.',
];

export const ONEDRIVE_SETUP_NOTE =
  'Alternativa com segredo: registre a URI na plataforma "Web", crie um segredo em Certificados e segredos (Certificates & secrets) e cole o "Valor" no campo de segredo. A Microsoft só aceita http em localhost (a porta é ignorada na comparação); em outro endereço use HTTPS.';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-muted sm:w-36">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={value} aria-label={label} className="font-mono text-xs" />
      <Button
        variant="secondary"
        size="icon"
        aria-label={`Copiar ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            notify.error('Não foi possível copiar');
          }
        }}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

function StateBadge({ state }: { state: OneDriveStatusDto['state'] }) {
  if (state === 'connected') return <Badge tone="success">Conectado</Badge>;
  if (state === 'reconnect_required') return <Badge tone="warning">Reconectar</Badge>;
  return <Badge>Não conectado</Badge>;
}

function FolderPicker({ onClose, current }: { onClose(): void; current: string | null }) {
  const [parentId, setParentId] = useState<string | null>(null);
  const { data, isLoading, error } = useOneDriveFolders(parentId, true);
  const setFolder = useSetOneDriveFolder();

  const choose = async (id: string | null) => {
    try {
      await setFolder.mutateAsync(id);
      notify.success(id ? 'Pasta padrão definida' : 'Pasta padrão removida');
      onClose();
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-border bg-surface-2 p-3 text-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Subir uma pasta"
          disabled={!data?.parent.parentId && parentId === null}
          onClick={() =>
            setParentId(data?.parent.parentId === 'root' ? null : (data?.parent.parentId ?? null))
          }
        >
          <ArrowUp className="h-4 w-4" /> Subir
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="onedrive-path">
          {data?.parent.path ?? '/'}
        </span>
        <Button
          size="sm"
          loading={setFolder.isPending}
          disabled={!data}
          onClick={() => void choose(data?.parent.id ?? 'root')}
        >
          Usar esta pasta
        </Button>
      </div>
      {isLoading && <p className="text-muted">Carregando pastas…</p>}
      {error && <p className="text-danger">{errorMessage(error)}</p>}
      {data && data.folders.length === 0 && <p className="text-muted">Nenhuma subpasta aqui.</p>}
      <ul className="max-h-64 divide-y divide-border overflow-y-auto">
        {data?.folders.map((f) => (
          <li key={f.id}>
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-2 py-2 text-left hover:bg-surface-hover"
              onClick={() => setParentId(f.id)}
            >
              <Folder className="h-4 w-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              {f.childCount != null && <span className="text-xs text-muted">{f.childCount}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex justify-between gap-2">
        {current ? (
          <Button variant="ghost" size="sm" onClick={() => void choose(null)}>
            Remover pasta padrão
          </Button>
        ) : (
          <span />
        )}
        <Button variant="secondary" size="sm" onClick={onClose}>
          Fechar
        </Button>
      </div>
    </div>
  );
}

/** Settings of the OneDrive integration: app registration, connection, default folder, file naming. */
export function OneDriveSettings({
  navigate = (url: string) => window.location.assign(url),
}: {
  /** Sends the browser to Microsoft's sign-in (replaced in tests). */
  navigate?: (url: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useOneDriveStatus();
  const save = useSaveOneDriveSettings();
  const disconnect = useDisconnectOneDrive();

  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [pattern, setPattern] = useState('');
  const [override, setOverride] = useState('');
  const [picking, setPicking] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!data) return;
    setClientId(data.clientId);
    setPattern(data.namingPattern);
    setOverride(data.redirectUriOverride);
  }, [data]);

  // result of the Microsoft redirect: /settings?onedrive=connected | error&reason=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('onedrive');
    if (!result) return;
    if (result === 'connected') notify.success('OneDrive conectado');
    else notify.error(params.get('reason') || 'Não foi possível conectar o OneDrive');
    params.delete('onedrive');
    params.delete('reason');
    const rest = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`,
    );
    void queryClient.invalidateQueries({ queryKey: onedriveKey });
  }, [queryClient]);

  if (isLoading) return <p className="text-sm text-muted">Carregando…</p>;
  if (error || !data) return <p className="text-sm text-danger">{errorMessage(error)}</p>;

  const dirty =
    clientId.trim() !== data.clientId ||
    secret !== '' ||
    pattern.trim() !== data.namingPattern ||
    override.trim() !== data.redirectUriOverride;

  const persist = async (extra: { clearClientSecret?: boolean } = {}) => {
    await save.mutateAsync({
      clientId: clientId.trim(),
      ...(secret ? { clientSecret: secret } : {}),
      namingPattern: pattern.trim() || data.defaultNamingPattern,
      redirectUriOverride: override.trim(),
      ...extra,
    });
    setSecret('');
  };

  const onSave = async () => {
    try {
      await persist();
      notify.success('Configurações do OneDrive salvas');
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const onConnect = async () => {
    setConnecting(true);
    try {
      if (dirty) await persist();
      const { authorizeUrl } = await startOneDriveConnect();
      navigate(authorizeUrl);
    } catch (err) {
      notify.error(errorMessage(err));
      setConnecting(false);
    }
  };

  const onDisconnect = async () => {
    try {
      await disconnect.mutateAsync(undefined);
      notify.success('OneDrive desconectado');
    } catch (err) {
      notify.error(errorMessage(err));
    }
  };

  const connected = data.state === 'connected';

  return (
    <div className="space-y-5 text-sm">
      <dl className="space-y-1.5">
        <Row label="Status">
          <StateBadge state={data.state} />
          {data.state === 'reconnect_required' && (
            <span className="ml-2 text-warning">
              A autorização expirou ou foi revogada. Clique em Reconectar.
            </span>
          )}
        </Row>
        {data.account && (
          <Row label="Conta">
            {data.account.name}
            {data.account.email && data.account.email !== data.account.name && (
              <span className="text-muted"> · {data.account.email}</span>
            )}
          </Row>
        )}
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button loading={connecting} disabled={!clientId.trim()} onClick={() => void onConnect()}>
          <Link2 className="h-4 w-4" />
          {data.state === 'disconnected' ? 'Conectar' : 'Reconectar'}
        </Button>
        {data.state !== 'disconnected' && (
          <Button
            variant="secondary"
            loading={disconnect.isPending}
            onClick={() => {
              if (window.confirm('Desconectar o OneDrive? Os tokens guardados serão apagados.'))
                void onDisconnect();
            }}
          >
            <Link2Off className="h-4 w-4" /> Desconectar
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="ID do aplicativo (client ID)"
          htmlFor="od-client-id"
          hint="GUID do registro no Microsoft Entra (veja o passo a passo abaixo)."
        >
          <Input
            id="od-client-id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Segredo do cliente (opcional)"
          htmlFor="od-secret"
          hint={
            data.hasClientSecret
              ? 'Um segredo está salvo (criptografado). Digite para trocar.'
              : 'Deixe em branco com a plataforma "Aplicativos móveis e de desktop".'
          }
        >
          <div className="flex gap-2">
            <Input
              id="od-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={data.hasClientSecret ? '••••••••' : ''}
              autoComplete="new-password"
            />
            {data.hasClientSecret && (
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    await persist({ clearClientSecret: true });
                    notify.success('Segredo removido');
                  } catch (err) {
                    notify.error(errorMessage(err));
                  }
                }}
              >
                Remover
              </Button>
            )}
          </div>
        </Field>
      </div>

      <Field
        label="URI de redirecionamento (copie para o portal da Microsoft)"
        hint="Calculada a partir do endereço em que você abriu o app."
        error={data.redirectUriWarning}
      >
        <CopyField value={data.redirectUri} label="URI de redirecionamento" />
      </Field>

      <details className="rounded-xl border border-border px-3 py-2">
        <summary className="cursor-pointer text-muted">
          Avançado: informar a URI de redirecionamento manualmente
        </summary>
        <div className="mt-3">
          <Field
            label="URI manual"
            htmlFor="od-redirect-override"
            hint="Use atrás de proxy reverso ou quando o endereço público é outro. Deixe vazio para usar a URI calculada."
          >
            <Input
              id="od-redirect-override"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              placeholder="https://analista.exemplo.com/api/integrations/onedrive/callback"
            />
          </Field>
        </div>
      </details>

      <Field
        label="Nome dos arquivos"
        htmlFor="od-pattern"
        hint={
          <>
            Use <code className="font-mono">{'{ticketId}'}</code> e{' '}
            <code className="font-mono">{'{title}'}</code>. Caracteres proibidos no OneDrive (
            <code className="font-mono">{'\\ / : * ? " < > |'}</code>) viram "-". Se o nome já
            existir, o app cria "nome (2).docx"; nunca sobrescreve.
          </>
        }
      >
        <Input
          id="od-pattern"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder={data.defaultNamingPattern}
        />
      </Field>

      <div>
        <Button loading={save.isPending} disabled={!dirty} onClick={() => void onSave()}>
          Salvar
        </Button>
      </div>

      <div className="border-t border-border pt-4">
        <h3 className="font-medium">Pasta padrão</h3>
        <p className="mt-1 text-xs text-muted">
          Onde os novos documentos são criados. Sem pasta padrão, vão para a raiz do OneDrive.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span
            className="min-w-0 truncate font-mono text-xs"
            data-testid="onedrive-default-folder"
          >
            {data.defaultFolder ? data.defaultFolder.path : '/ (raiz do OneDrive)'}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={!connected}
            onClick={() => setPicking((v) => !v)}
          >
            <FolderOpen className="h-4 w-4" /> Escolher pasta
          </Button>
        </div>
        {!connected && (
          <p className="mt-1 text-xs text-muted">Conecte o OneDrive para escolher uma pasta.</p>
        )}
        {picking && connected && (
          <FolderPicker
            current={data.defaultFolder?.id ?? null}
            onClose={() => setPicking(false)}
          />
        )}
      </div>

      <details className="rounded-xl border border-border px-3 py-2">
        <summary className="cursor-pointer font-medium">
          Como registrar o aplicativo no Microsoft Entra (conta pessoal)
        </summary>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-muted">
          {ONEDRIVE_SETUP_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-muted">{ONEDRIVE_SETUP_NOTE}</p>
        <p className="mt-2 text-xs text-muted">
          Permissões pedidas: <code className="font-mono">{data.scopes.join(' ')}</code>. O app só
          cria arquivos novos; nunca altera os existentes.
        </p>
      </details>
    </div>
  );
}
